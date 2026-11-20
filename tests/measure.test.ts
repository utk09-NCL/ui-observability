import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMeasure, type MeasureSinks } from "../src/core/measure";
import { ObservabilityRuntime } from "../src/core/runtime";
import {
  configure,
  flush,
  gauge,
  getDiagnosticCounters,
  measure,
  rotateSecurityContext,
  shutdown,
  startMeasure,
} from "../src/index";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";

const SPAN = { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "c".repeat(16) };

/** Builds typed sinks that record every call. */
const sinksOf = () => ({
  metric: vi.fn<MeasureSinks["metric"]>(),
  span: vi.fn<MeasureSinks["span"]>(),
});

/** Builds a measure on a clock the test controls. */
function setupMeasure(span?: typeof SPAN) {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const clock = vi.spyOn(performance, "now").mockReturnValue(10);
  const sinks = sinksOf();
  const measure = createMeasure("checkout", { tier: "gold" }, span, sinks);
  return { measure, clock, sinks };
}

/** Returns every histogram call as its name, value and attributes. */
function points(sinks: ReturnType<typeof sinksOf>): unknown[] {
  return sinks.metric.mock.calls.map(([def, value, attributes]) => [def.name, value, attributes]);
}

describe("createMeasure", () => {
  it("records each phase and the total in milliseconds", () => {
    const { measure, clock, sinks } = setupMeasure();
    clock.mockReturnValue(15);
    measure.phase("validate");
    clock.mockReturnValue(40);
    measure.phase("payment");
    clock.mockReturnValue(100);
    measure.end();

    expect(points(sinks)).toEqual([
      [
        "ui.measure.phase.duration",
        25,
        { tier: "gold", "measure.name": "checkout", "measure.phase": "validate" },
      ],
      [
        "ui.measure.phase.duration",
        60,
        { tier: "gold", "measure.name": "checkout", "measure.phase": "payment" },
      ],
      [
        "ui.measure.duration",
        90,
        { tier: "gold", "measure.name": "checkout", "measure.outcome": "ok" },
      ],
    ]);
    expect(sinks.span).not.toHaveBeenCalled();
  });

  it("keeps library keys over an app attribute of the same name", () => {
    const sinks = sinksOf();
    createMeasure("real", { "measure.name": "fake" }, undefined, sinks).end("done");
    expect(sinks.metric.mock.calls[0][2]).toEqual({
      "measure.name": "real",
      "measure.outcome": "done",
    });
  });

  it("records only the total for a measure without phases", () => {
    const { measure, sinks } = setupMeasure();
    measure.end("cancelled");
    expect(points(sinks)).toEqual([
      [
        "ui.measure.duration",
        0,
        { tier: "gold", "measure.name": "checkout", "measure.outcome": "cancelled" },
      ],
    ]);
  });

  it("ignores each call after end()", () => {
    const { measure, sinks } = setupMeasure(SPAN);
    measure.phase("validate");
    measure.end();
    const metrics = sinks.metric.mock.calls.length;
    const spans = sinks.span.mock.calls.length;

    measure.phase("late");
    measure.end("late");

    expect(sinks.metric).toHaveBeenCalledTimes(metrics);
    expect(sinks.span).toHaveBeenCalledTimes(spans);
  });

  it("records one span and one child span for each phase", () => {
    const { measure, clock, sinks } = setupMeasure(SPAN);
    clock.mockReturnValue(20);
    measure.phase("validate");
    clock.mockReturnValue(50);
    measure.end();

    const [child, parent] = sinks.span.mock.calls.map(([span]) => span);
    expect(child).toMatchObject({
      name: "validate",
      kind: "internal",
      traceId: SPAN.traceId,
      parentSpanId: SPAN.spanId,
      startMs: 1010,
      endMs: 1040,
      error: false,
      attributes: { "measure.name": "checkout" },
    });
    expect(child.spanId).toMatch(/^[\da-f]{16}$/);
    expect(child.spanId).not.toBe(SPAN.spanId);
    expect(parent).toEqual({
      ...SPAN,
      name: "checkout",
      kind: "internal",
      startMs: 1000,
      endMs: 1040,
      error: false,
      attributes: { tier: "gold", "measure.outcome": "ok" },
    });
  });

  it("marks the measure span and its open phase as failed for the error outcome", () => {
    const { measure, sinks } = setupMeasure(SPAN);
    measure.phase("validate");
    measure.phase("payment");
    measure.end("error");

    expect(sinks.span.mock.calls.map(([span]) => [span.name, span.error])).toEqual([
      ["validate", false],
      ["payment", true],
      ["checkout", true],
    ]);
  });
});

describe("startMeasure in the runtime", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
  });

  async function setup(over: ObservabilityConfig = {}) {
    configure({
      endpoint: "https://x.example/v1/logs",
      tracesEndpoint: "https://x.example/v1/traces",
      serviceName: "svc",
      bus: { mode: "off" },
      storage: { backend: "memory" },
      identity: "memory",
      compression: "none",
      capture: { errors: false, rejections: false },
      ...over,
    });
    await flush();
    const runtime = ObservabilityRuntime.current()!;
    return {
      runtime,
      emit: vi.spyOn(runtime, "emit"),
      metric: vi.spyOn(runtime, "recordMetric"),
    };
  }

  const spansOf = (emit: { mock: { calls: [LogRecord | null][] } }): LogRecord[] =>
    emit.mock.calls
      .map(([record]) => record)
      .filter((record): record is LogRecord => record?.attributes["log.type"] === "span");

  it("links the spans of a measure to the ambient trace", async () => {
    const { runtime, emit, metric } = await setup();
    const ambient = runtime.tracing.resolve();
    const measure = startMeasure("checkout", { tier: "gold" });
    measure.phase("payment");
    measure.end();

    const [child, parent] = spansOf(emit);
    expect(child.body).toBe("payment");
    expect(child.traceId).toBe(ambient.traceId);
    expect(child.attributes["span.parent_id"]).toBe(parent.spanId);
    expect(parent.body).toBe("checkout");
    expect(parent.traceId).toBe(ambient.traceId);
    expect(parent.attributes["span.parent_id"]).toBe(ambient.spanId);
    expect(parent.attributes.tier).toBe("gold");
    expect(metric).toHaveBeenCalledTimes(2);
  });

  it("sends the spans as OTLP to tracesEndpoint when the logs use a custom serializer", async () => {
    const sent = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", sent);
    const serialize = vi.fn((records: LogRecord[]) => ({
      body: JSON.stringify({ logs: records.map((record) => record.body) }),
      contentType: "application/json",
    }));
    await setup({ serializer: { name: "uilogs", serialize } });

    startMeasure("checkout").end();
    await flush();

    const call = sent.mock.calls.find(([url]) => url === "https://x.example/v1/traces");
    const body = JSON.parse(call?.[1].body as string) as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
    };
    const names = body.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
    );
    expect(names).toContain("checkout");
    const seen = serialize.mock.calls.flatMap(([records]) => records);
    expect(seen.some((record) => record.attributes["log.type"] === "span")).toBe(false);
  });

  it.each([
    ["no tracesEndpoint", { tracesEndpoint: "" }],
    ["a dropped trace", { sampling: { defaultRate: 0 } }],
  ])("records histograms and no span with %s", async (_label, over) => {
    const { emit, metric } = await setup(over);
    startMeasure("checkout").end();
    expect(spansOf(emit)).toEqual([]);
    expect(metric).toHaveBeenCalledOnce();
  });

  it("copies the attributes at the start", async () => {
    const { metric } = await setup();
    const attributes = { tier: "gold" };
    const measure = startMeasure("checkout", attributes);
    attributes.tier = "changed";
    measure.end();
    expect(metric.mock.calls[0][2]).toMatchObject({ tier: "gold" });
  });

  it("contains an attribute that throws", async () => {
    const { metric } = await setup();
    const attributes = {
      get tier(): string {
        throw new Error("getter");
      },
    };
    startMeasure("checkout", attributes).end();
    expect(metric.mock.calls[0][2]).toEqual({
      "measure.name": "checkout",
      "measure.outcome": "ok",
    });
    expect(getDiagnosticCounters()["record.sanitize_failed"]).toBe(1);
  });

  it("drops a measure that ends after shutdown", async () => {
    const { emit, metric } = await setup();
    const measure = startMeasure("checkout");
    await shutdown();
    emit.mockClear();
    measure.end();
    expect(metric).not.toHaveBeenCalled();
    expect(spansOf(emit)).toEqual([]);
  });

  it("drops a measure of the old identity after a rotation", async () => {
    const { emit, metric } = await setup({ securityContext: { id: "old" } });
    const measure = startMeasure("checkout");
    await rotateSecurityContext({
      id: "new",
      routing: {
        endpoint: "https://y.example/v1/logs",
        tracesEndpoint: "https://y.example/v1/traces",
      },
    });
    emit.mockClear();
    measure.end();
    expect(metric).not.toHaveBeenCalled();
    expect(spansOf(emit)).toEqual([]);
  });

  it("keeps a measure across the first explicit id", async () => {
    const measure = startMeasure("boot");
    const { metric } = await setup({ securityContext: { id: "tenant" } });
    measure.end();
    expect(metric).toHaveBeenCalledOnce();
  });

  it("keeps a measure across the first owner id and drops it at a later owner id", async () => {
    const { runtime, metric } = await setup();
    const adopt = (await runtime["constructBus"]())!["handlers"].onSecurityContext!;
    const first = startMeasure("first");
    adopt("owner-A");
    first.end();
    expect(metric).toHaveBeenCalledOnce();

    const second = startMeasure("second");
    adopt("owner-B");
    second.end();
    expect(metric).toHaveBeenCalledOnce();
  });

  it("converts a name that is not a string", async () => {
    const { emit, metric } = await setup();
    const measure = startMeasure(1 as unknown as string);
    measure.phase(2 as unknown as string);
    measure.end();
    expect(spansOf(emit).map((span) => span.body)).toEqual(["2", "1"]);
    expect(metric).toHaveBeenCalledTimes(2);
  });

  it("keeps a measure across an identity change with isolation off", async () => {
    const { runtime, metric } = await setup({ securityContext: { isolation: false } });
    const measure = startMeasure("checkout");
    runtime.config.securityContext.id = "changed";
    measure.end();
    expect(metric).toHaveBeenCalledOnce();
  });
});

describe("measure() and gauge() in the runtime", () => {
  async function setup() {
    configure({
      endpoint: null,
      serviceName: "svc",
      bus: { mode: "off" },
      storage: { backend: "memory" },
      identity: "memory",
      capture: { errors: false, rejections: false },
    });
    await flush();
    const runtime = ObservabilityRuntime.current()!;
    return { metric: vi.spyOn(runtime, "recordMetric") };
  }

  /** Returns the outcome of each total point. */
  const outcomes = (metric: Awaited<ReturnType<typeof setup>>["metric"]): unknown[] =>
    metric.mock.calls
      .filter(([def]) => def.name === "ui.measure.duration")
      .map(([, , attributes]) => attributes?.["measure.outcome"]);

  it("returns the result of a synchronous call and ends the measure with ok", async () => {
    const { metric } = await setup();

    expect(measure("calc", () => 42, { tier: "gold" })).toBe(42);

    expect(outcomes(metric)).toEqual(["ok"]);
    expect(metric.mock.calls[0][2]).toMatchObject({ tier: "gold", "measure.name": "calc" });
  });

  it("ends the measure with error and throws the app's error again", async () => {
    const { metric } = await setup();
    const failure = new Error("calc failed");

    expect(() =>
      measure("calc", () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(outcomes(metric)).toEqual(["error"]);
  });

  it("ends the measure when a promise settles, and hands back its value or its rejection", async () => {
    const { metric } = await setup();
    let release!: (value: string) => void;
    const pending = measure(
      "load",
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    expect(outcomes(metric)).toEqual([]);
    release("rows");
    await expect(pending).resolves.toBe("rows");

    const failure = new Error("load failed");
    await expect(measure("load", () => Promise.reject(failure))).rejects.toBe(failure);
    expect(outcomes(metric)).toEqual(["ok", "error"]);
  });

  it("ends the measure with error when the result's then() throws, and throws that error", async () => {
    const { metric } = await setup();
    const failure = new Error("then failed");
    const thenable = {
      then: (): never => {
        throw failure;
      },
    };

    expect(() => measure("calc", () => thenable)).toThrow(failure);
    expect(outcomes(metric)).toEqual(["error"]);
  });

  it("ends the measure at once for a result whose then getter throws", async () => {
    const { metric } = await setup();
    const hostile = {
      get then(): never {
        throw new Error("getter");
      },
    };

    expect(measure("calc", () => hostile)).toBe(hostile);
    expect(outcomes(metric)).toEqual(["ok"]);
    expect(getDiagnosticCounters()["record.sanitize_failed"]).toBe(1);
  });

  it("records nothing after shutdown(), but still runs the function and gives a handle", async () => {
    await setup();
    const runtime = ObservabilityRuntime.current()!;
    const record = vi.spyOn(runtime["meter"], "record");
    await shutdown();

    expect(measure("calc", () => 5)).toBe(5);
    gauge("queue.depth").set(3);

    expect(record).not.toHaveBeenCalled();
  });

  it.each(["otlp", "ecs"] as const)(
    "sends a gauge's last value as an OTLP point to metricsEndpoint with %s logs",
    async (serializer) => {
      const sent = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(new Response(null, { status: 204 })),
      );
      vi.stubGlobal("fetch", sent);
      configure({
        endpoint: "https://x.example/v1/logs",
        metricsEndpoint: "https://x.example/v1/metrics",
        serializer,
        serviceName: "svc",
        bus: { mode: "off" },
        storage: { backend: "memory" },
        identity: "memory",
        compression: "none",
        capture: { errors: false, rejections: false },
      });
      await flush();
      const depth = gauge("queue.depth", { unit: "1" });

      depth.set(4, { desk: "fx" });
      depth.set(9, { desk: "fx" });
      await flush();

      const call = sent.mock.calls.find(([url]) => url === "https://x.example/v1/metrics");
      const body = JSON.parse(call?.[1].body as string) as {
        resourceMetrics: { scopeMetrics: { metrics: Record<string, unknown>[] }[] }[];
      };
      const [metric] = body.resourceMetrics[0].scopeMetrics[0].metrics;
      expect(metric).toMatchObject({
        name: "queue.depth",
        unit: "1",
        gauge: { dataPoints: [expect.objectContaining({ asDouble: 9 })] },
      });
    },
  );

  it("sets a gauge's value and reports options it can't read", async () => {
    const { metric } = await setup();
    const options = {
      get unit(): string {
        throw new Error("getter");
      },
    };

    gauge("queue.depth", { unit: "1" }).set(7, { desk: "fx" });
    gauge("queue.size", options).set(1);
    gauge("queue.rows").set(2);

    expect(metric.mock.calls.map(([def, value]) => [def.kind, def.unit, value])).toEqual([
      ["gauge", "1", 7],
      ["gauge", "count", 1],
      ["gauge", "count", 2],
    ]);
    expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMeasure, type MeasureSinks } from "../src/core/measure";
import { ObservabilityRuntime } from "../src/core/runtime";
import {
  configure,
  flush,
  getDiagnosticCounters,
  rotateSecurityContext,
  shutdown,
  startMeasure,
} from "../src/index";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";

const SPAN = { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "c".repeat(16) };

/** Builds typed sinks that record each call. */
const sinksOf = () => ({
  metric: vi.fn<MeasureSinks["metric"]>(),
  span: vi.fn<MeasureSinks["span"]>(),
});

/** Builds a measure on a clock that the test sets. */
function setupMeasure(span?: typeof SPAN) {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const clock = vi.spyOn(performance, "now").mockReturnValue(10);
  const sinks = sinksOf();
  const measure = createMeasure("checkout", { tier: "gold" }, span, sinks);
  return { measure, clock, sinks };
}

/** Gives each histogram call as its name, value and attributes. */
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
      storage: "memory",
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
      delivery: {
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

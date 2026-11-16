// tests/profiler-runtime.test.ts
//
// Tests for how the profiler core is wired up through the public API. A memory transport
// collects the records, and a stubbed clock makes every duration exact.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TELEMETRY_SDK_VERSION } from "../src/constants";
import type { DiagnosticEvent } from "../src/core/diagnostics";
import { ProfilerCore } from "../src/core/profiler";
import { ObservabilityRuntime } from "../src/core/runtime";
import { Sender } from "../src/core/sender";
import {
  configure,
  createMemoryTransport,
  flush,
  getDiagnosticCounters,
  getHealth,
  getLogger,
  newSession,
  profiler,
  rotateSecurityContext,
  shutdown,
} from "../src/index";
import type { ObservabilityConfig, Transport, TransportRequest } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import type { Probe } from "../src/models/metric";
import { ecsSerializer } from "../src/transport/serializers/ecs";

/** Global symbol for this library version's profiler core. */
const CORE_KEY = Symbol.for(`ui-observability.profiler@${TELEMETRY_SDK_VERSION}`);

/** Global symbol for the runtime. */
const RUNTIME_KEY = Symbol.for("ui-observability.runtime");

/** Name of the profiler's summary record. */
const PROFILE = "ui.profile.duration";

/** The overhead attribute. Only a timer collect produces it. */
const OVERHEAD = "profile.overhead_ns";

/** Settings for a runtime with no network and no captures. */
const base = {
  endpoint: null,
  serviceName: "svc",
  storage: "memory",
  identity: "memory",
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
  diagnostics: { throttleMs: 0 },
} as const;

/** The parts of an OTLP metrics body the tests look at. */
interface OtlpMetrics {
  resourceMetrics: {
    scopeMetrics: {
      metrics: {
        name: string;
        unit: string;
        histogram: {
          dataPoints: {
            attributes: unknown[];
            count: string;
            sum: number;
            min: number;
            max: number;
            bucketCounts: string[];
            explicitBounds: number[];
          }[];
        };
      }[];
    }[];
  }[];
}

/** A clock the test sets by hand. */
interface Clock {
  /** What the next read returns, in ms. */
  now: number;
  /** How much each read adds afterwards. */
  step: number;
}

/**
 * Replaces performance.now with a clock the test sets by hand.
 * @returns The clock and the spy on performance.now.
 */
function stubClock() {
  const clock: Clock = { now: 100, step: 0 };
  const read = vi.spyOn(performance, "now").mockImplementation(() => {
    const value = clock.now;
    clock.now += clock.step;
    return value;
  });
  return { clock, read };
}

/**
 * Measures one span of a known length.
 * @param probe The probe to use.
 * @param clock The test's clock.
 * @param ms Span length in ms.
 */
function span(probe: Probe, clock: Clock, ms: number): void {
  const token = probe.begin();
  clock.now += ms;
  probe.end(token);
}

/** Fakes the timers. The profiler's clock stays under the test's own stub. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/**
 * Creates a promise the test resolves by hand.
 * @returns The promise and the function that opens it.
 */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Starts a runtime with a memory transport.
 * @param over Settings that override the base settings.
 * @returns The transport and the diagnostic events.
 */
async function start(over: ObservabilityConfig = {}) {
  const memory = createMemoryTransport();
  const events: DiagnosticEvent[] = [];
  configure({
    ...base,
    transport: memory.transport,
    onDiagnostic: (event) => {
      events.push(event);
    },
    ...over,
  });
  await flush();
  return { memory, events };
}

/**
 * Picks the profile records out of a list.
 * @param records Records from a transport.
 * @returns The profile summary records.
 */
function profiles(records: readonly LogRecord[]): LogRecord[] {
  return records.filter((record) => record.attributes["metric.name"] === PROFILE);
}

/**
 * Picks the invalid-configuration events out of a list.
 * @param events Diagnostic events.
 * @returns The events with the code config.invalid.
 */
function invalid(events: readonly DiagnosticEvent[]): DiagnosticEvent[] {
  return events.filter((event) => event.code === "config.invalid");
}

/**
 * Picks the profile records out of what an emit spy saw.
 * @param emit Spy on the runtime's emit method.
 * @returns The profile summary records.
 */
function emitted(emit: { mock: { calls: [LogRecord | null][] } }): LogRecord[] {
  return profiles(emit.mock.calls.flatMap(([record]) => (record ? [record] : [])));
}

/**
 * Returns the test's runtime.
 * @returns The runtime.
 */
function runtime(): ObservabilityRuntime {
  return ObservabilityRuntime.current()!;
}

/**
 * Checks whether the profiler core's global symbol exists.
 * @returns True if there is a core.
 */
function hasCore(): boolean {
  return CORE_KEY in globalThis;
}

beforeEach(() => {
  // Don't let a core left over from an earlier test decide what this one sees.
  Reflect.deleteProperty(globalThis, CORE_KEY);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await shutdown();
  const core = (globalThis as Record<symbol, ProfilerCore | undefined>)[CORE_KEY];
  core?.detach();
  Reflect.deleteProperty(globalThis, CORE_KEY);
});

describe("profiler.probe", () => {
  it("returns the same probe for the same name", () => {
    expect(profiler.probe("grid.render")).toBe(profiler.probe("grid.render"));
  });

  it("returns a different probe for a different name", () => {
    expect(profiler.probe("grid.paint")).not.toBe(profiler.probe("grid.render"));
  });

  it("starts no runtime for a probe made before configure()", () => {
    profiler.probe("early");

    expect(ObservabilityRuntime.current()).toBeNull();
  });

  it("reads no clock for a probe made before configure()", () => {
    const { read } = stubClock();

    expect(profiler.probe("early").begin()).toBe(-1);
    expect(read).not.toHaveBeenCalled();
  });

  it("measures with the same probe after configure()", async () => {
    const { clock } = stubClock();
    const probe = profiler.probe("early");

    const { memory } = await start({ profiler: { enabled: true } });
    span(probe, clock, 5);
    await flush();

    expect(profiles(memory.records()).map((one) => one.attributes["metric.sum"])).toEqual([5]);
  });
});

describe("probe reports", () => {
  it("reports a bad probe to the handler of the runtime that starts after a shutdown", async () => {
    const first = await start({ profiler: { enabled: true } });
    await shutdown();
    const second = await start();

    profiler.probe("");
    profiler.probe("x", { sampleEvery: 0 });

    expect(invalid(second.events).map((event) => event.message)).toEqual([
      expect.stringContaining("probe name must be a string"),
      expect.stringContaining("sampleEvery option of the probe x"),
    ]);
    expect(invalid(first.events)).toEqual([]);
  });

  it("reports a bad probe to the handler of the runtime while the profiler is off", async () => {
    const { events } = await start();

    profiler.probe("y", { sampleEvery: 0 });

    expect(invalid(events).map((event) => event.message)).toEqual([
      expect.stringContaining("sampleEvery option of the probe y"),
    ]);
  });

  it("reports a bad probe to no handler after shutdown()", async () => {
    const { events } = await start({ profiler: { enabled: true } });
    await shutdown();

    expect(() => profiler.probe("")).not.toThrow();

    expect(invalid(events)).toEqual([]);
  });

  it("reports a bad probe to no handler before the first configure()", async () => {
    expect(() => profiler.probe("")).not.toThrow();
    expect(ObservabilityRuntime.current()).toBeNull();

    const { events } = await start();

    expect(invalid(events)).toEqual([]);
  });
});

describe("profile record", () => {
  it("sends one histogram record for each probe with spans", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    const grid = profiler.probe("grid.render");

    for (const ms of [2, 4, 10]) {
      span(grid, clock, ms);
    }
    await flush();

    const [record, ...others] = profiles(memory.records());
    expect(others).toEqual([]);
    expect(record.attributes).toMatchObject({
      "log.type": "metric",
      "app.namespace": "uiobs.metrics",
      "profile.probe": "grid.render",
      "profile.sample_every": 1,
      "profile.p50": 4.095,
      "profile.p90": 10,
      "profile.p99": 10,
      "metric.name": PROFILE,
      "metric.unit": "ms",
      "metric.type": "histogram",
      "metric.count": 3,
      "metric.sum": 16,
      "metric.min": 2,
      "metric.max": 10,
      "metric.attribute_keys": ["profile.probe", "profile.sample_every"],
    });
    expect(record.attributes["metric.start_time_unix_nano"]).toMatch(/^\d+000000$/);

    const bounds = record.attributes["metric.bounds"] as number[];
    const counts = record.attributes["metric.bucket_counts"] as number[];
    expect(bounds.length).toBeGreaterThan(0);
    expect(counts).toHaveLength(bounds.length + 1);
    expect(counts.reduce((sum, one) => sum + one, 0)).toBe(3);
  });

  it("sends no record for a probe that has no span", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    profiler.probe("idle");
    span(profiler.probe("busy"), clock, 3);
    await flush();

    expect(profiles(memory.records()).map((record) => record.attributes["profile.probe"])).toEqual([
      "busy",
    ]);
  });

  it("passes the profile record to a processor", async () => {
    const seen: Record<string, unknown>[] = [];
    const { memory } = await start({
      profiler: { enabled: true },
      processors: [
        (record) => {
          if (record.attributes["log.type"] === "metric") {
            seen.push({ ...record.attributes });
          }
          return { ...record, attributes: { ...record.attributes, "profile.tag": "seen" } };
        },
      ],
    });
    const { clock } = stubClock();
    span(profiler.probe("grid.render"), clock, 3);
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ "profile.probe": "grid.render", "profile.sample_every": 1 });
    expect(profiles(memory.records())[0].attributes).toMatchObject({
      "profile.tag": "seen",
      "metric.count": 1,
    });
  });

  describe("with a redact hook that changes the record", () => {
    /**
     * Sends one profile record through a redact hook that changes three attributes.
     * @returns The attributes of the record the transport received.
     */
    async function redacted(): Promise<Record<string, unknown>> {
      const { memory } = await start({
        profiler: { enabled: true },
        redact: (record) =>
          record.attributes["log.type"] === "metric"
            ? {
                ...record,
                attributes: {
                  ...record.attributes,
                  "profile.probe": "[redacted]",
                  "metric.count": 999,
                  "metric.name": "other.name",
                },
              }
            : record,
      });
      const { clock } = stubClock();
      span(profiler.probe("customer.7"), clock, 3);
      await flush();
      return profiles(memory.records())[0].attributes;
    }

    it("lets redact change profile.probe", async () => {
      expect((await redacted())["profile.probe"]).toBe("[redacted]");
    });

    it("keeps each metric field that redact changes", async () => {
      expect(await redacted()).toMatchObject({ "metric.count": 1, "metric.name": PROFILE });
    });
  });

  it("sends a histogram data point to metricsEndpoint", async () => {
    const { memory } = await start({
      profiler: { enabled: true },
      serializer: "otlp",
      metricsEndpoint: "https://x.example/v1/metrics",
    });
    const { clock } = stubClock();
    const grid = profiler.probe("grid.render");

    for (const ms of [2, 4, 10]) {
      span(grid, clock, ms);
    }
    await flush();

    const request = memory.batches().find((one) => one.kind === "metrics")!;
    const body = JSON.parse(request.body) as OtlpMetrics;
    const [metric, ...others] = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const [point] = metric.histogram.dataPoints;
    expect(others).toEqual([]);
    expect(metric).toMatchObject({ name: PROFILE, unit: "ms" });
    expect(point.attributes).toEqual([
      { key: "profile.probe", value: { stringValue: "grid.render" } },
      { key: "profile.sample_every", value: { intValue: "1" } },
    ]);
    expect(point).toMatchObject({ count: "3", sum: 16, min: 2, max: 10 });
    expect(point.bucketCounts.every((one) => typeof one === "string")).toBe(true);
    expect(point.explicitBounds.every((one) => typeof one === "number")).toBe(true);
    expect(point.bucketCounts).toHaveLength(point.explicitBounds.length + 1);
  });

  it("serializes the record with the ECS serializer", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    for (const ms of [2, 4, 10]) {
      span(profiler.probe("grid.render"), clock, ms);
    }
    await flush();

    const records = profiles(memory.records());
    expect(() => ecsSerializer.serialize(records)).not.toThrow();
    const ecs = JSON.parse(ecsSerializer.serialize(records).body) as {
      event: { kind: string };
      labels: Record<string, unknown>;
    };
    expect(ecs.event.kind).toBe("metric");
    expect(ecs.labels).toMatchObject({
      "profile.probe": "grid.render",
      "profile.p50": 4.095,
      "profile.p99": 10,
    });
  });
});

describe("profiler off", () => {
  it("sends no record while the profiler is off", async () => {
    const { memory } = await start();
    const probe = profiler.probe("off");

    probe.end(probe.begin());
    probe.record(5);
    await flush();

    expect(profiles(memory.records())).toEqual([]);
  });

  it("reads no clock while the profiler is off", async () => {
    await start();
    const { read } = stubClock();
    const probe = profiler.probe("off");

    const token = probe.begin();
    probe.end(token);
    probe.record(5);

    expect(token).toBe(-1);
    expect(read).not.toHaveBeenCalled();
  });

  it("creates no global symbol while the profiler is off", async () => {
    await start();
    getLogger("app").info("log call");
    await flush();
    await shutdown();

    expect(hasCore()).toBe(false);
  });

  it("creates the global symbol at the first probe", () => {
    expect(hasCore()).toBe(false);

    profiler.probe("late");

    expect(hasCore()).toBe(true);
  });

  it("creates the global symbol when the profiler turns on", async () => {
    await start();
    expect(hasCore()).toBe(false);

    configure({ profiler: { enabled: true } });

    expect(hasCore()).toBe(true);
  });
});

describe("configure() and the profiler", () => {
  it("keeps the sampling countdown on a second configure() with the profiler on", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    const probe = profiler.probe("sampled", { sampleEvery: 3 });
    span(probe, clock, 2);

    configure({});

    expect([probe.begin(), probe.begin()]).toEqual([-1, -1]);
    span(probe, clock, 4);
    await flush();
    expect(profiles(memory.records())[0].attributes).toMatchObject({
      "profile.sample_every": 3,
      "metric.count": 2,
      "metric.sum": 6,
    });
  });

  it("sends the waiting points when the profiler turns off", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    span(profiler.probe("toggle"), clock, 6);

    configure({ profiler: { enabled: false } });
    await flush();

    expect(profiles(memory.records()).map((one) => one.attributes["metric.count"])).toEqual([1]);
  });

  it("reads no clock after the profiler turns off", async () => {
    await start({ profiler: { enabled: true } });
    const { read } = stubClock();
    const probe = profiler.probe("toggle");
    configure({ profiler: { enabled: false } });
    read.mockClear();

    expect(probe.begin()).toBe(-1);
    expect(read).not.toHaveBeenCalled();
  });

  it("measures again with the same probe when the profiler turns on", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    const probe = profiler.probe("toggle");
    span(probe, clock, 6);
    configure({ profiler: { enabled: false } });
    await flush();
    memory.clear();

    configure({ profiler: { enabled: true } });
    // The span has to begin after the detach's clock value.
    clock.now += 1;
    span(probe, clock, 8);
    await flush();

    expect(profiles(memory.records())[0].attributes).toMatchObject({
      "metric.count": 1,
      "metric.sum": 8,
    });
  });
});

describe("clock tick of a profiler restart", () => {
  it("drops a span that begins in the clock tick of a restart and measures a span in the next tick", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    const probe = profiler.probe("restart");

    // The clock doesn't move between switching on and the span, so the span starts at the floor.
    configure({ profiler: { enabled: false } });
    configure({ profiler: { enabled: true } });
    span(probe, clock, 3);
    await flush();

    expect(profiles(memory.records())).toEqual([]);

    configure({ profiler: { enabled: false } });
    configure({ profiler: { enabled: true } });
    clock.now += 1;
    span(probe, clock, 3);
    await flush();

    expect(profiles(memory.records()).map((one) => one.attributes["metric.sum"])).toEqual([3]);
  });
});

describe("interval timer", () => {
  it("sends a record after the interval without a flush() call", async () => {
    await start({ profiler: { enabled: true, flushIntervalMs: 1000 } });
    const { clock } = stubClock();
    const emit = vi.spyOn(runtime(), "emit");
    fakeTimers();

    span(profiler.probe("tick"), clock, 3);
    await vi.advanceTimersByTimeAsync(999);
    expect(emitted(emit)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted(emit).map((one) => one.attributes["metric.count"])).toEqual([1]);
  });

  it("applies a new flushIntervalMs to the next interval", async () => {
    await start({ profiler: { enabled: true, flushIntervalMs: 1000 } });
    const { clock } = stubClock();
    const emit = vi.spyOn(runtime(), "emit");
    fakeTimers();
    const probe = profiler.probe("tick");
    span(probe, clock, 3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted(emit)).toHaveLength(1);

    configure({ profiler: { flushIntervalMs: 5000 } });
    span(probe, clock, 3);
    await vi.advanceTimersByTimeAsync(4999);
    expect(emitted(emit)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted(emit)).toHaveLength(2);
  });

  it("reports the overhead value in a timer collect", async () => {
    await start({ profiler: { enabled: true, flushIntervalMs: 1000 } });
    const { clock } = stubClock();
    const emit = vi.spyOn(runtime(), "emit");
    fakeTimers();

    // A clock that ticks on every read produces a value. The collect sites below produce none.
    span(profiler.probe("tick"), clock, 3);
    clock.step = 0.01;
    await vi.advanceTimersByTimeAsync(1000);

    const [timed] = emitted(emit);
    expect(Number.isInteger(timed.attributes[OVERHEAD])).toBe(true);
    expect(timed.attributes[OVERHEAD] as number).toBeGreaterThan(0);
  });

  it("keeps a point for the new destination when the timer fires during a rotation", async () => {
    const next = createMemoryTransport();
    await start({ profiler: { enabled: true, flushIntervalMs: 1000 } });
    const { clock } = stubClock();
    const probe = profiler.probe("rotating");
    const emit = vi.spyOn(runtime(), "emit");
    const create = Sender.create.bind(Sender);
    const hold = gate();
    const reached = gate();
    // The new sender loads late, which keeps the runtime in the rotation state.
    vi.spyOn(Sender, "create").mockImplementation(async (deps) => {
      reached.open();
      await hold.promise;
      return create(deps);
    });
    fakeTimers();

    const rotation = rotateSecurityContext({ id: "new", delivery: { transport: next.transport } });
    await reached.promise;
    expect((await getHealth()).status).toBe("rotating");

    // The span has to begin after the clock value of the rotation's reset.
    clock.now += 1;
    span(probe, clock, 6);
    const timers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted(emit)).toEqual([]);
    expect(vi.getTimerCount()).toBe(timers);

    hold.open();
    await rotation;
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted(emit)).toHaveLength(1);

    vi.useRealTimers();
    await flush();
    expect(profiles(next.records())[0].attributes).toMatchObject({
      "metric.count": 1,
      "metric.sum": 6,
    });
  });

  // newSession() collects while the rotation flag is set, so the core keeps the point. The
  // timer then sends it to the new destination once the rotation is done.
  it("sends a span that ends while the old sender stops to the new destination", async () => {
    const old = gate();
    const reached = gate();
    const next = createMemoryTransport();
    const slow: Transport = async () => {
      reached.open();
      await old.promise;
      return { status: 200 };
    };
    await start({
      transport: slow,
      securityContext: { id: "old", isolation: false },
      profiler: { enabled: true, flushIntervalMs: 1000 },
    });
    const { clock } = stubClock();
    const probe = profiler.probe("held");
    fakeTimers();
    span(probe, clock, 3);

    const rotation = rotateSecurityContext(
      { id: "new", delivery: { transport: next.transport } },
      { pending: "flush" },
    );
    await reached.promise;
    span(probe, clock, 7);
    await vi.advanceTimersByTimeAsync(1000);
    old.open();
    await rotation;
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await flush();

    expect(profiles(next.records()).map((one) => one.attributes["metric.sum"])).toEqual([7]);
  });
});

describe("profiler.maxProbes", () => {
  it("reports config.invalid for a later change of maxProbes", async () => {
    const { events } = await start({ profiler: { enabled: true, maxProbes: 2 } });
    events.length = 0;

    configure({ profiler: { maxProbes: 8 } });

    expect(invalid(events)).toHaveLength(1);
    expect(invalid(events)[0]).toMatchObject({
      code: "config.invalid",
      message: "profiler.maxProbes cannot change after startup. It stays 2.",
      detail: { requested: 8 },
    });
  });

  it("keeps the capacity after a later change of maxProbes", async () => {
    await start({ profiler: { enabled: true, maxProbes: 2 } });
    const { clock } = stubClock();
    const [one, two, three] = ["a", "b", "c"].map((name) => profiler.probe(name));

    configure({ profiler: { maxProbes: 8 } });

    expect(runtime().config.profiler.maxProbes).toBe(2);
    span(two, clock, 3);
    expect(one.begin()).toBeGreaterThanOrEqual(0);
    expect(three.begin()).toBe(-1);
    expect(profiler.probe("d").begin()).toBe(-1);
  });

  it("reports nothing for the same maxProbes value", async () => {
    const { events } = await start({ profiler: { enabled: true, maxProbes: 2 } });
    events.length = 0;

    configure({ profiler: { maxProbes: 2 } });
    configure({ profiler: { flushIntervalMs: 2000 } });

    expect(invalid(events)).toEqual([]);
    expect(getDiagnosticCounters()["config.invalid"]).toBeUndefined();
  });

  it("sets the capacity at the first configure() after an implicit start", async () => {
    getLogger("early").info("before configure");
    const memory = createMemoryTransport();
    const events: DiagnosticEvent[] = [];
    const { clock } = stubClock();

    configure({
      endpoint: null,
      serviceName: "svc",
      bus: { mode: "off" },
      capture: { errors: false, rejections: false },
      diagnostics: { throttleMs: 0 },
      transport: memory.transport,
      onDiagnostic: (event) => {
        events.push(event);
      },
      profiler: { enabled: true, maxProbes: 2 },
    });
    await flush();

    expect(invalid(events)).toEqual([]);
    expect(runtime().config.profiler.maxProbes).toBe(2);
    const [one, two, three] = ["a", "b", "c"].map((name) => profiler.probe(name));
    span(one, clock, 3);
    span(two, clock, 3);

    expect(three.begin()).toBe(-1);
    expect(invalid(events)).toHaveLength(1);
    expect(invalid(events)[0].message).toContain("limit of 2");
  });
});

describe("limit report at a collect", () => {
  it("reports the limit at the next collect when another config.invalid event hides the attach report", async () => {
    const events: DiagnosticEvent[] = [];
    // This test keeps the default diagnostics.throttleMs, so a second event with the same code
    // gets dropped.
    configure({
      endpoint: null,
      serviceName: "svc",
      storage: "memory",
      identity: "memory",
      bus: { mode: "off" },
      capture: { errors: false, rejections: false },
      transport: createMemoryTransport().transport,
      onDiagnostic: (event) => {
        events.push(event);
      },
      profiler: { maxProbes: 2 },
    });
    await flush();
    for (const name of ["a", "b", "c"]) {
      profiler.probe(name);
    }
    vi.useFakeTimers({ toFake: ["Date"] });

    // Changing maxProbes reports config.invalid, and the attach report follows in the same window.
    configure({ profiler: { enabled: true, maxProbes: 8 } });

    expect(invalid(events).map((event) => event.message)).toEqual([
      "profiler.maxProbes cannot change after startup. It stays 2.",
    ]);
    expect(getDiagnosticCounters()["config.invalid"]).toBe(2);

    vi.setSystemTime(Date.now() + 1100);
    await flush();

    const limit = () =>
      invalid(events)
        .map((event) => event.message)
        .filter((message) => message.includes("probes above the limit do nothing"));
    expect(limit()).toEqual([
      "The app registered 3 probes. The profiler.maxProbes limit is 2. The probes above the limit do nothing.",
    ]);

    // The report comes once per attach.
    vi.setSystemTime(Date.now() + 1100);
    await flush();

    expect(limit()).toHaveLength(1);
  });
  it("keeps the throttle window free for a later config.invalid event after the first limit report arrived", async () => {
    const events: DiagnosticEvent[] = [];
    // This test keeps the default diagnostics.throttleMs. The limit report arrives first.
    configure({
      endpoint: null,
      serviceName: "svc",
      storage: "memory",
      identity: "memory",
      bus: { mode: "off" },
      capture: { errors: false, rejections: false },
      transport: createMemoryTransport().transport,
      onDiagnostic: (event) => {
        events.push(event);
      },
      profiler: { maxProbes: 2 },
    });
    await flush();
    for (const name of ["a", "b", "c"]) {
      profiler.probe(name);
    }
    vi.useFakeTimers({ toFake: ["Date"] });

    configure({ profiler: { enabled: true } });
    const limit = () =>
      invalid(events)
        .map((event) => event.message)
        .filter((message) => message.includes("probes above the limit do nothing"));
    expect(limit()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1500);
    await flush();
    configure({ profiler: { flushIntervalMs: 5 } });

    expect(
      invalid(events).filter((event) =>
        event.message.includes("profiler.flushIntervalMs must be an integer from 1000 to 600000"),
      ),
    ).toHaveLength(1);
    expect(limit()).toHaveLength(1);
  });
});

describe("collect sites", () => {
  describe.each(["flush()", "pagehide", "shutdown()"] as const)("at %s", (site) => {
    /**
     * Measures one span and runs the collect site. The clock ticks, so a calibration would
     * produce a value.
     * @returns The profile records the transport and the exit transport received.
     */
    async function sentAt(): Promise<LogRecord[]> {
      const exit = vi.fn<(request: TransportRequest) => boolean>(() => true);
      const { memory } = await start({ profiler: { enabled: true }, transportOnExit: exit });
      const { clock } = stubClock();
      span(profiler.probe("grid.render"), clock, 3);
      clock.step = 0.01;

      if (site === "flush()") {
        await flush();
      } else if (site === "shutdown()") {
        await shutdown();
      } else {
        dispatchEvent(new Event("pagehide"));
      }

      return profiles([...memory.records(), ...exit.mock.calls.flatMap(([call]) => call.records)]);
    }

    it("sends the waiting points", async () => {
      expect((await sentAt()).map((one) => one.attributes["metric.count"])).toEqual([1]);
    });

    it("reports no overhead value", async () => {
      expect((await sentAt())[0].attributes).not.toHaveProperty(OVERHEAD);
    });
  });

  it("sends the waiting points with the old session id at newSession()", async () => {
    const { memory } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    getLogger("app").info("before");
    span(profiler.probe("grid.render"), clock, 3);

    newSession();
    getLogger("app").info("after");
    await flush();

    const sessionOf = (body: string) =>
      memory.records().find((record) => record.body === body)!.resource["session.id"];
    expect(sessionOf("after")).not.toBe(sessionOf("before"));
    expect(profiles(memory.records())[0].resource["session.id"]).toBe(sessionOf("before"));
  });

  it("sends the waiting points to the old destination at a rotation", async () => {
    const next = createMemoryTransport();
    const { memory: old } = await start({ profiler: { enabled: true } });
    const { clock } = stubClock();
    const probe = profiler.probe("grid.render");
    span(probe, clock, 3);

    await rotateSecurityContext(
      { id: "new", delivery: { transport: next.transport } },
      { pending: "flush" },
    );
    // The span has to begin after the clock value of the rotation's reset.
    clock.now += 1;
    span(probe, clock, 5);
    await flush();

    expect(profiles(old.records()).map((one) => one.attributes["metric.sum"])).toEqual([3]);
    expect(profiles(next.records()).map((one) => one.attributes["metric.sum"])).toEqual([5]);
  });

  it.each([{ isolation: false }, { isolation: true }])(
    "drops the waiting points at an owner change with isolation $isolation",
    async ({ isolation }) => {
      const { memory } = await start({
        profiler: { enabled: true },
        securityContext: { isolation },
      });
      const { clock } = stubClock();
      const probe = profiler.probe("grid.render");
      const adopt = (await runtime()["constructBus"]())!["handlers"].onSecurityContext!;
      expect(adopt("owner-A")).toBe(true);
      span(probe, clock, 3);

      expect(adopt("owner-B")).toBe(true);
      await flush();
      expect(profiles(memory.records())).toEqual([]);

      // The reset zeroed the data, so a new span gives a count of one.
      clock.now += 1;
      span(probe, clock, 4);
      await flush();
      expect(profiles(memory.records())[0].attributes).toMatchObject({
        "metric.count": 1,
        "metric.sum": 4,
      });
    },
  );

  it("does not touch the core at an owner change while the profiler is off", async () => {
    const reset = vi.spyOn(ProfilerCore.prototype, "reset");
    await start();
    const adopt = (await runtime()["constructBus"]())!["handlers"].onSecurityContext!;

    expect(adopt("owner-A")).toBe(true);
    expect(adopt("owner-B")).toBe(true);

    expect(reset).not.toHaveBeenCalled();
    expect(hasCore()).toBe(false);
  });
});

describe("identity isolation", () => {
  /**
   * Measures a span that begins before a rotation and ends after it.
   * @param over Settings that override the base settings.
   * @returns The records at the new destination.
   */
  async function acrossRotation(over: ObservabilityConfig) {
    const next = createMemoryTransport();
    await start({ profiler: { enabled: true }, ...over });
    const { clock } = stubClock();
    const probe = profiler.probe("grid.render");

    const token = probe.begin();
    clock.now += 50;
    await rotateSecurityContext({ id: "new", delivery: { transport: next.transport } });
    clock.now += 25;
    probe.end(token);
    await flush();

    return profiles(next.records());
  }

  it("adds no value for a span of the old identity with isolation on", async () => {
    expect(await acrossRotation({})).toEqual([]);
  });

  it("adds the value of a span across the rotation with isolation off", async () => {
    const records = await acrossRotation({ securityContext: { isolation: false } });

    expect(records.map((one) => one.attributes["metric.sum"])).toEqual([75]);
  });

  it("does not touch the core at a rotation while the profiler is off", async () => {
    const next = createMemoryTransport();
    const touched = [
      vi.spyOn(ProfilerCore.prototype, "attach"),
      vi.spyOn(ProfilerCore.prototype, "collect"),
      vi.spyOn(ProfilerCore.prototype, "reset"),
      vi.spyOn(ProfilerCore.prototype, "detach"),
    ];
    await start();

    await rotateSecurityContext({ id: "new", delivery: { transport: next.transport } });
    newSession();

    for (const spy of touched) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(hasCore()).toBe(false);
  });
});

describe("shutdown() and the profiler", () => {
  it("returns -1 for a probe after shutdown()", async () => {
    await start({ profiler: { enabled: true } });
    const probe = profiler.probe("grid.render");
    expect(probe.begin()).toBeGreaterThanOrEqual(0);

    await shutdown();

    expect(probe.begin()).toBe(-1);
  });

  it("reads no clock for a probe after shutdown()", async () => {
    await start({ profiler: { enabled: true } });
    const probe = profiler.probe("grid.render");
    const { read } = stubClock();
    await shutdown();
    read.mockClear();

    probe.end(probe.begin());

    expect(read).not.toHaveBeenCalled();
  });

  it("measures again with the same probe after the next configure()", async () => {
    const { clock } = stubClock();
    await start({ profiler: { enabled: true } });
    const probe = profiler.probe("grid.render");
    await shutdown();

    const { memory } = await start({ profiler: { enabled: true } });
    // The span has to begin after the detach's clock value.
    clock.now += 1;
    span(probe, clock, 3);
    await flush();

    expect(profiles(memory.records())).toHaveLength(1);
  });

  it("does not detach the core at shutdown() while the profiler is off", async () => {
    const detach = vi.spyOn(ProfilerCore.prototype, "detach");
    await start();

    await shutdown();

    expect(detach).not.toHaveBeenCalled();
  });

  it("creates no core at shutdown() while the profiler is off", async () => {
    await start();

    await shutdown();

    expect(hasCore()).toBe(false);
  });
});

describe("console-only runtime", () => {
  /**
   * Creates a probe, measures one span, then runs flush() and shutdown() and reads the drop count.
   * @param clock The test's clock.
   * @returns How many points had no destination.
   */
  async function measureOnce(clock: Clock): Promise<number | undefined> {
    const probe = profiler.probe("grid.render");
    expect(probe.begin()).toBeGreaterThanOrEqual(0);
    span(probe, clock, 3);
    await expect(flush()).resolves.toBeUndefined();
    const dropped = runtime().diagnostics.snapshot()["record.dropped_no_destination"];
    await expect(shutdown()).resolves.toBeUndefined();
    return dropped;
  }

  describe("with another library version on the page", () => {
    afterEach(async () => {
      await shutdown();
      Reflect.deleteProperty(globalThis, RUNTIME_KEY);
      ObservabilityRuntime["local"] = null;
    });

    it("throws no error", async () => {
      (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = {
        sdkVersion: "0.8.5",
        destroyed: false,
        reconfigure: vi.fn(),
      };
      const { clock } = stubClock();

      configure({ ...base, profiler: { enabled: true } });

      expect(runtime().sdkVersion).toBe(TELEMETRY_SDK_VERSION);
      expect(await measureOnce(clock)).toBe(1);
    });
  });

  it("throws no error on Node", async () => {
    vi.stubGlobal("document", undefined);
    const { clock } = stubClock();

    configure({ serviceName: "svc", profiler: { enabled: true } });

    expect(runtime().platform.platform).toBe("node");
    expect(await measureOnce(clock)).toBe(1);
  });
});

describe("profiler.time", () => {
  it("calls the function with no span before configure()", () => {
    expect(profiler.time("early", () => 3)).toBe(3);
    expect(ObservabilityRuntime.current()).toBeNull();
  });

  it("times a function call and gives its result", async () => {
    const { clock } = stubClock();
    const { memory } = await start({ profiler: { enabled: true } });

    const result = profiler.time("sum", () => {
      clock.now += 4;
      return 7;
    });
    await flush();

    expect(result).toBe(7);
    expect(profiles(memory.records()).map((record) => record.attributes)).toMatchObject([
      { "profile.probe": "sum", "metric.count": 1, "metric.sum": 4, "profile.self_p99": 4 },
    ]);
  });

  it("sends the report for a bad name to the current runtime", async () => {
    const { events } = await start({ profiler: { enabled: true } });

    expect(profiler.time("", () => "done")).toBe("done");

    expect(invalid(events).map((event) => event.message)).toEqual([
      "The probe name must be a string that is not empty. The probe does nothing.",
    ]);
  });
});

describe("span breadcrumb", () => {
  it("adds a breadcrumb for a span that is longer than the threshold of its probe", async () => {
    const { clock } = stubClock();
    const { memory } = await start({ profiler: { enabled: true } });
    const probe = profiler.probe("sort", { slowMs: 16 });

    span(probe, clock, 16);
    span(probe, clock, 50.4);
    getLogger("app").error("failed", new Error("x"));
    await flush();

    const failed = memory.records().find((record) => record.body === "failed");
    const crumbs = failed?.attributes.breadcrumbs as { category: string; message: string }[];
    expect(crumbs.filter((crumb) => crumb.category === "profile")).toMatchObject([
      { category: "profile", message: "sort 50 ms" },
    ]);
  });
});

describe("profiler observers", () => {
  /**
   * Returns the names of the installed capture modules once every chunk has loaded.
   * @returns The names, in install order.
   */
  async function installed(): Promise<string[]> {
    await vi.dynamicImportSettled();
    await flush();
    return runtime()["captures"].map((capture) => capture.name);
  }

  it("loads no observer for a profiler with no observer flag", async () => {
    await start({ profiler: { enabled: true } });

    expect(await installed()).toEqual([]);
  });

  it("loads no observer while the profiler is off", async () => {
    await start({ profiler: { framePhases: true, framePacing: true } });

    expect(await installed()).toEqual([]);
  });

  it("loads the frame phases and the frame pacing with their flags", async () => {
    await start({ profiler: { enabled: true, framePhases: true, framePacing: true } });

    await vi.waitFor(async () => {
      expect(await installed()).toEqual(["frame-phases", "frame-pacing"]);
    });
  });

  it("installs and removes an observer when configure() changes its flag", async () => {
    await start({ profiler: { enabled: true } });

    configure({ profiler: { framePacing: true } });
    await vi.waitFor(async () => {
      expect(await installed()).toEqual(["frame-pacing"]);
    });

    configure({ profiler: { framePacing: false, framePhases: true } });
    await vi.waitFor(async () => {
      expect(await installed()).toEqual(["frame-phases"]);
    });
  });

  it("removes each observer when configure() turns the profiler off", async () => {
    await start({ profiler: { enabled: true, framePhases: true, framePacing: true } });
    await vi.waitFor(async () => {
      expect(await installed()).toHaveLength(2);
    });

    configure({ profiler: { enabled: false } });

    await vi.waitFor(async () => {
      expect(await installed()).toEqual([]);
    });
  });
});

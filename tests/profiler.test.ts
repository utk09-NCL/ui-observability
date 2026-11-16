// tests/profiler.test.ts
//
// Tests for the profiler core. A stubbed clock and fake timers make every time value exact.

import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { TELEMETRY_SDK_VERSION } from "../src/constants";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { ProfilerCore, type ProfilerSink, profilerCore } from "../src/core/profiler";
import type { Probe, ProbeOptions } from "../src/models/metric";

/** Fake system time, in epoch ms. */
const T0 = 1_700_000_000_000;

/** Global symbol for this library version's core. */
const CORE_KEY = Symbol.for(`ui-observability.profiler@${TELEMETRY_SDK_VERSION}`);

/** One record the sink received. */
interface Emitted {
  name: string;
  attributes: Record<string, unknown>;
  fields: Record<string, unknown>;
}

/** Every core the tests created. Teardown detaches each one and clears its timer. */
const cores: ProfilerCore[] = [];

const asName = (value: unknown): string => value as string;
const asNumber = (value: unknown): number => value as number;

afterEach(() => {
  // Restore the clock first, then detach with the real clock and clear the fake timer.
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) {
    core.detach();
  }
  Reflect.deleteProperty(globalThis, CORE_KEY);
  vi.useRealTimers();
});

/**
 * Builds a core and a sink. The sink collects the records and the diagnostic events.
 * @param capacity The sink's probe limit.
 * @param intervalMs The sink's interval, in ms.
 * @returns The core, the sink and what the sink collects.
 */
function setup(capacity = 8, intervalMs = 1000) {
  const events: DiagnosticEvent[] = [];
  const emitted: Emitted[] = [];
  const outliers: [string, number][] = [];
  const state = { ready: true };
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const countSpy = vi.spyOn(diagnostics, "count");
  const sink: ProfilerSink = {
    capacity,
    intervalMs: vi.fn(() => intervalMs),
    emit: (name, attributes, fields) => {
      emitted.push({ name, attributes: { ...attributes }, fields: { ...fields } });
    },
    diagnostics,
    ready: () => state.ready,
    outlier: (name, ms) => {
      outliers.push([name, ms]);
    },
  };
  const core = new ProfilerCore();
  cores.push(core);
  return { core, sink, events, emitted, state, diagnostics, countSpy, outliers };
}

/**
 * Builds a core that is already attached.
 * @param capacity The sink's probe limit.
 * @returns Everything setup() returns.
 */
function attached(capacity = 8) {
  const harness = setup(capacity);
  harness.core.attach(harness.sink);
  return harness;
}

/**
 * Returns the n of every bulk count call for malformed records. (report() counts with a single
 * argument, so those calls are left out.)
 * @param countSpy Spy on the diagnostics' count method.
 * @returns The n values, in call order.
 */
function bulkCounts(countSpy: MockInstance<Diagnostics["count"]>): number[] {
  return countSpy.mock.calls
    .filter(([code, by]) => code === "record.dropped_malformed" && by !== undefined)
    .map(([, by]) => by!);
}

/**
 * Replaces the clock with a value the test sets by hand.
 * @param start Initial clock value.
 * @returns The clock object and the spy on performance.now.
 */
function manualClock(start = 100) {
  const clock = { now: start };
  const spy = vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  return { clock, spy };
}

/**
 * A clock whose k-th read is start + k * step. One read never affects another.
 * @param start Value of the first read.
 * @param step How much each read adds.
 * @returns A function for mockImplementation.
 */
function steppingClock(start: number, step: number): () => number {
  let index = 0;
  return () => start + step * index++;
}

/**
 * A clock that returns the given values in order and then keeps repeating the last one.
 * @param values Values for the first reads.
 * @returns A function for mockImplementation.
 */
function sequenceClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

/** Fakes the timeouts and the date. The test's clock stays separate. */
function useTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: T0 });
}

/**
 * Builds an attached core with fake timers and a frozen clock.
 * @param capacity The sink's probe limit.
 * @param intervalMs The sink's interval, in ms.
 * @returns Everything setup() returns, plus the clock object and the clock spy.
 */
function timed(capacity = 8, intervalMs = 1000) {
  useTimers();
  const harness = setup(capacity, intervalMs);
  const { clock, spy } = manualClock();
  harness.core.attach(harness.sink);
  return { ...harness, clock, spy };
}

/**
 * Runs one span on the test's clock.
 * @param clock The clock object from manualClock().
 * @param probe The probe to time.
 * @param ms Span length in ms.
 * @returns The token begin() returned.
 */
function span(clock: { now: number }, probe: Probe, ms: number): number {
  const token = probe.begin();
  clock.now += ms;
  probe.end(token);
  return token;
}

describe("probe registration", () => {
  const badNames = [
    { label: "a number", name: 42 },
    { label: "an empty string", name: "" },
    { label: "undefined", name: undefined },
    { label: "a symbol", name: Symbol("name") },
  ];

  it.each(badNames)("returns a no-op probe for $label", ({ name }) => {
    const { core, sink, events, emitted, diagnostics } = setup();
    const { spy } = manualClock();
    core.attach(sink);

    const { begin, end, record } = core.probe(asName(name), undefined, diagnostics);

    expect(begin()).toBe(-1);
    expect(end(5)).toBeUndefined();
    expect(record(5)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    core.collect(false);
    expect(emitted).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
  });

  it("returns the same no-op probe for every invalid name", () => {
    const { core } = attached();

    expect(core.probe(asName(42))).toBe(core.probe(""));
  });

  it("never runs the toString of a name that is not a string", () => {
    const toString = vi.fn(() => {
      throw new Error("hostile");
    });
    const { core } = attached();

    const probe = core.probe(asName({ toString }));

    expect(probe.begin()).toBe(-1);
    expect(toString).not.toHaveBeenCalled();
  });

  it("reports nothing for an invalid name when no diagnostics is passed", () => {
    const { core, sink, events } = setup();

    expect(() => core.probe(asName(42))).not.toThrow();
    expect(core.probe("").begin()).toBe(-1);
    expect(events).toEqual([]);

    core.attach(sink);

    expect(events).toEqual([]);
  });

  it("reports nothing for a bad name or a bad sampleEvery option without a diagnostics parameter while attached", () => {
    const { core, events, diagnostics } = attached();

    core.probe("");
    core.probe("a", { sampleEvery: 0 });

    expect(events).toEqual([]);

    // The same calls report once diagnostics is passed in. The attached sink doesn't report them.
    core.probe("", undefined, diagnostics);
    core.probe("b", { sampleEvery: 0 }, diagnostics);

    expect(events.map(({ code }) => code)).toEqual(["config.invalid", "config.invalid"]);
  });

  it("reports a bad name to the diagnostics of the call after a detach", () => {
    const { core, events, diagnostics } = attached();
    core.detach();

    core.probe("", undefined, diagnostics);

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
  });

  it("reports a bad name to the diagnostics of the call and not to the sink", () => {
    const { core, events } = attached();
    const other: DiagnosticEvent[] = [];
    const given = new Diagnostics((event) => {
      other.push(event);
    }, 0);

    core.probe("", undefined, given);

    expect(other).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("returns the same probe object for the same name", () => {
    const { core } = attached();

    expect(core.probe("a")).toBe(core.probe("a"));
    expect(core.probe("a")).not.toBe(core.probe("b"));
  });

  it("keeps the first options of a name", () => {
    const { core, events, diagnostics } = attached();
    manualClock();
    const first = core.probe("a", { sampleEvery: 3 }, diagnostics);

    const again = core.probe("a", { sampleEvery: 5 }, diagnostics);
    const invalid = core.probe("a", { sampleEvery: 0 }, diagnostics);
    first.record(1);

    expect(again).toBe(first);
    expect(invalid).toBe(first);
    expect(events).toEqual([]);
    // A period of 3 skips two spans and then measures one.
    expect([first.begin(), first.begin(), first.begin()]).toEqual([-1, -1, 100]);
  });

  it.each([
    { label: "undefined", value: undefined, period: 1 },
    { label: "1", value: 1, period: 1 },
    { label: "2", value: 2, period: 2 },
    { label: "2 ** 31 - 1", value: 2 ** 31 - 1, period: 2 ** 31 - 1 },
  ])("keeps a sampleEvery option of $label", ({ value, period }) => {
    const { core, events, emitted, diagnostics } = attached();

    core.probe("a", { sampleEvery: value }, diagnostics).record(1);
    core.collect(false);

    expect(events).toEqual([]);
    expect(emitted[0].attributes["profile.sample_every"]).toBe(period);
  });

  it("uses a period of 1 when the options are null", () => {
    const { core, emitted } = attached();

    core.probe("a", null as unknown as ProbeOptions).record(1);
    core.collect(false);

    expect(emitted[0].attributes["profile.sample_every"]).toBe(1);
  });

  it.each([
    { label: "0", value: 0 },
    { label: "0.5", value: 0.5 },
    { label: "2 ** 31", value: 2 ** 31 },
    { label: "a string", value: "2" },
    { label: "NaN", value: Number.NaN },
    { label: "a negative number", value: -3 },
    { label: "null", value: null },
  ])("reports a sampleEvery option of $label and uses 1", ({ value }) => {
    const { core, events, diagnostics } = attached();
    manualClock();

    const probe = core.probe("a", { sampleEvery: asNumber(value) }, diagnostics);

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
    expect(events[0].message).toContain("sampleEvery");
    expect(events[0].message).toContain("a");
    // A period of 1 measures every span.
    expect([probe.begin(), probe.begin()]).toEqual([100, 100]);
  });

  it("reports nothing for an invalid sampleEvery option when no diagnostics is passed", () => {
    const { core, sink, events } = setup();

    core.probe("a", { sampleEvery: 0 });
    core.attach(sink);

    expect(events).toEqual([]);
  });

  it.each([
    {
      label: "a getter that throws",
      make: (error: Error): ProbeOptions => ({
        get sampleEvery(): number {
          throw error;
        },
      }),
    },
    {
      label: "a Proxy whose get trap throws",
      make: (error: Error): ProbeOptions =>
        new Proxy<ProbeOptions>(
          {},
          {
            get() {
              throw error;
            },
          },
        ),
    },
  ])("reports $label with the error as the cause and uses 1", ({ make }) => {
    const error = new Error("hostile options");
    const { core, events, diagnostics } = attached();
    manualClock();

    const probe = core.probe("a", make(error), diagnostics);

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
    expect(events[0].cause).toBe(error);
    expect([probe.begin(), probe.begin()]).toEqual([100, 100]);
  });

  it("reports nothing for options that throw without a diagnostics parameter", () => {
    const { core, events } = setup();
    const options = new Proxy<ProbeOptions>(
      {},
      {
        get() {
          throw new Error("hostile options");
        },
      },
    );

    expect(() => core.probe("a", options)).not.toThrow();
    expect(events).toEqual([]);
  });

  it("registers 1024 names", () => {
    const { core, events, emitted, diagnostics } = attached(1024);
    const probes = Array.from({ length: 1024 }, (_unused, i) =>
      core.probe(`probe-${String(i)}`, undefined, diagnostics),
    );

    expect(new Set(probes).size).toBe(1024);
    expect(events).toEqual([]);

    // A stored name still returns its probe, and the last slot still works.
    expect(core.probe("probe-0", undefined, diagnostics)).toBe(probes[0]);
    probes[1023].record(2);
    core.collect(false);
    expect(emitted.map(({ attributes }) => attributes["profile.probe"])).toEqual(["probe-1023"]);
  });

  it("returns a no-op probe for name 1025", () => {
    const { core, events, diagnostics } = attached(1024);
    const { spy } = manualClock();
    for (let i = 0; i < 1024; i++) {
      core.probe(`probe-${String(i)}`);
    }

    const extra = core.probe("extra", undefined, diagnostics);

    expect(extra.begin()).toBe(-1);
    expect(spy).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
    expect(events[0].message).toContain("extra");

    // The core doesn't store the name, so the same name reports again.
    expect(core.probe("extra", undefined, diagnostics).begin()).toBe(-1);
    expect(events).toHaveLength(2);
  });

  it("keeps one probe and one slot when an options getter registers the same name", () => {
    const { core, events, emitted, diagnostics } = attached(2);
    manualClock();
    let inner: Probe | undefined;
    const options: ProbeOptions = {
      get sampleEvery(): number {
        inner = core.probe("x", undefined, diagnostics);
        return 4;
      },
    };

    const outer = core.probe("x", options, diagnostics);

    expect(outer).toBe(inner);
    expect(events).toEqual([]);

    // If x took a single slot, y gets slot 2 and z is over the limit of 2.
    const y = core.probe("y", undefined, diagnostics);
    const z = core.probe("z", undefined, diagnostics);

    expect(y.begin()).toBe(100);
    expect(z.begin()).toBe(-1);
    expect(events).toHaveLength(1);

    // The registration made inside the getter wins. Its period is 1, not the getter's 4.
    outer.record(1);
    core.collect(false);
    expect(emitted[0].attributes["profile.sample_every"]).toBe(1);
  });

  it("returns a no-op probe when an options getter fills the registry", () => {
    const { core, events, diagnostics } = attached(1024);
    const options: ProbeOptions = {
      get sampleEvery(): number {
        for (let i = 0; i < 1024; i++) {
          core.probe(`filler-${String(i)}`);
        }
        return 2;
      },
    };

    const outer = core.probe("outer", options, diagnostics);

    expect(outer.begin()).toBe(-1);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("outer");
    // The core didn't store the name, so the same name reports again.
    expect(core.probe("outer", undefined, diagnostics).begin()).toBe(-1);
    expect(events).toHaveLength(2);
  });
});

describe("probe limit", () => {
  it("turns a probe over the capacity into a no-op", () => {
    const { core, emitted } = attached(2);
    manualClock();
    const a = core.probe("a");
    core.probe("b");
    const c = core.probe("c");

    expect(c.begin()).toBe(-1);

    // A probe over the limit adds nothing. A probe under it works.
    c.record(5);
    a.record(1);
    core.collect(false);
    expect(emitted.map(({ attributes }) => attributes["profile.probe"])).toEqual(["a"]);
  });

  it("reports once for the probes over the capacity", () => {
    const { core, events, diagnostics } = attached(2);
    core.probe("a", undefined, diagnostics);
    core.probe("b", undefined, diagnostics);

    expect(events).toEqual([]);

    core.probe("c", undefined, diagnostics);

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
    expect(events[0].message).toContain("probe c");
    expect(events[0].message).toContain("limit of 2");

    // A second probe over the limit doesn't report again.
    expect(core.probe("d", undefined, diagnostics).begin()).toBe(-1);
    expect(events).toHaveLength(1);
  });

  it("reports a probe above the limit to the sink without a diagnostics parameter", () => {
    const { core, events } = attached(1);
    core.probe("a");

    core.probe("b");

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
    expect(events[0].message).toContain("probe b");
    expect(events[0].message).toContain("limit of 1");

    // A second probe over the limit doesn't report again.
    core.probe("c");

    expect(events).toHaveLength(1);
  });

  it("reports a probe above the limit to the sink and not to the diagnostics of the call", () => {
    const { core, events } = attached(1);
    const other: DiagnosticEvent[] = [];
    const given = new Diagnostics((event) => {
      other.push(event);
    }, 0);
    core.probe("a", undefined, given);

    core.probe("b", undefined, given);
    core.probe("c", undefined, given);

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("probe b");
    expect(other).toEqual([]);
  });

  it("reports nothing when a probe registers above the limit while detached", () => {
    const { core, sink, events, diagnostics } = setup(1);
    core.attach(sink);
    core.detach();

    core.probe("a", undefined, diagnostics);
    core.probe("b", undefined, diagnostics);

    expect(events).toEqual([]);
  });

  it("reports once when attach finds more probes than the capacity", () => {
    const { core, sink, events, emitted, diagnostics } = setup(2);
    manualClock();
    const a = core.probe("a", undefined, diagnostics);
    core.probe("b", undefined, diagnostics);
    const c = core.probe("c", undefined, diagnostics);

    // The core is detached, so probe calls report nothing, even past the capacity.
    expect(events).toEqual([]);

    core.attach(sink);

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
    expect(events[0].message).toContain("registered 3 probes");
    expect(events[0].message).toContain("limit is 2");

    // The attach already reported, so another probe over the limit stays quiet.
    core.probe("d", undefined, diagnostics);

    expect(events).toHaveLength(1);
    expect(a.begin()).toBe(100);
    expect(c.begin()).toBe(-1);
    c.record(5);
    core.collect(false);
    expect(emitted).toEqual([]);
  });

  it("reports nothing when attach finds as many probes as the capacity", () => {
    const { core, sink, events, diagnostics } = setup(2);
    core.probe("a", undefined, diagnostics);
    core.probe("b", undefined, diagnostics);

    core.attach(sink);

    expect(events).toEqual([]);
  });

  it("reports again for a probe above the limit in a new attach", () => {
    const { core, sink, events, diagnostics } = setup(3);
    core.attach(sink);
    core.probe("a", undefined, diagnostics);
    core.probe("b", undefined, diagnostics);
    core.probe("c", undefined, diagnostics);
    core.probe("d", undefined, diagnostics);

    expect(events).toHaveLength(1);

    core.attach({ ...sink, capacity: 4 });

    expect(events).toHaveLength(1);

    core.probe("e", undefined, diagnostics);

    expect(events).toHaveLength(2);
  });
});

describe("limit report in collect", () => {
  /** The limit report text, from attach() and from the retry in collect(). */
  const limitText = (count: number, capacity: number): string =>
    `The app registered ${String(count)} probes. The profiler.maxProbes limit is ${String(capacity)}. The probes above the limit do nothing.`;

  /** Message of an earlier event that opens the config.invalid throttle window. */
  const EARLIER = "An earlier event opens the throttle window.";

  /**
   * Builds a core and a sink around a real Diagnostics with a throttle window. The date stays
   * where the test put it until the test moves it.
   * @param throttleMs The Diagnostics throttle window.
   * @returns The core, the sink, the events, the date and ready state, and the Diagnostics.
   */
  function throttled(throttleMs = 1000) {
    const events: DiagnosticEvent[] = [];
    const state = { ready: true, now: T0 };
    vi.spyOn(Date, "now").mockImplementation(() => state.now);
    const diagnostics = new Diagnostics((event) => {
      events.push(event);
    }, throttleMs);
    const sink: ProfilerSink = {
      capacity: 2,
      intervalMs: () => 1000,
      emit: () => undefined,
      diagnostics,
      ready: () => state.ready,
      outlier: () => undefined,
    };
    const core = new ProfilerCore();
    cores.push(core);
    return { core, sink, events, state, diagnostics };
  }

  /** Returns how many config.invalid reports were counted, throttled ones included. */
  const counted = (diagnostics: Diagnostics): number | undefined =>
    diagnostics.snapshot()["config.invalid"];

  /** Returns the messages of a list of events. */
  const messages = (events: DiagnosticEvent[]): string[] => events.map(({ message }) => message);

  /** The two ways an attach can produce its first limit report, with a capacity of 2. */
  const origins = [
    {
      label: "the attach",
      make: (core: ProfilerCore, sink: ProfilerSink) => {
        core.probe("a");
        core.probe("b");
        core.probe("c");
        core.attach(sink);
      },
    },
    {
      label: "the first registration above the limit",
      make: (core: ProfilerCore, sink: ProfilerSink) => {
        core.attach(sink);
        core.probe("a");
        core.probe("b");
        core.probe("c");
      },
    },
  ];

  it("reports no limit in a collect while no probe is above the limit", () => {
    const { core, sink, events, diagnostics } = throttled();
    core.attach(sink);
    core.probe("a");
    core.probe("b");

    core.collect(false);
    core.collect(true);

    expect(events).toEqual([]);
    expect(counted(diagnostics)).toBeUndefined();
  });

  it.each(origins)(
    "reports nothing in a collect after the first report from $label arrived",
    ({ make }) => {
      const { core, sink, events, state, diagnostics } = throttled();
      make(core, sink);
      expect(events).toHaveLength(1);

      state.now += 5000;
      core.collect(false);
      core.collect(true);

      expect(events).toHaveLength(1);
      expect(counted(diagnostics)).toBe(1);
    },
  );

  it.each(origins)(
    "reports the limit again at the next collect after the throttle dropped the report from $label",
    ({ make }) => {
      const { core, sink, events, state, diagnostics } = throttled();
      diagnostics.report("config.invalid", EARLIER);
      make(core, sink);
      expect(messages(events)).toEqual([EARLIER]);
      expect(counted(diagnostics)).toBe(2);

      state.now += 1000;
      core.collect(false);

      // The retry counts as one. Once the handler got it, the report is done.
      expect(messages(events)).toEqual([EARLIER, limitText(3, 2)]);
      expect(counted(diagnostics)).toBe(3);

      core.collect(true);
      core.collect(false);

      expect(events).toHaveLength(2);
      expect(counted(diagnostics)).toBe(3);
    },
  );

  it.each(origins)("counts the registry at the retry after $label", ({ make }) => {
    const { core, sink, events, state, diagnostics } = throttled();
    diagnostics.report("config.invalid", EARLIER);
    make(core, sink);
    core.probe("d");
    core.probe("e");

    state.now += 1000;
    core.collect(false);

    expect(messages(events)).toEqual([EARLIER, limitText(5, 2)]);
  });

  it.each(origins)(
    "retries at each ready collect until the throttle lets one report through after $label",
    ({ make }) => {
      const { core, sink, events, state, diagnostics } = throttled();
      diagnostics.report("config.invalid", EARLIER);
      make(core, sink);

      // The earlier event's window lasts 1000 ms, and the first two retries fall inside it.
      core.collect(false);
      expect(events).toHaveLength(1);
      expect(counted(diagnostics)).toBe(3);

      state.now += 500;
      core.collect(true);
      expect(events).toHaveLength(1);
      expect(counted(diagnostics)).toBe(4);

      state.now += 600;
      core.collect(false);
      expect(messages(events)).toEqual([EARLIER, limitText(3, 2)]);
      expect(counted(diagnostics)).toBe(5);

      core.collect(false);
      core.collect(true);
      expect(events).toHaveLength(2);
      expect(counted(diagnostics)).toBe(5);
    },
  );

  it.each(origins)("keeps the report while the sink is not ready after $label", ({ make }) => {
    const { core, sink, events, state, diagnostics } = throttled();
    diagnostics.report("config.invalid", EARLIER);
    make(core, sink);
    state.ready = false;
    state.now += 2000;

    core.collect(false);
    core.collect(true);

    expect(messages(events)).toEqual([EARLIER]);
    expect(counted(diagnostics)).toBe(2);

    state.ready = true;
    core.collect(false);

    expect(messages(events)).toEqual([EARLIER, limitText(3, 2)]);
    expect(counted(diagnostics)).toBe(3);
  });

  it.each(origins)(
    "clears the waiting report when a new attach has room for each probe after $label",
    ({ make }) => {
      const { core, sink, events, state, diagnostics } = throttled();
      diagnostics.report("config.invalid", EARLIER);
      make(core, sink);

      core.attach({ ...sink, capacity: 4 });
      state.now += 2000;
      core.collect(false);

      expect(messages(events)).toEqual([EARLIER]);
      expect(counted(diagnostics)).toBe(2);
    },
  );

  it.each(origins)(
    "retries in the first collect of a new attach that is also above the limit after $label",
    ({ make }) => {
      const { core, sink, events, state, diagnostics } = throttled();
      diagnostics.report("config.invalid", EARLIER);
      make(core, sink);

      // The new attach's report lands in the same window, so the throttle drops it too.
      core.attach({ ...sink });
      expect(messages(events)).toEqual([EARLIER]);
      expect(counted(diagnostics)).toBe(3);

      state.now += 1000;
      core.collect(false);
      core.collect(true);

      expect(messages(events)).toEqual([EARLIER, limitText(3, 2)]);
      expect(counted(diagnostics)).toBe(4);
    },
  );

  it.each(origins)("reports nothing in a collect after a detach following $label", ({ make }) => {
    const { core, sink, events, state, diagnostics } = throttled();
    diagnostics.report("config.invalid", EARLIER);
    make(core, sink);
    core.detach();
    state.now += 2000;

    core.collect(false);
    core.collect(true);
    core.attach({ ...sink, capacity: 4 });
    core.collect(false);

    expect(messages(events)).toEqual([EARLIER]);
    expect(counted(diagnostics)).toBe(2);
  });

  it.each(origins)(
    "clears the flag before the retry so that a handler that collects gets no further report after $label",
    ({ make }) => {
      const core = new ProfilerCore();
      cores.push(core);
      const events: DiagnosticEvent[] = [];
      const diagnostics = new Diagnostics((event) => {
        events.push(event);
        core.collect(false);
      }, 0);
      const report = diagnostics.report.bind(diagnostics);
      let dropped = false;
      // Stub the throttle: the first limit report returns false, like a dropped event would.
      vi.spyOn(diagnostics, "report").mockImplementation((...args) => {
        if (!dropped) {
          dropped = true;
          return false;
        }
        return report(...args);
      });
      const sink: ProfilerSink = {
        capacity: 2,
        intervalMs: () => 1000,
        emit: () => undefined,
        diagnostics,
        ready: () => true,
        outlier: () => undefined,
      };
      make(core, sink);
      expect(events).toEqual([]);

      core.collect(false);
      core.collect(true);

      expect(messages(events)).toEqual([limitText(3, 2)]);
    },
  );
});

describe("begin and end", () => {
  it("returns -1 and reads no clock while the profiler is off", () => {
    const { core, sink, countSpy } = setup();
    const { spy } = manualClock();
    const probe = core.probe("a");

    expect(probe.begin()).toBe(-1);
    probe.end(-1);
    expect(spy).not.toHaveBeenCalled();

    core.attach(sink);
    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it("returns -1 and reads no clock after a detach", () => {
    const { core, sink, countSpy } = attached();
    const { spy } = manualClock();
    const probe = core.probe("a");
    core.detach();
    spy.mockClear();

    expect(probe.begin()).toBe(-1);
    probe.end(-1);
    expect(spy).not.toHaveBeenCalled();

    core.attach(sink);
    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it("returns the clock value from begin with a single clock read", () => {
    const { core } = attached();
    const { spy } = manualClock(100);

    expect(core.probe("a").begin()).toBe(100);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reads the clock once in end", () => {
    const { core } = attached();
    const { clock, spy } = manualClock(100);
    const probe = core.probe("a");
    const token = probe.begin();
    spy.mockClear();

    clock.now = 105;
    probe.end(token);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("records the exact count, sum, min and max of the spans", () => {
    const { core, emitted } = attached();
    const { clock } = manualClock();
    const probe = core.probe("a");

    for (const ms of [5, 2, 8, 3]) {
      span(clock, probe, ms);
    }
    core.collect(false);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fields).toMatchObject({
      "metric.count": 4,
      "metric.sum": 18,
      "metric.min": 2,
      "metric.max": 8,
    });
  });

  it("measures one span of each 3 spans for a period of 3", () => {
    const { core, emitted } = attached();
    const { clock, spy } = manualClock(100);
    const probe = core.probe("a", { sampleEvery: 3 });

    const tokens = Array.from({ length: 9 }, () => span(clock, probe, 2));

    // A measured span reads the clock twice. A skipped span doesn't read it at all.
    expect(tokens).toEqual([100, -1, -1, 106, -1, -1, 112, -1, -1]);
    expect(spy).toHaveBeenCalledTimes(6);
    core.collect(false);
    expect(emitted[0].fields).toMatchObject({ "metric.count": 3, "metric.sum": 6 });
  });

  it("applies the period of a probe that registers before the attach", () => {
    const { core, sink } = setup();
    const { clock } = manualClock(100);
    const probe = core.probe("a", { sampleEvery: 3 });

    core.attach(sink);
    const tokens = Array.from({ length: 4 }, () => span(clock, probe, 2));

    expect(tokens).toEqual([100, -1, -1, 106]);
  });

  it("counts an invalid token and reads no clock", () => {
    const valueOf = vi.fn(() => {
      throw new Error("hostile");
    });
    const { core, emitted, countSpy } = attached();
    const { spy } = manualClock();
    const probe = core.probe("a");
    const tokens = ["5", Number.NaN, undefined, Symbol("token"), { valueOf }, -2];

    for (const token of tokens) {
      expect(() => {
        probe.end(asNumber(token));
      }).not.toThrow();
    }
    // -1 means the profiler didn't measure the span, so the core doesn't count it as bad.
    probe.end(-1);

    expect(spy).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();

    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([6]);
    expect(emitted).toEqual([]);

    // The count restarts after the report.
    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([6]);
  });

  it("does not count a bad token before the first attach", () => {
    const { core, sink, countSpy } = setup();
    const probe = core.probe("a");

    probe.end(asNumber("x"));
    probe.end(Number.NaN);
    core.attach(sink);
    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it("does not count a bad token while detached after an attach", () => {
    const { core, sink, countSpy } = attached();
    const probe = core.probe("a");
    core.detach();

    probe.end(asNumber("x"));
    probe.end(Number.NaN);
    core.attach(sink);
    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it("counts a bad token only while the profiler is on", () => {
    const { core, sink, countSpy } = setup();
    const probe = core.probe("a");

    probe.end(asNumber("off"));
    core.attach(sink);
    probe.end(asNumber("on"));
    core.collect(false);
    core.detach();
    probe.end(asNumber("off"));
    core.attach(sink);
    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([1]);
  });

  it("counts a token above the clock value and adds no value", () => {
    const { core, emitted, countSpy } = attached();
    const { spy } = manualClock(100);
    const probe = core.probe("a");

    probe.end(500);

    expect(spy).toHaveBeenCalledTimes(1);
    core.collect(false);
    expect(bulkCounts(countSpy)).toEqual([1]);
    expect(emitted).toEqual([]);
  });

  it("counts an infinite duration and adds no value", () => {
    const { core, emitted, countSpy } = attached();
    vi.spyOn(performance, "now").mockImplementation(sequenceClock([100, Infinity]));
    const probe = core.probe("a");

    const token = probe.begin();
    probe.end(token);

    expect(token).toBe(100);
    core.collect(false);
    expect(bulkCounts(countSpy)).toEqual([1]);
    expect(emitted).toEqual([]);
  });

  it("counts a clock value that is not a number and adds no value", () => {
    const { core, emitted, countSpy } = attached();
    vi.spyOn(performance, "now").mockImplementation(sequenceClock([100, Number.NaN]));
    const probe = core.probe("a");

    probe.end(probe.begin());

    core.collect(false);
    expect(bulkCounts(countSpy)).toEqual([1]);
    expect(emitted).toEqual([]);
  });

  it("works for a destructured begin, end and record", () => {
    const { core, emitted } = attached();
    const { clock } = manualClock();
    const { begin, end, record } = core.probe("a");

    const token = begin();
    clock.now += 3;
    end(token);
    record(2);
    core.collect(false);

    expect(emitted[0].fields).toMatchObject({ "metric.count": 2, "metric.sum": 5 });
  });

  it.each([
    {
      label: "a detach and a new attach",
      restart: (core: ProfilerCore, sink: ProfilerSink) => {
        core.detach();
        core.attach(sink);
      },
    },
    {
      label: "a reset",
      restart: (core: ProfilerCore) => {
        core.reset();
      },
    },
  ])("drops a span that begins before $label", ({ restart }) => {
    const { core, sink, emitted, countSpy } = attached();
    const { clock } = manualClock(100);
    const probe = core.probe("a");
    const old = probe.begin();
    clock.now = 105;

    restart(core, sink);
    clock.now = 110;
    probe.end(old);

    // A span that begins after the restart still works.
    span(clock, probe, 2);
    core.collect(false);

    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 2 });
    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it.each([
    {
      label: "a detach and a new attach",
      restart: (core: ProfilerCore, sink: ProfilerSink) => {
        core.detach();
        core.attach(sink);
      },
    },
    {
      label: "a reset",
      restart: (core: ProfilerCore) => {
        core.reset();
      },
    },
  ])("drops a span that begins in the clock tick of $label", ({ restart }) => {
    const { core, sink, emitted, countSpy } = attached();
    const { clock } = manualClock(1000);
    const probe = core.probe("a");
    const token = probe.begin();

    // The reset reads the same clock value, just like a coarse clock would within one tick.
    restart(core, sink);
    clock.now = 1005;
    probe.end(token);
    core.collect(false);

    expect(emitted).toEqual([]);
    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it.each([
    {
      label: "a detach and a new attach",
      restart: (core: ProfilerCore, sink: ProfilerSink) => {
        core.detach();
        core.attach(sink);
      },
    },
    {
      label: "a reset",
      restart: (core: ProfilerCore) => {
        core.reset();
      },
    },
  ])(
    "drops a new span that begins in the clock tick of $label and measures the next one",
    ({ restart }) => {
      const { core, sink, emitted, events, countSpy } = attached();
      const { clock } = manualClock(1000);
      const probe = core.probe("a");

      // The span begins after the restart, but a coarse clock still gives it the restart's value.
      restart(core, sink);
      const same = probe.begin();
      clock.now = 1003;
      probe.end(same);
      core.collect(false);

      expect(emitted).toEqual([]);
      expect(events).toEqual([]);
      expect(bulkCounts(countSpy)).toEqual([]);

      clock.now = 1004;
      const next = probe.begin();
      clock.now = 1007;
      probe.end(next);
      core.collect(false);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 3 });
    },
  );

  it("measures a span that begins at the clock value 0 before any reset", () => {
    const { core, emitted } = attached();
    const { clock } = manualClock(0);
    const probe = core.probe("a");

    span(clock, probe, 4);
    core.collect(false);

    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 4 });
  });

  it("adds no value for a span that begins while attached and ends while detached", () => {
    const { core, sink, emitted, countSpy } = attached();
    const { clock } = manualClock(100);
    const probe = core.probe("a");
    const token = probe.begin();

    // The span begins while on and ends while off. Being off drops it before the floor check.
    core.detach();
    clock.now = 105;
    probe.end(token);
    core.attach(sink);
    core.collect(false);

    expect(emitted).toEqual([]);
    expect(bulkCounts(countSpy)).toEqual([]);
  });
});

describe("record", () => {
  it("drops a duration with no report while the profiler is off", () => {
    const { core, sink, events, emitted } = attached();
    const probe = core.probe("a");
    core.detach();

    probe.record(5);
    probe.record(asNumber("5"));

    expect(events).toEqual([]);

    core.attach(sink);
    core.collect(false);

    expect(emitted).toEqual([]);
  });

  it.each([
    { label: "a string", value: "5" },
    { label: "NaN", value: Number.NaN },
    { label: "Infinity", value: Infinity },
    { label: "a negative value", value: -1 },
  ])("reports a duration that is $label and adds no value", ({ value }) => {
    const { core, events, emitted, diagnostics } = attached();
    const probe = core.probe("orders");

    probe.record(asNumber(value));

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("record.dropped_malformed");
    expect(events[0].detail).toEqual({ "profile.probe": "orders" });
    core.collect(false);
    expect(emitted).toEqual([]);
    // The report already counted one, and the collect adds nothing to it.
    expect(diagnostics.count("record.dropped_malformed", 0)).toBe(1);
  });

  it("reports an invalid duration to the sink, not to the diagnostics of the probe call", () => {
    const { core, events } = attached();
    const other: DiagnosticEvent[] = [];
    const given = new Diagnostics((event) => {
      other.push(event);
    }, 0);
    const probe = core.probe("orders", undefined, given);

    probe.record(asNumber("5"));

    expect(events.map(({ code }) => code)).toEqual(["record.dropped_malformed"]);
    expect(other).toEqual([]);
  });

  it("never runs the valueOf of a duration that is not a number", () => {
    const valueOf = vi.fn(() => {
      throw new Error("hostile");
    });
    const { core, events } = attached();

    expect(() => {
      core.probe("a").record(asNumber({ valueOf }));
    }).not.toThrow();

    expect(valueOf).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it("accepts a duration of 0", () => {
    const { core, events, emitted } = attached();
    const probe = core.probe("a");

    probe.record(0);
    core.collect(false);

    expect(events).toEqual([]);
    expect(emitted[0].fields).toMatchObject({
      "metric.count": 1,
      "metric.sum": 0,
      "metric.min": 0,
      "metric.max": 0,
    });
    expect(emitted[0].attributes).toMatchObject({
      "profile.p50": 0,
      "profile.p90": 0,
      "profile.p99": 0,
    });
  });

  it("uses the sampling countdown of begin for record", () => {
    const { core, emitted } = attached();
    const { clock } = manualClock();
    const probe = core.probe("a", { sampleEvery: 2 });

    // Operations 1, 3 and 5 are measured. Operations 2, 4 and 6 are skipped.
    span(clock, probe, 2);
    probe.record(100);
    probe.record(7);
    expect(span(clock, probe, 50)).toBe(-1);
    span(clock, probe, 4);
    probe.record(100);
    core.collect(false);

    expect(emitted[0].fields).toMatchObject({
      "metric.count": 3,
      "metric.sum": 13,
      "metric.min": 2,
      "metric.max": 7,
    });
  });
});

describe("interval timer", () => {
  it("arms one timer with the sink's interval at the first value", () => {
    const { core, sink } = timed(8, 2500);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const probe = core.probe("a");

    probe.record(1);

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 2500);
    expect(sink.intervalMs).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    // A second value doesn't arm a second timer.
    probe.record(2);

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("arms no timer for a value that the sampling skips", () => {
    const { core } = timed();
    const probe = core.probe("a", { sampleEvery: 2 });

    probe.record(1);
    core.collect(false);
    probe.record(2);

    expect(vi.getTimerCount()).toBe(0);

    probe.record(3);

    expect(vi.getTimerCount()).toBe(1);
  });

  it("unreferences the interval timer", () => {
    const { core } = timed();
    const timeout = vi.spyOn(globalThis, "setTimeout");

    core.probe("a").record(1);

    // An unref'd timer doesn't keep Node.js alive.
    const handle = timeout.mock.results[0].value as { hasRef(): boolean };
    expect(handle.hasRef()).toBe(false);
  });

  it("sends one summary record for each probe with data after the interval", async () => {
    const { core, emitted, events, diagnostics } = timed();
    const orders = core.probe("orders", undefined, diagnostics);
    core.probe("idle", undefined, diagnostics);
    const quotes = core.probe("quotes", { sampleEvery: 2 }, diagnostics);

    // Out of order on purpose, so min and max both have to move.
    for (const ms of [4, 9, 1, 7, 10, 2, 8, 3, 6, 5]) {
      orders.record(ms);
    }
    quotes.record(2.5);
    await vi.advanceTimersByTimeAsync(999);

    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    // The idle probe has no values, so it gets no record.
    expect(emitted.map(({ name }) => name)).toEqual(["ui.profile.duration", "ui.profile.duration"]);
    expect(emitted.map(({ attributes }) => attributes["profile.probe"])).toEqual([
      "orders",
      "quotes",
    ]);
    expect(events).toEqual([]);

    // The 10 values land in 10 buckets, and every bucket bound is above its value.
    expect(emitted[0].attributes).toStrictEqual({
      "profile.probe": "orders",
      "profile.sample_every": 1,
      "profile.p50": 5.119,
      "profile.p90": 9.215,
      "profile.p99": 10,
    });
    expect(emitted[0].fields).toStrictEqual({
      "metric.name": "ui.profile.duration",
      "metric.unit": "ms",
      "metric.type": "histogram",
      "metric.start_time_unix_nano": `${String(T0)}000000`,
      "metric.attribute_keys": ["profile.probe", "profile.sample_every"],
      "metric.count": 10,
      "metric.sum": 55,
      "metric.min": 1,
      "metric.max": 10,
      "metric.bounds": expect.any(Array),
      "metric.bucket_counts": expect.any(Array),
    });
    expect(emitted[1].attributes).toStrictEqual({
      "profile.probe": "quotes",
      "profile.sample_every": 2,
      "profile.p50": 2.5,
      "profile.p90": 2.5,
      "profile.p99": 2.5,
    });
  });

  it("writes the bounds and the bucket counts as plain arrays of the same range", async () => {
    const { core, emitted } = timed();
    const probe = core.probe("orders");

    for (const ms of [4, 9, 1, 7, 10, 2, 8, 3, 6, 5]) {
      probe.record(ms);
    }
    await vi.advanceTimersByTimeAsync(1000);

    const bounds = emitted[0].fields["metric.bounds"] as number[];
    const counts = emitted[0].fields["metric.bucket_counts"] as number[];

    expect(Array.isArray(bounds)).toBe(true);
    expect(Array.isArray(counts)).toBe(true);
    expect(counts).toHaveLength(bounds.length + 1);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(10);
    // The 1 ms bucket has an upper bound of 1.023 ms and holds one value.
    expect(bounds[0]).toBe(1.023);
    expect(counts[0]).toBe(1);
  });

  it("sets every percentile to the single duration, in milliseconds", async () => {
    const { core, emitted } = timed();

    core.probe("a").record(2.5);
    await vi.advanceTimersByTimeAsync(1000);

    // The bucket bound for 2.5 ms is 2.559 ms, and the max of 2.5 ms caps it.
    expect(emitted[0].attributes).toMatchObject({
      "profile.p50": 2.5,
      "profile.p90": 2.5,
      "profile.p99": 2.5,
    });
  });

  it("puts a duration with a part of a microsecond into the next bucket", () => {
    const { core, emitted } = attached();
    const probe = core.probe("a");

    // 1.0235 ms is 1023.5 us, which rounds up to 1024 us. The 1 ms bucket ends at 1023 us.
    probe.record(1);
    probe.record(1.0235);
    core.collect(false);

    expect(emitted[0].fields["metric.bounds"]).toEqual([1.023]);
    expect(emitted[0].fields["metric.bucket_counts"]).toEqual([1, 1]);
    expect(emitted[0].attributes["profile.p99"]).toBe(1.0235);
  });

  it("keeps each percentile from the min to the max for a duration above the last bucket", async () => {
    const { core, emitted } = timed();

    // The last bucket ends at about 67 seconds. The min of 100 seconds pulls the percentile up.
    core.probe("a").record(100_000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted[0].attributes).toMatchObject({
      "profile.p50": 100_000,
      "profile.p90": 100_000,
      "profile.p99": 100_000,
    });
    expect(emitted[0].fields).toMatchObject({ "metric.min": 100_000, "metric.max": 100_000 });
  });

  it("starts the next interval with a count of 0", async () => {
    const { core, emitted } = timed();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const probe = core.probe("a");

    probe.record(1);
    await vi.advanceTimersByTimeAsync(1300);
    probe.record(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted).toHaveLength(2);
    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 1 });
    expect(emitted[1].fields).toMatchObject({
      "metric.start_time_unix_nano": `${String(T0 + 1300)}000000`,
      "metric.count": 1,
      "metric.sum": 2,
    });
    expect(timeout).toHaveBeenCalledTimes(2);
  });

  it("continues the sampling countdown in the next interval", async () => {
    const { core, emitted } = timed();
    const probe = core.probe("a", { sampleEvery: 2 });

    probe.record(1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted).toHaveLength(1);

    // The countdown has one span left to skip. The value after that one is measured.
    probe.record(2);
    probe.record(3);
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted).toHaveLength(2);
    expect(emitted[1].fields).toMatchObject({ "metric.count": 1, "metric.sum": 3 });
  });

  it("keeps the data and the start time while the sink is not ready", async () => {
    const { core, sink, emitted, state } = timed(8, 1000);
    const probe = core.probe("a");
    state.ready = false;

    probe.record(1);
    await vi.advanceTimersByTimeAsync(1000);

    // The timer is armed again and the data is still there.
    expect(emitted).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    expect(sink.intervalMs).toHaveBeenCalledTimes(2);

    probe.record(3);
    state.ready = true;
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fields).toMatchObject({
      "metric.start_time_unix_nano": `${String(T0)}000000`,
      "metric.count": 2,
      "metric.sum": 4,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing in collect(false) while the sink is not ready", () => {
    const { core, emitted, state, countSpy } = timed();
    const probe = core.probe("a");
    probe.record(1);
    probe.end(asNumber("bad"));
    state.ready = false;

    core.collect(false);

    // The data, the bad token count and the pending timer are all still there.
    expect(emitted).toEqual([]);
    expect(bulkCounts(countSpy)).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("sends the record with the first start in collect(false) after the sink is ready", async () => {
    const { core, emitted, state, countSpy } = timed();
    const probe = core.probe("a");
    probe.record(1);
    probe.end(asNumber("bad"));
    state.ready = false;
    await vi.advanceTimersByTimeAsync(300);
    core.collect(false);
    probe.record(3);

    state.ready = true;
    core.collect(false);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fields).toMatchObject({
      "metric.start_time_unix_nano": `${String(T0)}000000`,
      "metric.count": 2,
      "metric.sum": 4,
    });
    expect(bulkCounts(countSpy)).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the record with the first start from the timer after the sink is ready", async () => {
    const { core, emitted, state } = timed(8, 1000);
    const probe = core.probe("a");
    probe.record(1);
    state.ready = false;
    core.collect(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toEqual([]);

    state.ready = true;
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].fields).toMatchObject({
      "metric.start_time_unix_nano": `${String(T0)}000000`,
      "metric.count": 1,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing in collect(false) while detached", () => {
    const { core, sink, emitted, countSpy } = setup();

    expect(() => {
      core.collect(false);
    }).not.toThrow();

    // A bad token from while we were on survives the detach: there is no sink to report it to.
    core.attach(sink);
    core.probe("a").end(asNumber("bad"));
    core.detach();

    expect(() => {
      core.collect(false);
    }).not.toThrow();
    expect(emitted).toEqual([]);
    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it("clears a pending timer in collect(false)", async () => {
    const { core, emitted } = timed();
    core.probe("a").record(1);

    expect(vi.getTimerCount()).toBe(1);

    core.collect(false);

    expect(vi.getTimerCount()).toBe(0);
    expect(emitted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(emitted).toHaveLength(1);
  });

  it("puts a value that end() adds inside an emit into the next interval", async () => {
    const { core, sink, emitted, clock } = timed();
    const probe = core.probe("a");
    const token = probe.begin();
    const emit = sink.emit.bind(sink);
    let first = true;
    sink.emit = (name, attributes, fields) => {
      emit(name, attributes, fields);
      if (first) {
        first = false;
        clock.now += 4;
        probe.end(token);
      }
    };
    probe.record(3);
    await vi.advanceTimersByTimeAsync(400);

    core.collect(false);

    // The emit zeroed the slot before calling out, so end()'s value starts a new interval.
    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 3 });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted).toHaveLength(2);
    expect(emitted[1].fields).toMatchObject({
      "metric.start_time_unix_nano": `${String(T0 + 400)}000000`,
      "metric.count": 1,
      "metric.sum": 4,
    });
  });

  it("stops the emits of a collect when an emit calls detach", () => {
    const { core, sink, emitted } = attached();
    const emit = sink.emit.bind(sink);
    sink.emit = (name, attributes, fields) => {
      emit(name, attributes, fields);
      core.detach();
    };
    core.probe("a").record(1);
    core.probe("b").record(2);

    core.collect(false);

    expect(emitted.map(({ attributes }) => attributes["profile.probe"])).toEqual(["a"]);
  });

  it("drops the waiting data in detach", () => {
    const { core, sink, emitted } = timed();
    core.probe("a").record(1);

    core.detach();
    core.attach(sink);
    core.collect(false);

    expect(emitted).toEqual([]);
  });

  it("clears the timer in detach", async () => {
    const { core, emitted } = timed();
    core.probe("a").record(1);

    core.detach();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(emitted).toEqual([]);
  });

  it("drops the waiting data in reset", () => {
    const { core, emitted } = timed();
    core.probe("a").record(1);

    core.reset();
    core.collect(false);

    expect(emitted).toEqual([]);
  });

  it("clears the timer in reset", async () => {
    const { core, emitted } = timed();
    core.probe("a").record(1);

    core.reset();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(emitted).toEqual([]);
  });

  it("clears the count of bad tokens in reset", () => {
    const { core, countSpy } = timed();
    core.probe("a").end(asNumber("bad"));

    core.reset();
    core.collect(false);

    expect(bulkCounts(countSpy)).toEqual([]);
  });

  it("keeps the profiler on after a reset", () => {
    const { core, emitted, clock } = timed();
    const probe = core.probe("a");

    core.reset();
    // The span has to begin after the reset's clock value.
    clock.now += 1;
    span(clock, probe, 3);
    core.collect(false);

    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 3 });
  });

  it("keeps the waiting data for an attach with the same capacity", () => {
    const { core, sink } = attached(4);
    const other: Emitted[] = [];
    core.probe("a").record(4);

    core.attach({
      ...sink,
      emit: (name, attributes, fields) => {
        other.push({ name, attributes: { ...attributes }, fields: { ...fields } });
      },
    });
    core.collect(false);

    expect(other).toHaveLength(1);
    expect(other[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 4 });
  });

  it("starts with empty data for an attach with another capacity", () => {
    const { core, sink, emitted } = attached(4);
    const probe = core.probe("a");
    probe.record(4);

    core.attach({ ...sink, capacity: 2 });
    core.collect(false);

    expect(emitted).toEqual([]);

    // The probe still measures in the new arrays.
    probe.record(6);
    core.collect(false);

    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 6 });
  });
});

describe("overhead calibration", () => {
  /** The clock steps by 0.25 ms per read, which gives the calibration an exact result. */
  const STEP = 0.25;

  it("measures the cost of one pair in whole nanoseconds in a timed collect", async () => {
    const { core, emitted, spy } = timed();
    spy.mockImplementation(steppingClock(1000, STEP));

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    // The edge is read 1, at 1000.25. Pair 4 is the first whose token is above 1002.25: that is
    // read 10, at 1002.5. So the result is round(2.25 * 1e6 / 4) ns.
    expect(emitted[0].attributes["profile.overhead_ns"]).toBe(562_500);
    expect(Number.isInteger(emitted[0].attributes["profile.overhead_ns"])).toBe(true);
    // One read for `first`, one for the edge, and 2 for each of the 5 pairs.
    expect(spy).toHaveBeenCalledTimes(12);
  });

  it("rounds the cost of one pair to whole nanoseconds", async () => {
    const { core, emitted, spy } = timed();
    spy.mockImplementation(steppingClock(1000, 0.3125));

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    // The edge is 1000.3125. Pair 3 is the first whose token is above 1002.3125, at 1002.5.
    // That is 2.1875 * 1e6 / 3 = 729166.67 ns, which the code rounds.
    expect(emitted[0].attributes["profile.overhead_ns"]).toBe(729_167);
    expect(spy).toHaveBeenCalledTimes(10);
  });

  it("arms no timer in the calibration", async () => {
    const { core, spy } = timed();
    spy.mockImplementation(steppingClock(1000, STEP));

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the start time of the interval in the calibration", async () => {
    const { core, emitted, spy } = timed();
    spy.mockImplementation(steppingClock(1000, STEP));

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    // Calibration runs at T0 + 1000, but the interval starts with the first value, at T0.
    expect(emitted[0].fields["metric.start_time_unix_nano"]).toBe(`${String(T0)}000000`);
  });

  it("leaves no data of the calibration in a record", async () => {
    const { core, emitted, spy } = timed();
    spy.mockImplementation(steppingClock(1000, STEP));

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    // Only probe a has a record. Slot 0 never emits.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 2 });

    // Calibration left nothing behind in slot 0, so the next value starts a clean interval.
    core.probe("b").record(5);
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted).toHaveLength(2);
    expect(emitted[1].fields).toMatchObject({
      "metric.start_time_unix_nano": `${String(T0 + 1000)}000000`,
      "metric.count": 1,
      "metric.sum": 5,
    });
  });

  it("does not calibrate in collect(false)", () => {
    const { core, emitted, spy } = timed();

    core.probe("a").record(2);
    core.collect(false);

    expect(spy).not.toHaveBeenCalled();
    expect(emitted[0].attributes).not.toHaveProperty("profile.overhead_ns");
  });

  it("does not calibrate in a timed collect with no data", () => {
    const { core, emitted, spy } = timed();
    core.probe("a");

    core.collect(true);

    expect(spy).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("finds the data of a probe in a later slot before it calibrates", () => {
    const { core, emitted, spy } = timed();
    spy.mockImplementation(steppingClock(1000, STEP));
    core.probe("a");
    core.probe("b");
    core.probe("c").record(2);

    core.collect(true);

    expect(emitted[0].attributes["profile.overhead_ns"]).toBe(562_500);
  });

  it("sets no overhead value for a frozen clock", async () => {
    const { core, emitted, spy } = timed();

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    // One read for `first`, then 100,000 looking for an edge. No edge means no pair loop.
    expect(spy).toHaveBeenCalledTimes(100_001);
    expect(emitted[0].attributes).not.toHaveProperty("profile.overhead_ns");
    expect(emitted[0].fields).toMatchObject({ "metric.count": 1, "metric.sum": 2 });
  });

  it("sets no overhead value when the clock ticks only after the alignment reads", async () => {
    const { core, emitted, spy } = timed();
    // The clock reads 1000 for reads 0 to 200,000 and 1100 from read 200,001 on. If the pair loop
    // ran, that read would be the begin of pair 50,000.
    let index = 0;
    spy.mockImplementation(() => (index++ <= 200_000 ? 1000 : 1100));

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted[0].attributes).not.toHaveProperty("profile.overhead_ns");
    // The reads stop after the alignment loop, so the pair loop never ran.
    expect(spy).toHaveBeenCalledTimes(100_001);
  });

  it("does not calibrate again after a calibration that set no value", async () => {
    const { core, emitted, spy } = timed();
    const probe = core.probe("a");
    probe.record(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitted[0].attributes).not.toHaveProperty("profile.overhead_ns");

    // A clock that moves again doesn't trigger a second calibration.
    spy.mockClear();
    spy.mockImplementation(steppingClock(1000, STEP));
    probe.record(3);
    await vi.advanceTimersByTimeAsync(1000);

    expect(spy).not.toHaveBeenCalled();
    expect(emitted[1].attributes).not.toHaveProperty("profile.overhead_ns");
  });

  it("keeps the calibration for the first timed collect with data", () => {
    const { core, emitted, spy } = timed();
    const probe = core.probe("a");

    core.collect(true);
    spy.mockImplementation(steppingClock(1000, STEP));
    probe.record(2);
    core.collect(true);

    expect(emitted[0].attributes["profile.overhead_ns"]).toBe(562_500);
  });

  it("sets no value for a clock that ticks only at pair 0", async () => {
    const { core, emitted, spy } = timed();
    // The edge is 1001 and the first begin reads 1002. After that the clock stays at 1002.
    spy.mockImplementation(sequenceClock([1000, 1001, 1002]));

    core.probe("a").record(2);
    await vi.advanceTimersByTimeAsync(1000);

    // One read for `first`, one for the edge, and 2 for each of the 100,000 pairs.
    expect(spy).toHaveBeenCalledTimes(200_002);
    expect(emitted[0].attributes).not.toHaveProperty("profile.overhead_ns");
  });

  it("does not calibrate again after a value is set", async () => {
    const { core, emitted, spy } = timed();
    spy.mockImplementation(steppingClock(1000, STEP));
    const probe = core.probe("a");

    probe.record(2);
    await vi.advanceTimersByTimeAsync(1000);
    spy.mockClear();
    probe.record(3);
    await vi.advanceTimersByTimeAsync(1000);

    expect(spy).not.toHaveBeenCalled();
    expect(emitted[1].attributes["profile.overhead_ns"]).toBe(562_500);
  });
});

describe("profilerCore", () => {
  const store = globalThis as Record<symbol, unknown>;

  it("returns the same core for each call", () => {
    const first = profilerCore();

    expect(profilerCore()).toBe(first);
    expect(first).toBeInstanceOf(ProfilerCore);
    expect(profilerCore().probe("a")).toBe(first.probe("a"));
  });

  it("pins the core on the global symbol of the library version", () => {
    const first = profilerCore();

    expect(store[CORE_KEY]).toBe(first);
    expect(CORE_KEY.description).toBe(`ui-observability.profiler@${TELEMETRY_SDK_VERSION}`);
  });

  it("returns a new core after the global symbol is removed", () => {
    const first = profilerCore();

    Reflect.deleteProperty(globalThis, CORE_KEY);
    const second = profilerCore();

    expect(second).not.toBe(first);
    expect(store[CORE_KEY]).toBe(second);
  });

  it("returns the core that a copy of the same version pinned", () => {
    const copy = { probe: vi.fn() };
    store[CORE_KEY] = copy;

    expect(profilerCore()).toBe(copy);
    expect(copy).not.toBeInstanceOf(ProfilerCore);
  });
});

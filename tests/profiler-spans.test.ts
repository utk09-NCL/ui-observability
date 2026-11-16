// tests/profiler-spans.test.ts
//
// Tests for the profiler core's span features: self time, async probes, time(),
// endAfterPaint(), the breadcrumb threshold and the recent-span ring.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PROFILER_RING_SPANS, PROFILER_STACK_DEPTH, TELEMETRY_SDK_VERSION } from "../src/constants";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { bucketOf, upperOf } from "../src/core/profile-buckets";
import { ProfilerCore, type ProfilerSink } from "../src/core/profiler";
import type { Probe, ProbeOptions } from "../src/models/metric";

/** Global symbol for this library version's core. */
const CORE_KEY = Symbol.for(`ui-observability.profiler@${TELEMETRY_SDK_VERSION}`);

/** One record the sink received. */
interface Emitted {
  attributes: Record<string, unknown>;
  fields: Record<string, unknown>;
}

/** Every core the tests created. Teardown detaches each one. */
const cores: ProfilerCore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const core of cores.splice(0)) {
    core.detach();
  }
  Reflect.deleteProperty(globalThis, CORE_KEY);
  vi.useRealTimers();
});

/**
 * Builds an attached core with a clock the test sets by hand.
 * @param capacity The sink's probe limit.
 * @returns The core, the sink, the clock and what the sink collects.
 */
function setup(capacity = 8) {
  const events: DiagnosticEvent[] = [];
  const emitted: Emitted[] = [];
  const outliers: [string, number][] = [];
  const clock = { now: 100 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const sink: ProfilerSink = {
    capacity,
    intervalMs: () => 600_000,
    emit: (_name, attributes, fields) => {
      emitted.push({ attributes: { ...attributes }, fields: { ...fields } });
    },
    diagnostics,
    ready: () => true,
    outlier: (name, ms) => {
      outliers.push([name, ms]);
    },
  };
  const core = new ProfilerCore();
  cores.push(core);
  core.attach(sink);

  /** Collects, then returns each probe's record attributes and fields, keyed by probe name. */
  const records = (): Record<string, Record<string, unknown>> => {
    emitted.length = 0;
    core.collect(false);
    return Object.fromEntries(
      emitted.map(({ attributes, fields }) => [
        attributes["profile.probe"] as string,
        { ...attributes, ...fields },
      ]),
    );
  };

  return { core, sink, clock, events, emitted, outliers, diagnostics, records };
}

/**
 * The expected self p99 for a record with a single self time: the upper bound of that value's
 * bucket, capped at the largest duration.
 * @param selfMs The single self time, in ms.
 * @param maxMs The record's largest duration, in ms.
 * @returns The expected attribute value.
 */
const selfP99 = (selfMs: number, maxMs: number): number =>
  Math.min(upperOf(bucketOf(Math.ceil(selfMs * 1000))) / 1000, maxMs);

/**
 * Runs one span on the test's clock.
 * @param clock The clock object from setup().
 * @param probe The probe to time.
 * @param ms Span length in ms.
 */
function span(clock: { now: number }, probe: Probe, ms: number): void {
  const token = probe.begin();
  clock.now += ms;
  probe.end(token);
}

describe("self time", () => {
  it("gives a span with nothing nested in it a self time equal to its duration", () => {
    const { core, clock, records } = setup();

    span(clock, core.probe("a"), 5);

    expect(records().a).toMatchObject({ "metric.count": 1, "profile.self_p99": 5 });
  });

  it("takes the duration of each direct child from the self time of the parent", () => {
    const { core, clock, records } = setup();
    const parent = core.probe("parent");
    const child = core.probe("child");

    const token = parent.begin();
    clock.now += 1;
    span(clock, child, 4);
    clock.now += 2;
    span(clock, child, 16);
    clock.now += 3;
    parent.end(token);

    const got = records();
    // The parent ran for 26 ms, 20 of them inside its children.
    expect(got.parent).toMatchObject({ "metric.sum": 26, "profile.self_p99": selfP99(6, 26) });
    expect(got.child).toMatchObject({ "metric.count": 2, "metric.sum": 20 });
    expect(got.child["profile.self_p99"]).toBe(selfP99(16, 16));
  });

  it("takes only the direct child from a parent of three levels", () => {
    const { core, clock, records } = setup();
    const top = core.probe("top");
    const middle = core.probe("middle");
    const leaf = core.probe("leaf");

    const topToken = top.begin();
    clock.now += 1;
    const middleToken = middle.begin();
    clock.now += 2;
    span(clock, leaf, 8);
    middle.end(middleToken);
    clock.now += 32;
    top.end(topToken);

    const got = records();
    expect(got.leaf["profile.self_p99"]).toBe(selfP99(8, 8));
    expect(got.middle["profile.self_p99"]).toBe(selfP99(2, 10));
    // The top span ran for 43 ms, 10 of them inside the middle span.
    expect(got.top["profile.self_p99"]).toBe(selfP99(33, 43));
  });

  it("gives a recursive probe one self time per level", () => {
    const { core, clock, records } = setup();
    const probe = core.probe("tree");

    const outer = probe.begin();
    const inner = probe.begin();
    clock.now += 4;
    probe.end(inner);
    clock.now += 64;
    probe.end(outer);

    // Both spans start in the same clock tick. The self times are 4 ms and 64 ms.
    expect(records().tree).toMatchObject({
      "metric.count": 2,
      "metric.sum": 72,
      "profile.self_p99": selfP99(64, 68),
    });
  });

  it("adds the child time of a span that never got end() to the span below it", () => {
    const { core, clock, records } = setup();
    const parent = core.probe("parent");
    const lost = core.probe("lost");
    const child = core.probe("child");

    const token = parent.begin();
    lost.begin();
    span(clock, child, 3);
    clock.now += 7;
    parent.end(token);

    expect(records().parent["profile.self_p99"]).toBe(selfP99(7, 10));
  });

  it("drops the frame of a span with no end() when the span below it ends", () => {
    const { core, clock, records } = setup();
    const parent = core.probe("parent");

    const token = parent.begin();
    core.probe("lost").begin();
    clock.now += 2;
    parent.end(token);
    records();

    // The stack is empty again, so a new pair of spans gets the right self times.
    const next = parent.begin();
    span(clock, core.probe("child"), 4);
    clock.now += 1;
    parent.end(next);

    expect(records().parent["profile.self_p99"]).toBe(selfP99(1, 5));
  });

  it("keeps the self time of a parent when a span inside it is not sampled", () => {
    const { core, clock, records } = setup();
    const parent = core.probe("parent");
    const sampled = core.probe("sampled", { sampleEvery: 2 });
    const leaf = core.probe("leaf");

    // The sampled probe's first span is measured. Its second one isn't.
    span(clock, sampled, 1);
    const token = parent.begin();
    const skipped = sampled.begin();
    span(clock, leaf, 2);
    clock.now += 8;
    sampled.end(skipped);
    parent.end(token);

    expect(skipped).toBe(-1);
    // That makes the leaf a direct child of the parent.
    expect(records().parent["profile.self_p99"]).toBe(selfP99(8, 10));
  });

  it("reports a self time of 0 when the children ran longer than the span", () => {
    const { core, clock, records } = setup();
    const parent = core.probe("parent");

    const token = parent.begin();
    span(clock, core.probe("child"), 10);
    // The clock goes backwards, which leaves the parent shorter than its child.
    clock.now -= 5;
    parent.end(token);

    expect(records().parent).toMatchObject({ "metric.sum": 5, "profile.self_p99": 0 });
  });

  it("adds no self time for a token that has no frame", () => {
    const { core, clock, records } = setup();
    const probe = core.probe("a");

    clock.now = 130;
    probe.end(100);

    const record = records().a;
    expect(record).toMatchObject({ "metric.count": 1, "metric.sum": 30 });
    expect(record).not.toHaveProperty("profile.self_p99");
  });

  it("drops each frame when the stack is full and still measures each duration", () => {
    const { core, clock, records } = setup();
    const deep = core.probe("deep");
    const last = core.probe("last");
    const tokens: number[] = [];

    for (let index = 0; index < PROFILER_STACK_DEPTH; index++) {
      tokens.push(deep.begin());
    }
    // The stack is full. This span drops every frame and takes the first slot.
    span(clock, last, 2);
    for (const token of tokens) {
      deep.end(token);
    }

    const got = records();
    expect(got.last["profile.self_p99"]).toBe(2);
    expect(got.deep).toMatchObject({ "metric.count": PROFILER_STACK_DEPTH });
    expect(got.deep).not.toHaveProperty("profile.self_p99");

    // A later pair of spans gets a self time again.
    span(clock, deep, 4);
    expect(records().deep["profile.self_p99"]).toBe(4);
  });

  it.each([
    ["a reset", (core: ProfilerCore): void => core.reset()],
    [
      "a detach and a new attach",
      (core: ProfilerCore, sink: ProfilerSink): void => {
        core.detach();
        core.attach(sink);
      },
    ],
  ])("drops the open frames and the self times at %s", (_label, restart) => {
    const { core, sink, clock, records } = setup();
    const parent = core.probe("parent");
    const child = core.probe("child");

    span(clock, child, 1);
    parent.begin();
    restart(core, sink);
    clock.now += 1;

    // The parent's old frame is gone, so the child no longer counts as its child.
    const token = parent.begin();
    span(clock, child, 4);
    clock.now += 2;
    parent.end(token);

    const got = records();
    expect(got.parent).toMatchObject({ "metric.count": 1, "profile.self_p99": selfP99(2, 6) });
    expect(got.child).toMatchObject({ "metric.count": 1, "profile.self_p99": 4 });
  });

  it("starts a new interval of self times after each collect", () => {
    const { core, clock, records } = setup();
    const probe = core.probe("a");

    span(clock, probe, 64);
    expect(records().a["profile.self_p99"]).toBe(64);

    span(clock, probe, 2);
    expect(records().a["profile.self_p99"]).toBe(2);
  });

  it("adds no self time for record()", () => {
    const { core, records } = setup();

    core.probe("a").record(5);

    expect(records().a).not.toHaveProperty("profile.self_p99");
  });
});

describe("async probe", () => {
  it("reports the total time and no self time", () => {
    const { core, clock, records } = setup();

    span(clock, core.probe("load", { async: true }), 40);

    const record = records().load;
    expect(record).toMatchObject({ "metric.count": 1, "metric.sum": 40 });
    expect(record).not.toHaveProperty("profile.self_p99");
  });

  it("takes no time from the self time of a span around it", () => {
    const { core, clock, records } = setup();
    const parent = core.probe("parent");
    const load = core.probe("load", { async: true });

    const token = parent.begin();
    span(clock, load, 4);
    clock.now += 6;
    parent.end(token);

    expect(records().parent["profile.self_p99"]).toBe(10);
  });

  it("gets no time from a span that runs before its end", () => {
    const { core, clock, records } = setup();
    const load = core.probe("load", { async: true });

    const token = load.begin();
    span(clock, core.probe("other"), 8);
    load.end(token);

    const got = records();
    expect(got.other["profile.self_p99"]).toBe(8);
    expect(got.load).toMatchObject({ "metric.sum": 8 });
  });

  it("drops a span that began at or before a reset", () => {
    const { core, clock, records } = setup();
    const load = core.probe("load", { async: true });

    const token = load.begin();
    core.reset();
    clock.now += 5;
    load.end(token);

    expect(records()).toEqual({});
  });

  it("counts an invalid token", () => {
    const { core, diagnostics } = setup();
    const count = vi.spyOn(diagnostics, "count");

    core.probe("load", { async: true }).end("x" as unknown as number);
    core.collect(false);

    expect(count).toHaveBeenCalledWith("record.dropped_malformed", 1);
  });

  it.each([["yes"], [1], [null]])("reports an async option of %j and uses false", (value) => {
    const { core, clock, events, diagnostics, records } = setup();

    const probe = core.probe("a", { async: value } as unknown as ProbeOptions, diagnostics);
    span(clock, probe, 2);

    expect(events.map(({ code, message }) => [code, message])).toEqual([
      [
        "config.invalid",
        "The async option of the probe a must be a boolean. The library uses false.",
      ],
    ]);
    expect(records().a["profile.self_p99"]).toBe(2);
  });

  it("keeps an async option of false with no report", () => {
    const { core, clock, events, diagnostics, records } = setup();

    span(clock, core.probe("a", { async: false }, diagnostics), 2);

    expect(events).toEqual([]);
    expect(records().a["profile.self_p99"]).toBe(2);
  });
});

describe("slowMs breadcrumb", () => {
  it("tells the sink about a span that is longer than the threshold", () => {
    const { core, clock, outliers } = setup();
    const probe = core.probe("sort", { slowMs: 16 });

    span(clock, probe, 16);
    expect(outliers).toEqual([]);

    span(clock, probe, 16.5);
    expect(outliers).toEqual([["sort", 16.5]]);
  });

  it("uses the threshold for record() and for an async probe", () => {
    const { core, clock, outliers } = setup();

    core.probe("a", { slowMs: 0 }).record(3);
    span(clock, core.probe("b", { slowMs: 1, async: true }), 2);

    expect(outliers).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });

  it("tells the sink nothing for a probe with no threshold", () => {
    const { core, clock, outliers } = setup();

    span(clock, core.probe("a"), 60_000);

    expect(outliers).toEqual([]);
  });

  it("tells the sink nothing for a span that ends after a detach", () => {
    const { core, sink, clock, outliers } = setup();
    const probe = core.probe("a", { slowMs: 1 });
    const token = probe.begin();
    clock.now += 5;
    // The span is still open when the profiler turns off, so its end adds nothing.
    core.detach();
    probe.end(token);
    core.attach(sink);

    expect(outliers).toEqual([]);
  });

  it.each([[-1], [Number.NaN], [Infinity], ["16"], [null]])(
    "reports a slowMs option of %j and adds no breadcrumb",
    (value) => {
      const { core, clock, events, outliers, diagnostics } = setup();

      const probe = core.probe("a", { slowMs: value } as unknown as ProbeOptions, diagnostics);
      span(clock, probe, 60_000);

      expect(events.map(({ code, message }) => [code, message])).toEqual([
        [
          "config.invalid",
          "The slowMs option of the probe a must be a finite number, 0 or larger. The probe adds no breadcrumb.",
        ],
      ]);
      expect(outliers).toEqual([]);
    },
  );

  it("reports every invalid option in a single probe() call", () => {
    const { core, events, diagnostics } = setup();

    core.probe(
      "a",
      { sampleEvery: 0, slowMs: -1, async: 0 } as unknown as ProbeOptions,
      diagnostics,
    );

    expect(events.map(({ message }) => message.slice(0, 22))).toEqual([
      "The sampleEvery option",
      "The slowMs option of t",
      "The async option of th",
    ]);
  });

  it("uses each default when the options throw", () => {
    const { core, clock, events, outliers, diagnostics, records } = setup();
    const error = new Error("hostile options");
    const options: ProbeOptions = {
      sampleEvery: 2,
      slowMs: 0,
      get async(): boolean {
        throw error;
      },
    };

    const probe = core.probe("a", options, diagnostics);
    span(clock, probe, 3);
    span(clock, probe, 3);

    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      [
        "config.invalid",
        "The library could not read the options of the probe a. The library uses the defaults.",
        error,
      ],
    ]);
    // Period 1, no threshold, and the spans are on the stack.
    expect(outliers).toEqual([]);
    expect(records().a).toMatchObject({ "metric.count": 2, "profile.self_p99": 3 });
  });
});

describe("time", () => {
  it("returns the result of a function and times the call", () => {
    const { core, clock, records } = setup();

    const result = core.time("sum", () => {
      clock.now += 4;
      return 42;
    });

    expect(result).toBe(42);
    expect(records().sum).toMatchObject({
      "metric.count": 1,
      "metric.sum": 4,
      "profile.self_p99": 4,
    });
  });

  it("puts the call on the span stack", () => {
    const { core, clock, records } = setup();
    const parent = core.probe("parent");

    const token = parent.begin();
    core.time("inner", () => {
      clock.now += 3;
    });
    clock.now += 5;
    parent.end(token);

    expect(records().parent["profile.self_p99"]).toBe(selfP99(5, 8));
  });

  it("ends the span and gives the error to the caller when the function throws", () => {
    const { core, clock, events, diagnostics, records } = setup();
    const error = new Error("app error");

    expect(() =>
      core.time(
        "risky",
        () => {
          clock.now += 2;
          throw error;
        },
        diagnostics,
      ),
    ).toThrow(error);

    expect(records().risky).toMatchObject({ "metric.count": 1, "metric.sum": 2 });
    // The error is the app's, so the library reports nothing.
    expect(events).toEqual([]);
  });

  it("ends the span of a promise when the promise resolves", async () => {
    const { core, clock, records } = setup();
    let finish: (value: string) => void = () => undefined;
    const parent = core.probe("parent");

    const token = parent.begin();
    const result = core.time("load", () => {
      clock.now += 2;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    clock.now += 4;
    parent.end(token);

    // The promise's span is still open, so only the parent has a value.
    const early = records();
    expect(Object.keys(early)).toEqual(["parent"]);
    // The call ran for 2 ms before it returned the promise. The parent only loses that much.
    expect(early.parent["profile.self_p99"]).toBe(selfP99(4, 6));

    clock.now += 30;
    finish("rows");
    await expect(result).resolves.toBe("rows");

    const record = records().load;
    expect(record).toMatchObject({ "metric.count": 1, "metric.sum": 36 });
    expect(record).not.toHaveProperty("profile.self_p99");
  });

  it("ends the span of a promise that rejects and keeps the error for the caller", async () => {
    const { core, clock, records } = setup();
    const error = new Error("no rows");

    const result = core.time("load", () => Promise.reject(error));
    clock.now += 7;

    await expect(result).rejects.toBe(error);
    expect(records().load).toMatchObject({ "metric.count": 1, "metric.sum": 7 });
  });

  it("ends the span of a thenable when the thenable settles", () => {
    const { core, clock, records } = setup();
    let settle: (value: number) => void = () => undefined;
    const thenable = {
      then(resolve: (value: number) => string): string | undefined {
        let chained: string | undefined;
        settle = (value) => {
          chained = resolve(value);
        };
        return chained;
      },
    };

    core.time("job", () => thenable);
    clock.now += 9;
    settle(1);

    expect(records().job).toMatchObject({ "metric.count": 1, "metric.sum": 9 });
  });

  it("passes the promise's value to the chained result", async () => {
    const { core } = setup();
    const value = { rows: 3 };

    await expect(core.time("load", () => Promise.resolve(value))).resolves.toBe(value);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an object with a then value that is no function", { then: 1 }],
    ["a number", 7],
  ])("returns %s as it is and ends the span right away", (_label, value) => {
    const { core, clock, records } = setup();

    const result = core.time("plain", () => {
      clock.now += 1;
      return value;
    });

    expect(result).toBe(value);
    expect(records().plain).toMatchObject({ "metric.count": 1, "metric.sum": 1 });
  });

  it("reports a then getter that throws and ends the span right away", () => {
    const { core, clock, events, diagnostics, records } = setup();
    const error = new Error("hostile then");
    const hostile = {
      get then(): never {
        throw error;
      },
    };

    const result = core.time(
      "odd",
      () => {
        clock.now += 2;
        return hostile;
      },
      diagnostics,
    );

    expect(result).toBe(hostile);
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      [
        "capture.record_failed",
        "The library could not read what the function of the probe odd returned. The span ends now.",
        error,
      ],
    ]);
    expect(records().odd).toMatchObject({ "metric.count": 1, "metric.sum": 2 });
  });

  it("ends the span once when the then function throws", () => {
    const { core, clock, events, records } = setup();
    const hostile = {
      then(): never {
        throw new Error("hostile then");
      },
    };

    // No diagnostics on this call, so it reports nothing. It must not throw either.
    const result = core.time("odd", () => {
      clock.now += 2;
      return hostile;
    });

    expect(result).toBe(hostile);
    expect(events).toEqual([]);
    expect(records().odd).toMatchObject({ "metric.count": 1, "metric.sum": 2 });
  });

  it("calls the function with no span while the profiler is off", async () => {
    const { core } = setup();
    const promise = Promise.resolve(1);
    core.detach();
    const clockReads = vi.mocked(performance.now).mock.calls.length;

    // Without a span the caller gets the function's own promise back.
    expect(core.time("load", () => promise)).toBe(promise);
    expect(vi.mocked(performance.now).mock.calls).toHaveLength(clockReads);
    await promise;
  });

  it.each([
    ["a name that is not valid", "", 8],
    ["a probe above the limit", "second", 1],
  ])("calls the function with no span for %s", (_label, name, capacity) => {
    const { core, records } = setup(capacity);
    core.probe("first");

    expect(core.time(name, () => "done")).toBe("done");
    expect(records()).toEqual({});
  });

  it("sends the options report for a new name to the call's diagnostics", () => {
    const { core, events, diagnostics } = setup();

    core.time("", () => undefined, diagnostics);

    expect(events.map(({ message }) => message)).toEqual([
      "The probe name must be a string that is not empty. The probe does nothing.",
    ]);
  });
});

/** Stubs a page's frame callback, message channel and document. */
function stubPage(visibilityState = "visible") {
  const frames: (() => void)[] = [];
  const posted: number[] = [];
  const listeners: (() => void)[] = [];
  const channels: FakeChannel[] = [];
  const page = {
    visibilityState,
    addEventListener: (type: string, listener: () => void) => {
      expect(type).toBe("visibilitychange");
      listeners.push(listener);
    },
  };

  class FakeChannel {
    port1: { onmessage: (() => void) | null } = { onmessage: null };

    port2 = {
      postMessage: (value: number) => {
        posted.push(value);
      },
    };

    constructor() {
      channels.push(this);
    }
  }

  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("MessageChannel", FakeChannel);
  vi.stubGlobal("document", page);

  /** Runs the pending frame callbacks, then the task they posted. */
  const paint = (): void => {
    for (const frame of frames.splice(0)) {
      frame();
    }
    for (const _ of posted.splice(0)) {
      channels[0].port1.onmessage?.();
    }
  };

  return { frames, posted, listeners, channels, page, paint };
}

describe("endAfterPaint", () => {
  it("ends the span in the first task after the next paint", () => {
    const { core, clock, records } = setup();
    const { frames, posted, paint } = stubPage();
    const probe = core.probe("render");

    const token = probe.begin();
    clock.now += 4;
    probe.endAfterPaint(token);

    expect(frames).toHaveLength(1);
    expect(records()).toEqual({});

    // The frame callback runs before the paint. All it does is post the task.
    frames[0]();
    expect(posted).toEqual([0]);
    expect(records()).toEqual({});

    clock.now += 12;
    paint();

    const record = records().render;
    expect(record).toMatchObject({ "metric.count": 1, "metric.sum": 16 });
    expect(record).not.toHaveProperty("profile.self_p99");
  });

  it("counts the time before the call toward the self time of the surrounding span", () => {
    const { core, clock, records } = setup();
    const { paint } = stubPage();
    const parent = core.probe("parent");
    const render = core.probe("render");

    const token = parent.begin();
    const inner = render.begin();
    clock.now += 4;
    render.endAfterPaint(inner);
    clock.now += 2;
    parent.end(token);
    clock.now += 10;
    paint();

    const got = records();
    expect(got.parent["profile.self_p99"]).toBe(selfP99(2, 6));
    expect(got.render).toMatchObject({ "metric.sum": 16 });
  });

  it("uses one frame callback and one channel for the spans of one frame", () => {
    const { core, clock, records } = setup();
    const { frames, channels, paint } = stubPage();
    const probe = core.probe("render");

    probe.endAfterPaint(probe.begin());
    clock.now += 1;
    probe.endAfterPaint(probe.begin());
    expect(frames).toHaveLength(1);

    clock.now += 7;
    paint();
    expect(records().render).toMatchObject({ "metric.count": 2, "metric.sum": 15 });

    // A span after the paint requests a new frame callback. The channel is reused.
    probe.endAfterPaint(probe.begin());
    expect(frames).toHaveLength(1);
    clock.now += 2;
    paint();

    expect(records().render).toMatchObject({ "metric.count": 1, "metric.sum": 2 });
    expect(channels).toHaveLength(1);
  });

  it("tells the sink about a span that is longer than the threshold after the paint", () => {
    const { core, clock, outliers } = setup();
    const { paint } = stubPage();
    const probe = core.probe("render", { slowMs: 16 });

    probe.endAfterPaint(probe.begin());
    clock.now += 50;
    paint();

    expect(outliers).toEqual([["render", 50]]);
  });

  it("waits for the paint with an async probe", () => {
    const { core, clock, records } = setup();
    const { paint } = stubPage();
    const probe = core.probe("load", { async: true });

    const token = probe.begin();
    clock.now += 3;
    probe.endAfterPaint(token);
    clock.now += 5;
    paint();

    expect(records().load).toMatchObject({ "metric.count": 1, "metric.sum": 8 });
  });

  it.each([
    [
      "a context with no frame callback",
      (): void => {
        vi.stubGlobal("requestAnimationFrame", undefined);
      },
    ],
    [
      "a context with no message channel",
      (): void => {
        vi.stubGlobal("MessageChannel", undefined);
      },
    ],
    [
      "a hidden page",
      (page: { visibilityState: string }): void => {
        page.visibilityState = "hidden";
      },
    ],
  ])("ends the span right away in %s", (_label, change) => {
    const { core, clock, records } = setup();
    const { frames, page } = stubPage();
    change(page);
    const probe = core.probe("render");

    const token = probe.begin();
    clock.now += 4;
    probe.endAfterPaint(token);

    expect(frames).toEqual([]);
    expect(records().render).toMatchObject({ "metric.sum": 4, "profile.self_p99": 4 });
  });

  it("waits for the paint in a context with no document", () => {
    const { core, clock, records } = setup();
    const { paint } = stubPage();
    vi.stubGlobal("document", undefined);
    const probe = core.probe("render");

    probe.endAfterPaint(probe.begin());
    clock.now += 6;
    paint();

    expect(records().render).toMatchObject({ "metric.sum": 6 });
  });

  it("ends the waiting spans when the page becomes hidden", () => {
    const { core, clock, records } = setup();
    const { listeners, page, paint } = stubPage();
    const probe = core.probe("render");

    probe.endAfterPaint(probe.begin());
    expect(listeners).toHaveLength(1);

    // A visibility event while the page is visible doesn't end anything.
    clock.now += 2;
    listeners[0]();
    expect(records()).toEqual({});

    clock.now += 3;
    page.visibilityState = "hidden";
    listeners[0]();
    expect(records().render).toMatchObject({ "metric.count": 1, "metric.sum": 5 });

    // The frame callback runs once the page is visible again, but no span is waiting for it.
    clock.now += 60_000;
    paint();
    expect(records()).toEqual({});
  });

  it("adds one visibility listener for the life of the core", () => {
    const { core } = setup();
    const { listeners, paint } = stubPage();
    const probe = core.probe("render");

    probe.endAfterPaint(probe.begin());
    paint();
    probe.endAfterPaint(probe.begin());
    paint();

    expect(listeners).toHaveLength(1);
  });

  it.each([
    ["a reset", (core: ProfilerCore): void => core.reset()],
    ["a detach", (core: ProfilerCore): void => core.detach()],
  ])("drops a span that waits for the paint at %s", (_label, stop) => {
    const { core, sink, clock, records } = setup();
    const { paint } = stubPage();
    const probe = core.probe("render");

    probe.endAfterPaint(probe.begin());
    stop(core);
    core.attach(sink);
    clock.now += 5;
    paint();

    expect(records()).toEqual({});
  });

  it("does nothing for a span that begin() did not measure", () => {
    const { core, diagnostics, records } = setup();
    const { frames } = stubPage();
    const count = vi.spyOn(diagnostics, "count");

    core.probe("render").endAfterPaint(-1);
    core.collect(false);

    expect(frames).toEqual([]);
    expect(records()).toEqual({});
    expect(count).not.toHaveBeenCalled();
  });

  it("counts an invalid token and waits for no paint", () => {
    const { core, diagnostics } = setup();
    const { frames } = stubPage();
    const count = vi.spyOn(diagnostics, "count");

    core.probe("render").endAfterPaint("x" as unknown as number);
    core.collect(false);

    expect(frames).toEqual([]);
    expect(count).toHaveBeenCalledWith("record.dropped_malformed", 1);
  });

  it("waits for no paint while the profiler is off", () => {
    const { core, sink, records } = setup();
    const { frames } = stubPage();
    const probe = core.probe("render");

    const token = probe.begin();
    core.detach();
    probe.endAfterPaint(token);
    core.attach(sink);

    expect(frames).toEqual([]);
    expect(records()).toEqual({});
  });

  it("does nothing for a name that the core refuses", () => {
    const { core } = setup();
    const { frames } = stubPage();
    const probe = core.probe("");

    probe.endAfterPaint(probe.begin());

    expect(frames).toEqual([]);
  });
});

describe("ring of recent spans", () => {
  it("finds no probe before link() turns the ring on", () => {
    const { core, clock } = setup();

    span(clock, core.probe("a"), 50);

    expect(core.linked(0, 1000)).toEqual([]);
  });

  it("finds each probe with a span of the minimum duration in the range", () => {
    const { core, clock } = setup();
    const sort = core.probe("sort");
    const draw = core.probe("draw");
    const tiny = core.probe("tiny");
    core.link(1);

    // sort runs from 100 to 110. draw runs twice between 110 and 111. tiny runs for under 1 ms.
    span(clock, sort, 10);
    span(clock, draw, 0.5);
    span(clock, draw, 0.5);
    clock.now -= 1;
    span(clock, draw, 1);
    span(clock, tiny, 0.99);

    expect(core.linked(90, 200)).toEqual(["sort", "draw"]);
    expect(core.linked(105, 106)).toEqual(["sort"]);
    expect(core.linked(110.5, 200)).toEqual(["draw"]);
  });

  it("finds no span that only touches the range", () => {
    const { core, clock } = setup();
    core.link(1);

    span(clock, core.probe("sort"), 10);

    // The span runs from 100 to 110.
    expect(core.linked(110, 120)).toEqual([]);
    expect(core.linked(90, 100)).toEqual([]);
    expect(core.linked(109.9, 120)).toEqual(["sort"]);
  });

  it("keeps the time before endAfterPaint() and no span of an async probe or of record()", () => {
    const { core, clock } = setup();
    stubPage();
    core.link(1);
    const render = core.probe("render");

    const token = render.begin();
    clock.now += 5;
    render.endAfterPaint(token);
    span(clock, core.probe("load", { async: true }), 20);
    core.probe("timed").record(30);

    expect(core.linked(0, 1000)).toEqual(["render"]);
    // The ring only has the part from 100 to 105.
    expect(core.linked(105, 1000)).toEqual([]);
  });

  it("writes over the oldest span when the ring is full", () => {
    const { core, clock } = setup();
    const first = core.probe("first");
    const later = core.probe("later");
    core.link(1);

    span(clock, first, 2);
    for (let index = 0; index < PROFILER_RING_SPANS; index++) {
      span(clock, later, 2);
    }

    expect(core.linked(0, 1_000_000)).toEqual(["later"]);
  });

  it("keeps the ring when link() changes the minimum duration", () => {
    const { core, clock } = setup();
    const probe = core.probe("sort");
    core.link(1);
    span(clock, probe, 2);

    core.link(5);
    span(clock, core.probe("short"), 4);

    expect(core.linked(0, 1000)).toEqual(["sort"]);
  });

  it("adds no span after link() turns the ring off", () => {
    const { core, clock } = setup();
    core.link(1);
    core.link(Infinity);

    span(clock, core.probe("sort"), 10);

    expect(core.linked(0, 1000)).toEqual([]);
  });

  it("does not make the ring for a link() call that turns it off", () => {
    const { core, clock } = setup();
    core.link(Infinity);
    core.link(1);

    span(clock, core.probe("sort"), 10);

    expect(core.linked(0, 1000)).toEqual(["sort"]);
  });

  it.each([
    ["a reset", (core: ProfilerCore): void => core.reset()],
    ["a detach", (core: ProfilerCore): void => core.detach()],
  ])("drops the spans of the ring at %s", (_label, stop) => {
    const { core, clock } = setup();
    core.link(1);
    span(clock, core.probe("sort"), 10);

    stop(core);

    expect(core.linked(0, 1000)).toEqual([]);
  });
});

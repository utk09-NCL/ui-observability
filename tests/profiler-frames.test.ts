// tests/profiler-frames.test.ts
//
// Tests for the profiler's two observers. The frame phases capture attributes a long animation frame's
// phases to every probe in the frame, and frame pacing measures the intervals between frames.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FramePhasesCapture, FramePacingCapture } from "../src/capture/profiler-frames";
import type { CaptureContext, CaptureLogger, CaptureOnce } from "../src/capture/types";
import { TELEMETRY_SDK_VERSION } from "../src/constants";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { profilerCore, type ProfilerSink } from "../src/core/profiler";
import type { Probe } from "../src/models/metric";
import { TraceEngine } from "../src/utils/tracing";

/** Global symbol for this library version's core. */
const CORE_KEY = Symbol.for(`ui-observability.profiler@${TELEMETRY_SDK_VERSION}`);

/** Fake PerformanceObserver. A test calls emit() to deliver entries. */
class FakeObserver {
  static supportedEntryTypes: readonly string[] | undefined = [];

  static created: FakeObserver[] = [];

  options: { type: string; buffered?: boolean } | undefined;

  disconnected = false;

  constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {
    FakeObserver.created.push(this);
  }

  observe(options: { type: string; buffered?: boolean }): void {
    this.options = options;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(...entries: unknown[]): void {
    this.callback({ getEntries: () => entries });
  }
}

/**
 * Stubs PerformanceObserver with a given list of supported entry types.
 * @param types Supported entry types, or undefined to act like an old browser.
 */
function support(types: readonly string[] | undefined): void {
  FakeObserver.supportedEntryTypes = types;
  vi.stubGlobal("PerformanceObserver", FakeObserver);
}

/** The `once` flags of a fresh document. */
const freshOnce = (): CaptureOnce => ({
  webVitals: false,
  navigationTiming: false,
  longFrames: false,
  uncleanExit: false,
  userTiming: false,
});

/**
 * Builds a capture context and attaches this library version's profiler core.
 * @param once The `once` flags. Two captures sharing one object behave like a reinstall in the
 * same document.
 * @param framesPerWindow Value for capturePolicy.longFramesPerWindow.
 * @returns The context, the spy metric logger, the clock, the events and the profiler records.
 */
function setup(once = freshOnce(), framesPerWindow = 20) {
  const events: DiagnosticEvent[] = [];
  const emitted: Record<string, unknown>[] = [];
  const clock = { now: 100 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const logMetric = vi.fn<CaptureLogger["logMetric"]>();
  const ctx: CaptureContext = {
    config: resolveConfig(
      {
        endpoint: null,
        serviceName: "svc",
        capturePolicy: { longFramesPerWindow: framesPerWindow },
      },
      diagnostics,
    ),
    diagnostics,
    logger: { error: vi.fn(), warn: vi.fn(), logEvent: vi.fn(), logMetric, debug: vi.fn() },
    breadcrumbs: new BreadcrumbBuffer(50),
    tracing: new TraceEngine(diagnostics),
    once,
    recordMetric: vi.fn(),
    recordSpan: vi.fn(),
    sessionId: () => "session",
  };
  const sink: ProfilerSink = {
    capacity: 8,
    intervalMs: () => 600_000,
    emit: (_name, attributes, fields) => {
      emitted.push({ ...attributes, ...fields });
    },
    diagnostics,
    ready: () => true,
    outlier: () => undefined,
  };
  const core = profilerCore();
  core.attach(sink);
  events.length = 0;

  /** Collects and returns the profiler records. */
  const records = (): Record<string, unknown>[] => {
    emitted.length = 0;
    core.collect(false);
    return [...emitted];
  };

  return { ctx, core, clock, events, logMetric, records };
}

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

/** Returns the phase and value of every metric call for one probe. */
const phasesOf = (
  logMetric: ReturnType<typeof vi.fn<CaptureLogger["logMetric"]>>,
  probe: string,
): [unknown, number][] =>
  logMetric.mock.calls
    .filter(([, , , , attrs]) => attrs?.["profile.probe"] === probe)
    .map(([, value, , , attrs]) => [attrs?.["profile.frame_phase"], value]);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  profilerCore().detach();
  profilerCore().link(Infinity);
  Reflect.deleteProperty(globalThis, CORE_KEY);
  FakeObserver.created = [];
});

describe("FramePhasesCapture", () => {
  it("observes long animation frames with no buffered entries", () => {
    support(["longtask", "long-animation-frame"]);
    const { ctx } = setup();
    const sut = new FramePhasesCapture(ctx);

    sut.install();
    sut.install();

    expect(FakeObserver.created).toHaveLength(1);
    // Not buffered: a buffered frame is older than anything in the ring.
    expect(FakeObserver.created[0].options).toEqual({ type: "long-animation-frame" });
  });

  it.each([
    [
      "has no PerformanceObserver",
      (): void => {
        vi.stubGlobal("PerformanceObserver", undefined);
      },
    ],
    ["has no list of entry types", (): void => support(undefined)],
    ["reports only long tasks", (): void => support(["longtask"])],
  ])("reports once and stays off in a browser that %s", (_label, stub) => {
    stub();
    const once = freshOnce();
    const { ctx, core, clock, events } = setup(once);

    new FramePhasesCapture(ctx).install();
    // A second capture with the same flags stands in for a reinstall after configure().
    new FramePhasesCapture(ctx).install();
    span(clock, core.probe("sort"), 10);

    expect(events.map(({ code, message }) => [code, message])).toEqual([
      [
        "capture.install_failed",
        "The browser does not report long animation frames. profiler.framePhases is off.",
      ],
    ]);
    expect(FakeObserver.created).toEqual([]);
    expect(core.linked(0, 1000)).toEqual([]);
  });

  it("adds each phase of a frame to the probe with a span in the frame", () => {
    support(["long-animation-frame"]);
    const { ctx, core, clock, logMetric } = setup();
    new FramePhasesCapture(ctx).install();

    // The span runs from 100 to 140, the frame from 90 to 190.
    span(clock, core.probe("sort"), 40);
    FakeObserver.created[0].emit({
      startTime: 90,
      duration: 100,
      renderStart: 150,
      styleAndLayoutStart: 172,
      scripts: [
        { forcedStyleAndLayoutDuration: 5 },
        { forcedStyleAndLayoutDuration: 7 },
        { duration: 3 },
      ],
    });

    expect(logMetric.mock.calls).toEqual([
      [
        "ui.profile.frame.duration",
        60,
        "ms",
        "histogram",
        { "profile.probe": "sort", "profile.frame_phase": "script" },
      ],
      [
        "ui.profile.frame.duration",
        22,
        "ms",
        "histogram",
        { "profile.probe": "sort", "profile.frame_phase": "render" },
      ],
      [
        "ui.profile.frame.duration",
        18,
        "ms",
        "histogram",
        { "profile.probe": "sort", "profile.frame_phase": "style_layout" },
      ],
      [
        "ui.profile.frame.duration",
        12,
        "ms",
        "histogram",
        { "profile.probe": "sort", "profile.frame_phase": "forced_layout" },
      ],
    ]);
  });

  it.each([
    ["has 0 in the render fields", { renderStart: 0, styleAndLayoutStart: 0, scripts: [] }],
    ["has no render fields and no scripts", {}],
  ])("counts the whole frame as script when the frame %s", (_label, fields) => {
    support(["long-animation-frame"]);
    const { ctx, core, clock, logMetric } = setup();
    new FramePhasesCapture(ctx).install();

    span(clock, core.probe("sort"), 40);
    FakeObserver.created[0].emit({ startTime: 100, duration: 80, ...fields });

    expect(phasesOf(logMetric, "sort")).toEqual([
      ["script", 80],
      ["render", 0],
      ["style_layout", 0],
      ["forced_layout", 0],
    ]);
  });

  it("counts the time after the render start as render when there is no layout start", () => {
    support(["long-animation-frame"]);
    const { ctx, core, clock, logMetric } = setup();
    new FramePhasesCapture(ctx).install();

    span(clock, core.probe("sort"), 40);
    FakeObserver.created[0].emit({ startTime: 100, duration: 80, renderStart: 150 });

    expect(phasesOf(logMetric, "sort")).toEqual([
      ["script", 50],
      ["render", 30],
      ["style_layout", 0],
      ["forced_layout", 0],
    ]);
  });

  it("adds the phases to each probe in the frame and to no other probe", () => {
    support(["long-animation-frame"]);
    const { ctx, core, clock, logMetric } = setup();
    new FramePhasesCapture(ctx).install();
    const outer = core.probe("apply");

    const token = outer.begin();
    span(clock, core.probe("sort"), 30);
    outer.end(token);
    // This span runs from 130 to 170, which is after the first frame.
    span(clock, core.probe("later"), 40);
    // This span is under 1 ms, so the ring doesn't keep it.
    clock.now = 110;
    span(clock, core.probe("tiny"), 0.5);

    FakeObserver.created[0].emit({ startTime: 60, duration: 70 }, { startTime: 400, duration: 60 });

    expect(phasesOf(logMetric, "apply")).toHaveLength(4);
    expect(phasesOf(logMetric, "sort")).toHaveLength(4);
    expect(logMetric).toHaveBeenCalledTimes(8);
  });

  it("stops at the frame limit of the window and reports it", () => {
    support(["long-animation-frame"]);
    const { ctx, core, clock, events, logMetric } = setup(freshOnce(), 1);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    new FramePhasesCapture(ctx).install();

    span(clock, core.probe("sort"), 40);
    // A frame without a probe doesn't count against the limit.
    FakeObserver.created[0].emit({ startTime: 500, duration: 60 });
    FakeObserver.created[0].emit({ startTime: 100, duration: 60 });
    FakeObserver.created[0].emit({ startTime: 100, duration: 60 });

    expect(logMetric).toHaveBeenCalledTimes(4);
    expect(events.map(({ code }) => code)).toEqual(["capture.rate_limited"]);
    expect(events[0].message).toContain("profiler frames");
  });

  it("reports a fault in a frame and does not throw into the browser", () => {
    support(["long-animation-frame"]);
    const { ctx, core, clock, events, logMetric } = setup();
    const error = new Error("logger fault");
    logMetric.mockImplementation(() => {
      throw error;
    });
    new FramePhasesCapture(ctx).install();
    span(clock, core.probe("sort"), 40);

    expect(() => {
      FakeObserver.created[0].emit({ startTime: 100, duration: 60 });
    }).not.toThrow();

    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      [
        "capture.record_failed",
        "The library could not record a long animation frame of the profiler.",
        error,
      ],
    ]);
  });

  it("disconnects the observer and turns the ring off at uninstall", () => {
    support(["long-animation-frame"]);
    const { ctx, core, clock } = setup();
    const sut = new FramePhasesCapture(ctx);

    sut.install();
    sut.uninstall();
    span(clock, core.probe("sort"), 40);

    expect(FakeObserver.created[0].disconnected).toBe(true);
    expect(core.linked(0, 1000)).toEqual([]);

    // Installing again starts observing again.
    sut.install();
    span(clock, core.probe("sort"), 40);

    expect(FakeObserver.created).toHaveLength(2);
    expect(core.linked(0, 1000)).toEqual(["sort"]);
  });

  it("leaves the ring of another capture on at an uninstall with no install", () => {
    support(["long-animation-frame"]);
    const { ctx, core, clock } = setup();
    new FramePhasesCapture(ctx).install();

    new FramePhasesCapture(ctx).uninstall();
    span(clock, core.probe("sort"), 40);

    expect(core.linked(0, 1000)).toEqual(["sort"]);
  });
});

/** Stubs a page's frame callback. A test calls frame() to run the pending callback. */
function stubFrames(withCancel = true, withDocument = true) {
  const waiting = new Map<number, (time: number) => void>();
  const cancelled: number[] = [];
  const listeners = new Set<() => void>();
  let handles = 0;

  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    handles++;
    waiting.set(handles, callback);
    return handles;
  });
  vi.stubGlobal(
    "cancelAnimationFrame",
    withCancel
      ? (handle: number) => {
          cancelled.push(handle);
          waiting.delete(handle);
        }
      : undefined,
  );
  vi.stubGlobal(
    "document",
    withDocument
      ? {
          addEventListener: (type: string, listener: () => void) => {
            expect(type).toBe("visibilitychange");
            listeners.add(listener);
          },
          removeEventListener: (type: string, listener: () => void) => {
            expect(type).toBe("visibilitychange");
            listeners.delete(listener);
          },
        }
      : undefined,
  );

  /** Runs the pending frame callbacks with the frame's start time. */
  const frame = (time: number): void => {
    const callbacks = [...waiting.values()];
    waiting.clear();
    for (const callback of callbacks) {
      callback(time);
    }
  };

  return { waiting, cancelled, listeners, frame };
}

describe("FramePacingCapture", () => {
  it("records the time between two frames with the frame probe", () => {
    const { ctx, records } = setup();
    const { waiting, frame } = stubFrames();
    const sut = new FramePacingCapture(ctx);

    sut.install();
    sut.install();
    expect(waiting.size).toBe(1);

    // The first frame has nothing before it, so it produces no interval.
    frame(1000);
    frame(1016);
    frame(1049);

    expect(waiting.size).toBe(1);
    expect(records()).toMatchObject([
      {
        "profile.probe": "frame.interval",
        "metric.count": 2,
        "metric.sum": 49,
        "metric.min": 16,
        "metric.max": 33,
      },
    ]);
  });

  it("records no interval across a change of the page visibility", () => {
    const { ctx, records } = setup();
    const { listeners, frame } = stubFrames();
    new FramePacingCapture(ctx).install();

    frame(1000);
    frame(1016);
    // The page is hidden for 60 seconds, and a hidden page gets no frame callbacks.
    for (const listener of listeners) {
      listener();
    }
    frame(61_016);
    frame(61_032);

    expect(records()).toMatchObject([{ "metric.count": 2, "metric.sum": 32 }]);
  });

  it("stops the loop and removes its listener at uninstall", () => {
    const { ctx, records } = setup();
    const { waiting, cancelled, listeners, frame } = stubFrames();
    const sut = new FramePacingCapture(ctx);

    sut.install();
    frame(1000);
    sut.uninstall();
    sut.uninstall();

    expect(cancelled).toEqual([2]);
    expect(waiting.size).toBe(0);
    expect(listeners.size).toBe(0);

    // After a reinstall there is again no previous frame.
    sut.install();
    frame(5000);
    frame(5016);

    expect(records()).toMatchObject([{ "metric.count": 1, "metric.sum": 16 }]);
  });

  it("does nothing at an uninstall with no install", () => {
    const { ctx } = setup();
    const { cancelled } = stubFrames();

    new FramePacingCapture(ctx).uninstall();

    expect(cancelled).toEqual([]);
  });

  it("runs in a context with no document and no cancel function", () => {
    const { ctx, records } = setup();
    const { waiting, frame } = stubFrames(false, false);
    const sut = new FramePacingCapture(ctx);

    sut.install();
    frame(1000);
    frame(1008);
    sut.uninstall();

    expect(records()).toMatchObject([{ "metric.count": 1, "metric.sum": 8 }]);
    // This context can't cancel the callback, so a new install starts a second loop.
    expect(waiting.size).toBe(1);
  });

  it("reports once and stays off in a context with no frame callback", () => {
    const once = freshOnce();
    const { ctx, events, records } = setup(once);
    vi.stubGlobal("requestAnimationFrame", undefined);

    new FramePacingCapture(ctx).install();
    new FramePacingCapture(ctx).install();

    expect(events.map(({ code, message }) => [code, message])).toEqual([
      [
        "capture.install_failed",
        "This context has no frame callback. The frame pacing of the profiler is off.",
      ],
    ]);
    expect(records()).toEqual([]);
  });

  it("reports a fault in a frame and keeps the loop", () => {
    const { ctx, core, events } = setup();
    const { waiting, frame } = stubFrames();
    const error = new Error("probe fault");
    vi.spyOn(core, "probe").mockReturnValue({
      begin: () => -1,
      end: () => undefined,
      endAfterPaint: () => undefined,
      record: () => {
        throw error;
      },
    });
    new FramePacingCapture(ctx).install();

    frame(1000);
    expect(() => {
      frame(1016);
    }).not.toThrow();

    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      [
        "capture.record_failed",
        "The library could not record a frame interval of the profiler.",
        error,
      ],
    ]);
    expect(waiting.size).toBe(1);
  });

  it("sends the frame probe's limit report to the runtime's diagnostics", () => {
    const { ctx, core, events } = setup();
    stubFrames();
    for (let index = 0; index < 8; index++) {
      core.probe(`p${String(index)}`);
    }

    new FramePacingCapture(ctx).install();

    expect(events.map(({ message }) => message)).toEqual([
      "The probe frame.interval is above the profiler.maxProbes limit of 8. The probe does nothing.",
    ]);
  });
});

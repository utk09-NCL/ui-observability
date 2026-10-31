// tests/long-frames.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { LongFrameCapture } from "../src/capture/long-frames";
import type { CaptureContext, CaptureLogger, CaptureOnce } from "../src/capture/types";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { LONG_FRAME_MAX_PER_WINDOW, LONG_FRAME_THRESHOLD_MS } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { CaptureOptions } from "../src/models/config";
import { TraceEngine } from "../src/utils/tracing";

/** Stand-in for PerformanceObserver. A test calls emit() to deliver entries. */
class FakeObserver {
  static supportedEntryTypes: readonly string[] | undefined = [];

  static created: FakeObserver[] = [];

  observed: string | undefined;

  buffered: boolean | undefined;

  disconnected = false;

  constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {
    FakeObserver.created.push(this);
  }

  observe(options: { type: string; buffered?: boolean }): void {
    this.observed = options.type;
    this.buffered = options.buffered;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(...entries: unknown[]): void {
    this.callback({ getEntries: () => entries });
  }
}

/** Returns the observer that the stub created last. */
const active = (): FakeObserver | undefined => FakeObserver.created.at(-1);

/**
 * Stubs PerformanceObserver with a list of supported entry types.
 * @param types Supported entry types, or undefined for an old browser.
 */
function support(types: readonly string[] | undefined): void {
  FakeObserver.supportedEntryTypes = types;
  vi.stubGlobal("PerformanceObserver", FakeObserver);
}

/** Builds the `once` flags of a new document. */
const freshOnce = (): CaptureOnce => ({
  webVitals: false,
  navigationTiming: false,
  longFrames: false,
});

/**
 * Builds a capture around a spy logger, with the diagnostics throttle off.
 * @param capture Capture settings over longFrames on.
 * @param once The `once` flags. Two captures with one object act as a reinstall in one document.
 * @returns The capture, its spy metric logger, its breadcrumbs and its diagnostic events.
 */
function setup(capture: Partial<CaptureOptions> = {}, once = freshOnce()) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const logMetric = vi.fn<CaptureLogger["logMetric"]>();
  const breadcrumbs = new BreadcrumbBuffer(50);
  const ctx: CaptureContext = {
    config: resolveConfig(
      { endpoint: null, serviceName: "svc", capture: { longFrames: true, ...capture } },
      diagnostics,
    ),
    diagnostics,
    logger: { error: vi.fn(), warn: vi.fn(), logEvent: vi.fn(), logMetric, debug: vi.fn() },
    breadcrumbs,
    tracing: new TraceEngine(diagnostics),
    once,
    recordMetric: vi.fn(),
    recordSpan: vi.fn(),
  };
  events.length = 0;

  return { sut: new LongFrameCapture(ctx), ctx, logMetric, breadcrumbs, events };
}

/**
 * Builds a long animation frame entry.
 * @param duration Frame duration in milliseconds.
 * @param sourceURL Source URL of the longest script.
 * @returns The entry.
 */
const frame = (duration: number, sourceURL = "https://app.example/grid.js?sig=secret") => ({
  entryType: "long-animation-frame",
  duration,
  blockingDuration: duration - 50,
  scripts: [
    { duration: 10, invoker: "TimerHandler:setTimeout", sourceURL: "https://app.example/a.js" },
    { duration: duration - 20, invoker: "DOMWindow.onclick", sourceURL },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeObserver.created = [];
});

describe("LongFrameCapture", () => {
  it("observes long-animation-frame when the browser supports it", () => {
    support(["longtask", "long-animation-frame"]);
    const { sut } = setup();

    sut.install();
    sut.install();

    expect(active()?.observed).toBe("long-animation-frame");
  });

  it("reads buffered frames on the first install only", () => {
    support(["long-animation-frame"]);
    const once = freshOnce();

    setup({}, once).sut.install();
    const first = active();
    setup({}, once).sut.install();

    // The first install reads the frames before the chunk loaded. A reinstall must not repeat them.
    expect(first?.buffered).toBe(true);
    expect(active()?.buffered).toBe(false);
  });

  it("observes longtask when long-animation-frame is not available", () => {
    support(["longtask"]);
    const { sut, logMetric } = setup();

    sut.install();
    active()?.emit({ entryType: "longtask", duration: 180.4 });

    expect(active()?.observed).toBe("longtask");
    expect(logMetric).toHaveBeenCalledWith("ui.long_frame.duration", 180, "ms", "histogram", {
      "frame.type": "longtask",
    });
  });

  it("reports and installs nothing when the browser reports no long frames", () => {
    support(undefined);
    const old = setup();
    old.sut.install();

    vi.stubGlobal("PerformanceObserver", undefined);
    const none = setup();
    none.sut.install();
    none.sut.uninstall();

    expect(active()).toBeUndefined();
    expect(old.events.map((event) => event.code)).toEqual(["capture.install_failed"]);
    expect(none.events.map((event) => event.code)).toEqual(["capture.install_failed"]);
  });

  it("reports missing support one time for each document", () => {
    support(["layout-shift"]);
    const once = freshOnce();

    const first = setup({}, once);
    first.sut.install();
    const second = setup({}, once);
    second.sut.install();

    expect(first.events.map((event) => event.code)).toEqual(["capture.install_failed"]);
    expect(second.events).toEqual([]);
  });

  it("removes the query from a script URL in the invoker unless fullUrls is set", () => {
    support(["long-animation-frame"]);
    const stripped = setup();
    stripped.sut.install();
    const entry = {
      entryType: "long-animation-frame",
      duration: 200,
      scripts: [{ duration: 150, invoker: "https://cdn.example/slow.js?token=secret" }],
    };

    active()?.emit(entry);
    const full = setup({ fullUrls: true });
    full.sut.install();
    active()?.emit(entry);

    expect(stripped.logMetric.mock.calls[0]?.[4]).toMatchObject({
      "frame.script.invoker": "https://cdn.example/slow.js",
    });
    expect(full.logMetric.mock.calls[0]?.[4]).toMatchObject({
      "frame.script.invoker": "https://cdn.example/slow.js?token=secret",
    });
  });

  it("records a frame at the threshold as a metric and a breadcrumb", () => {
    support(["long-animation-frame"]);
    const { sut, logMetric, breadcrumbs } = setup();
    sut.install();

    active()?.emit(frame(LONG_FRAME_THRESHOLD_MS - 1), frame(LONG_FRAME_THRESHOLD_MS));

    expect(logMetric).toHaveBeenCalledTimes(1);
    expect(logMetric).toHaveBeenCalledWith("ui.long_frame.duration", 100, "ms", "histogram", {
      "frame.type": "long-animation-frame",
      "frame.blocking_ms": 50,
      "frame.script.invoker": "DOMWindow.onclick",
      "frame.script.source": "https://app.example/grid.js",
    });
    expect(breadcrumbs.snapshot()).toEqual([
      expect.objectContaining({ category: "frame", message: "long frame 100 ms" }),
    ]);
  });

  it("keeps the script query when fullUrls is set", () => {
    support(["long-animation-frame"]);
    const { sut, logMetric } = setup({ fullUrls: true });
    sut.install();

    active()?.emit(frame(300));

    expect(logMetric.mock.calls[0]?.[4]).toMatchObject({
      "frame.script.source": "https://app.example/grid.js?sig=secret",
    });
  });

  it("uses only the longest script, and leaves out each attribute that it does not have", () => {
    support(["long-animation-frame"]);
    const { sut, logMetric } = setup();
    sut.install();

    active()?.emit({
      entryType: "long-animation-frame",
      duration: 200,
      scripts: [{ duration: 5 }, { duration: 3, invoker: "TimerHandler:setTimeout" }],
    });

    expect(logMetric.mock.calls[0]?.[4]).toEqual({ "frame.type": "long-animation-frame" });
  });

  it("uses a custom threshold", () => {
    support(["long-animation-frame"]);
    const { sut, logMetric } = setup({ longFrameThresholdMs: 250 });
    sut.install();

    active()?.emit(frame(200), frame(260));

    expect(logMetric).toHaveBeenCalledTimes(1);
  });

  it("reports a threshold that is not usable, and uses the default", () => {
    support(["long-animation-frame"]);
    const { sut, ctx, logMetric, events } = setup();
    // resolveConfig rejects -1. Set it after the resolve to reach the guard of the capture.
    ctx.config.capture.longFrameThresholdMs = -1;
    sut.install();

    active()?.emit(frame(99), frame(100));

    expect(logMetric).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.message)).toEqual([
      expect.stringContaining("capture.longFrameThresholdMs must be a number of 0 or more"),
    ]);
  });

  it("limits the frames in one window, and reports the limit", () => {
    support(["long-animation-frame"]);
    const { sut, logMetric, events } = setup();
    sut.install();

    const frames = Array.from({ length: LONG_FRAME_MAX_PER_WINDOW + 5 }, () => frame(200));
    active()?.emit(...frames);

    expect(logMetric).toHaveBeenCalledTimes(LONG_FRAME_MAX_PER_WINDOW);
    expect(events.map((event) => event.code)).toContain("capture.rate_limited");
  });

  it("disconnects the observer on uninstall, and can install again", () => {
    support(["long-animation-frame"]);
    const { sut } = setup();
    sut.install();
    const first = active();

    sut.uninstall();
    sut.install();

    expect(first?.disconnected).toBe(true);
    expect(active()).not.toBe(first);
  });
});

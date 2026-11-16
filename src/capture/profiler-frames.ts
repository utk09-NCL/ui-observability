// src/capture/profiler-frames.ts
//
// Ties the profiler to the browser's rendering work. The frame phases capture attributes the
// phases of each long animation frame to the probes that ran in it. Frame pacing measures the
// time between consecutive frames.

import {
  PROFILE_FRAME_METRIC_NAME,
  PROFILE_FRAME_PROBE,
  PROFILE_KEYS,
  PROFILER_LINK_MIN_MS,
} from "../constants";
import { profilerCore } from "../core/profiler";
import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext } from "./types";

/** Long animation frames, not long tasks: long tasks don't have phases. */
const FRAME_TYPE = "long-animation-frame";

/** One script in a long animation frame. */
interface FrameScript {
  /** Style and layout time the script forced, in ms. */
  forcedStyleAndLayoutDuration?: number;
}

/** A long animation frame. Some versions of the DOM typings don't declare these fields. */
interface PhaseEntry extends PerformanceEntry {
  /** When the render callbacks started. 0 if the frame didn't render. */
  renderStart?: number;
  /** When style and layout started. 0 if the frame didn't render. */
  styleAndLayoutStart?: number;
  /** The scripts that ran in the frame. */
  scripts?: FrameScript[];
}

/** The page globals frame pacing needs. A worker or Node.js may have none of them. */
interface FrameScope {
  /** Calls a function before the next paint, passing the frame's start time. */
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  document?: Pick<Document, "addEventListener" | "removeEventListener">;
}

/** Attributes the phases of each long animation frame to every probe with a span in it. */
export class FramePhasesCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "frame-phases";

  /** The active observer. Undefined while the capture isn't installed. */
  private observer: PerformanceObserver | undefined;

  /** Rate limit for this capture, so a frozen tab can't flood the pipeline. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /**
   * @param ctx Capture context: configuration, diagnostics and logger.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Starts observing long animation frames and turns on the recent-span ring. */
  install(): void {
    if (this.observer) {
      return;
    }

    // Older browsers have no supportedEntryTypes. The capture just stays off there.
    const supported: readonly string[] | undefined =
      typeof PerformanceObserver === "undefined"
        ? undefined
        : PerformanceObserver.supportedEntryTypes;

    if (!supported?.includes(FRAME_TYPE)) {
      // Report on the first install in a document only, not on every reinstall after configure().
      const { once } = this.ctx;

      if (!once.framePhases) {
        once.framePhases = true;
        this.ctx.diagnostics.report(
          "capture.install_failed",
          "The browser does not report long animation frames. profiler.framePhases is off.",
        );
      }

      return;
    }

    profilerCore().link(PROFILER_LINK_MIN_MS);
    this.observer = new PerformanceObserver((list) => {
      // The browser calls this directly, so anything we throw is an uncaught error on the page.
      this.ctx.diagnostics.guard(
        "capture.record_failed",
        "The library could not record a long animation frame of the profiler.",
        () => {
          for (const entry of list.getEntries()) {
            this.record(entry);
          }
        },
      );
    });

    // Not buffered: a buffered frame is older than anything in the ring and would link to nothing.
    this.observer.observe({ type: FRAME_TYPE });
  }

  /** Disconnects the observer and turns the recent-span ring off. */
  uninstall(): void {
    if (!this.observer) {
      return;
    }

    this.observer.disconnect();
    this.observer = undefined;
    profilerCore().link(Infinity);
  }

  /**
   * Records one frame's phases for every probe that had a span in the frame.
   * @param entry Long animation frame entry.
   */
  private record(entry: PhaseEntry): void {
    const start = entry.startTime;
    const end = start + entry.duration;
    const names = profilerCore().linked(start, end);

    if (names.length === 0) {
      return;
    }

    const { capturePolicy } = this.ctx.config;

    if (
      !allowInWindow(
        this.window,
        capturePolicy.longFramesPerWindow,
        this.ctx.diagnostics,
        "profiler frames",
        capturePolicy.windowMs,
      )
    ) {
      return;
    }

    // A frame that didn't render has 0 in both fields. The whole frame then counts as script.
    const phaseStart = (value = 0): number => (value > 0 ? value : end);
    const renderStart = phaseStart(entry.renderStart);
    const layoutStart = phaseStart(entry.styleAndLayoutStart);
    let forced = 0;

    for (const script of entry.scripts ?? []) {
      forced += script.forcedStyleAndLayoutDuration ?? 0;
    }

    const phases: [string, number][] = [
      ["script", renderStart - start],
      ["render", layoutStart - renderStart],
      ["style_layout", end - layoutStart],
      ["forced_layout", forced],
    ];

    for (const name of names) {
      for (const [phase, ms] of phases) {
        this.ctx.logger.logMetric(PROFILE_FRAME_METRIC_NAME, ms, "ms", "histogram", {
          [PROFILE_KEYS.probe]: name,
          [PROFILE_KEYS.framePhase]: phase,
        });
      }
    }
  }
}

/** Measures the time between consecutive frames with the frame pacing probe. */
export class FramePacingCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "frame-pacing";

  /** Handle of the pending frame callback. Undefined while the capture isn't installed. */
  private handle: number | undefined;

  /** Start time of the last frame. -1 before the first frame and after the page was hidden. */
  private last = -1;

  /**
   * @param ctx Capture context: configuration, diagnostics and logger.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** A hidden page gets no frame callbacks, so the first frame back isn't an interval. */
  private readonly onVisibility = (): void => {
    this.last = -1;
  };

  /** Starts the frame callback loop. */
  install(): void {
    const scope = globalThis as FrameScope;
    const { requestAnimationFrame: request } = scope;

    if (this.handle !== undefined) {
      return;
    }

    if (typeof request !== "function") {
      const { once } = this.ctx;

      if (!once.framePacing) {
        once.framePacing = true;
        this.ctx.diagnostics.report(
          "capture.install_failed",
          "This context has no frame callback. The frame pacing of the profiler is off.",
        );
      }

      return;
    }

    const probe = profilerCore().probe(PROFILE_FRAME_PROBE, undefined, this.ctx.diagnostics);
    const frame = (time: number): void => {
      // The browser calls this directly, so anything we throw is an uncaught error on the page.
      // It also runs every frame, which is why the try block allocates nothing.
      try {
        if (this.last >= 0) {
          probe.record(time - this.last);
        }
      } catch (error) {
        this.ctx.diagnostics.report(
          "capture.record_failed",
          "The library could not record a frame interval of the profiler.",
          undefined,
          error,
        );
      }

      this.last = time;
      this.handle = request(frame);
    };

    scope.document?.addEventListener("visibilitychange", this.onVisibility);
    this.handle = request(frame);
  }

  /** Stops the frame callback loop. */
  uninstall(): void {
    const scope = globalThis as FrameScope;

    if (this.handle === undefined) {
      return;
    }

    scope.cancelAnimationFrame?.(this.handle);
    scope.document?.removeEventListener("visibilitychange", this.onVisibility);
    this.handle = undefined;
    this.last = -1;
  }
}

// src/capture/long-frames.ts
//
// Reports long animation frames. A long frame freezes the page with no user input.
// INP does not show it, for example a grid that re-renders 5,000 rows.

import { LONG_FRAME_MAX_PER_WINDOW, LONG_FRAME_THRESHOLD_MS } from "../constants";
import { stripUrlQuery } from "../utils/platform";
import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext } from "./types";

/** Entry types that the capture observes, in order of preference. */
const FRAME_TYPES = ["long-animation-frame", "longtask"];

/** One script of a long animation frame. Some DOM type versions do not declare it. */
interface FrameScript {
  /** Run time of the script, in milliseconds. */
  duration: number;
  /** Caller of the script, for example an event listener or a timer. */
  invoker?: string;
  /** URL of the script source. */
  sourceURL?: string;
}

/** Long animation frame or long task. A long task has no blocking time and no scripts. */
interface FrameEntry extends PerformanceEntry {
  /** Time that the frame blocked input, in milliseconds. */
  blockingDuration?: number;
  /** Scripts that ran in the frame. */
  scripts?: FrameScript[];
}

/**
 * Finds the script that ran longest in a frame.
 * @param scripts Scripts of the frame.
 * @returns The longest script, or undefined if the frame has none.
 */
function longestScript(scripts: FrameScript[] | undefined): FrameScript | undefined {
  let longest: FrameScript | undefined;

  for (const script of scripts ?? []) {
    if (!longest || script.duration > longest.duration) {
      longest = script;
    }
  }

  return longest;
}

/** Records each long animation frame as a histogram metric and a breadcrumb. */
export class LongFrameCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "long-frames";

  /** Active observer. Undefined when the capture is not installed. */
  private observer: PerformanceObserver | undefined;

  /** Rate limit of this capture. A frozen tab must not flood the pipeline. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /** Minimum frame duration to record, in milliseconds. */
  private threshold = LONG_FRAME_THRESHOLD_MS;

  /**
   * @param ctx Capture context containing configuration, diagnostics, logger, and breadcrumbs.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Observes the best entry type that the browser supports. */
  install(): void {
    if (this.observer) {
      return;
    }

    // Only the first install in a document reads buffered frames, or reports missing support.
    // A reinstall after configure() then does not repeat them.
    const { once } = this.ctx;
    const first = !once.longFrames;
    once.longFrames = true;

    // Older browsers have no supportedEntryTypes. The capture is then off.
    const supported: readonly string[] | undefined =
      typeof PerformanceObserver === "undefined"
        ? undefined
        : PerformanceObserver.supportedEntryTypes;
    const type = FRAME_TYPES.find((name) => supported?.includes(name));

    if (type === undefined) {
      if (!first) {
        return;
      }

      this.ctx.diagnostics.report(
        "capture.install_failed",
        "The browser does not report long frames. The long frame capture is off.",
      );
      return;
    }

    this.threshold = this.readThreshold();
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.record(entry);
      }
    });

    // Buffered frames include the first render, which runs before this chunk loads.
    this.observer.observe({ type, buffered: first });
  }

  /** Disconnects the observer. */
  uninstall(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /**
   * Reads the threshold from the configuration. It reports a value that is not usable.
   * @returns Minimum frame duration to record, in milliseconds.
   */
  private readThreshold(): number {
    const value: unknown = this.ctx.config.capture.longFrameThresholdMs;

    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }

    this.ctx.diagnostics.report(
      "config.invalid",
      `capture.longFrameThresholdMs must be a number of 0 or more. The library uses ${String(LONG_FRAME_THRESHOLD_MS)}.`,
    );
    return LONG_FRAME_THRESHOLD_MS;
  }

  /**
   * Records one frame at or above the threshold.
   * @param entry Long animation frame or long task entry.
   */
  private record(entry: FrameEntry): void {
    if (entry.duration < this.threshold) {
      return;
    }

    const { diagnostics } = this.ctx;

    if (!allowInWindow(this.window, LONG_FRAME_MAX_PER_WINDOW, diagnostics, "long frames")) {
      return;
    }

    const duration = Math.round(entry.duration);
    const attrs: Record<string, unknown> = { "frame.type": entry.entryType };

    if (entry.blockingDuration !== undefined) {
      attrs["frame.blocking_ms"] = Math.round(entry.blockingDuration);
    }

    const script = longestScript(entry.scripts);

    // A signed URL is a credential. Keep the query only if fullUrls is set.
    const url = (value: string): string =>
      this.ctx.config.capture.fullUrls ? value : stripUrlQuery(value);

    if (script?.invoker) {
      // The invoker of a script entry is the script URL. Other invokers, for example
      // "IMG#hero.onload", contain a "#" that is not a fragment.
      const { invoker } = script;
      attrs["frame.script.invoker"] = invoker.includes("://") ? url(invoker) : invoker;
    }

    if (script?.sourceURL) {
      attrs["frame.script.source"] = url(script.sourceURL);
    }

    this.ctx.breadcrumbs.push({
      t: Date.now(),
      category: "frame",
      message: `long frame ${String(duration)} ms`,
    });
    this.ctx.logger.logMetric("ui.long_frame.duration", duration, "ms", "histogram", attrs);
  }
}

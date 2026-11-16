// src/capture/long-frames.ts
//
// Reports long animation frames. A long frame can freeze the page with no user input involved,
// for example a grid that re-renders 5,000 rows, and INP never shows that.

import { LONG_FRAME_THRESHOLD_MS } from "../constants";
import { recordedUrl } from "../utils/platform";
import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext } from "./types";

/** The entry types this capture can observe, best first. */
const FRAME_TYPES = ["long-animation-frame", "longtask"];

/** One script in a long animation frame. Some versions of the DOM types don't declare it. */
interface FrameScript {
  /** How long the script ran, in milliseconds. */
  duration: number;
  /** What called the script, for example an event listener or a timer. */
  invoker?: string;
  /** URL of the script's source. */
  sourceURL?: string;
}

/** A long animation frame or a long task. A long task has no blocking time and no scripts. */
interface FrameEntry extends PerformanceEntry {
  /** How long the frame blocked input, in milliseconds. */
  blockingDuration?: number;
  /** Scripts that ran in the frame. */
  scripts?: FrameScript[];
}

/**
 * Finds the script that ran longest in a frame.
 * @param scripts The frame's scripts.
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

/** Records every long animation frame as a histogram metric and a breadcrumb. */
export class LongFrameCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "long-frames";

  /** Active observer. Undefined while the capture isn't installed. */
  private observer: PerformanceObserver | undefined;

  /** This capture's own rate limit, so a frozen tab can't flood the pipeline. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /** Minimum frame duration to record, in milliseconds. */
  private threshold = LONG_FRAME_THRESHOLD_MS;

  /**
   * @param ctx Capture context: configuration, diagnostics, logger and breadcrumbs.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Observes the best entry type the browser supports. */
  install(): void {
    if (this.observer) {
      return;
    }

    // Only the first install in a document reads buffered frames or reports missing support,
    // so a reinstall after configure() doesn't repeat either.
    const { once } = this.ctx;
    const first = !once.longFrames;
    once.longFrames = true;

    // Older browsers have no supportedEntryTypes, and the capture stays off there.
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
      // The browser calls this directly, so anything we throw is an uncaught error on the page.
      this.ctx.diagnostics.guard(
        "capture.record_failed",
        "The library could not record a long frame.",
        () => {
          for (const entry of list.getEntries()) {
            this.record(entry);
          }
        },
      );
    });

    // Buffered frames include the first render, which happens before this chunk loads.
    this.observer.observe({ type, buffered: first });
  }

  /** Disconnects the observer. */
  uninstall(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /**
   * Reads the threshold from the configuration and reports a value it can't use.
   * @returns Minimum frame duration to record, in milliseconds.
   */
  private readThreshold(): number {
    const value: unknown = this.ctx.config.capture.longFrameMs;

    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }

    this.ctx.diagnostics.report(
      "config.invalid",
      `capture.longFrameMs must be a number of 0 or more. The library uses ${String(LONG_FRAME_THRESHOLD_MS)}.`,
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

    if (
      !allowInWindow(
        this.window,
        this.ctx.config.capturePolicy.longFramesPerWindow,
        diagnostics,
        "long frames",
        this.ctx.config.capturePolicy.windowMs,
      )
    ) {
      return;
    }

    const duration = Math.round(entry.duration);
    const attrs: Record<string, unknown> = { "frame.type": entry.entryType };

    if (entry.blockingDuration !== undefined) {
      attrs["frame.blocking_ms"] = Math.round(entry.blockingDuration);
    }

    const script = longestScript(entry.scripts);

    // A signed URL is a credential. Only keep the query when fullUrls is on.
    const url = (value: string): string =>
      recordedUrl(
        value,
        this.ctx.config.capture.fullUrls,
        this.ctx.config.capture.urlTransform,
        diagnostics,
      );

    if (script?.invoker) {
      // A script entry's invoker is the script URL. Other invokers, for example
      // "IMG#hero.onload", contain a "#" that isn't a fragment.
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

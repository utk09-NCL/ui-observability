// src/capture/user-timing.ts
//
// Records the marks and measures of the app from the User Timing API. A measure goes into a
// histogram. A mark adds a breadcrumb.

import type { InstrumentDef } from "../models/metric";
import { recordedUrl } from "../utils/platform";
import { type Capture, type CaptureContext, matchesAny } from "./types";

/** Histogram of the measures of the app, in milliseconds. */
const USER_TIMING_DURATION: InstrumentDef = {
  name: "ui.user_timing.duration",
  kind: "histogram",
  unit: "ms",
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
};

/** Observes the marks and measures of the app. */
export class UserTimingCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "userTiming";

  /** Observer of the mark and measure entries. */
  private observer: PerformanceObserver | undefined;

  /**
   * @param ctx Capture context with the config, the meter and the breadcrumbs.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Observes marks and measures. Only the first install in a document reads buffered entries. */
  install(): void {
    if (this.observer) {
      return;
    }

    const { once } = this.ctx;
    const first = !once.userTiming;
    once.userTiming = true;

    // Older browsers have no supportedEntryTypes. The capture is then off.
    const supported: readonly string[] | undefined =
      typeof PerformanceObserver === "undefined"
        ? undefined
        : PerformanceObserver.supportedEntryTypes;
    if (!supported?.includes("measure")) {
      if (first) {
        this.ctx.diagnostics.report(
          "capture.install_failed",
          "The browser does not report User Timing entries. The user timing capture is off.",
        );
      }
      return;
    }

    this.observer = new PerformanceObserver((list) => {
      this.record(list.getEntries());
    });
    // Buffered entries include the marks and measures before this chunk loads.
    this.observer.observe({ type: "measure", buffered: first });
    if (supported.includes("mark")) {
      this.observer.observe({ type: "mark", buffered: first });
    }
  }

  /** Disconnects the observer. */
  uninstall(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /**
   * Records the entries with a name that `userTimingInclude` selects.
   * @param entries Mark and measure entries.
   */
  private record(entries: PerformanceEntryList): void {
    if (this.ctx.isActive?.() === false) {
      return;
    }

    const { fullUrls, userTimingInclude } = this.ctx.config.capture;
    for (const entry of entries) {
      if (userTimingInclude.length > 0 && !matchesAny(entry.name, userTimingInclude)) {
        continue;
      }

      // A name can hold a URL with a token. A third-party script can write any name.
      const name = recordedUrl(entry.name, fullUrls);
      if (entry.entryType === "measure") {
        this.ctx.recordMetric(USER_TIMING_DURATION, entry.duration, { "user_timing.name": name });
      } else {
        this.ctx.breadcrumbs.push({
          // A buffered entry reaches the observer late. The trail needs the time of the mark.
          t: Math.round(performance.timeOrigin + entry.startTime),
          category: "event",
          message: name.slice(0, this.ctx.config.limits.maxBodyChars),
        });
      }
    }
  }
}

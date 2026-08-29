// src/capture/errors.ts
//
// Captures uncaught errors, unhandled rejections and failed resource loads.

import {
  ERROR_STORM_MAX_PER_WINDOW,
  ERROR_STORM_WINDOW_MS,
  MAX_TRACKED_ERROR_SIGNATURES,
} from "../constants";
import type { Capture, CaptureContext } from "./types";

/** Tracking metadata for a deduplicated error signature. */
interface SeenError {
  /** Timestamp when the signature was last reported in epoch milliseconds. */
  at: number;
  /** Occurrences recorded since the last report. */
  count: number;
}

/** Captures uncaught exceptions, unhandled promise rejections, and failed resource loads. */
export class ErrorCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "errors";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /** Recently reported error signatures in LRU order. */
  private readonly seen = new Map<string, SeenError>();

  /** Start timestamp of the active throttling window in epoch milliseconds. */
  private windowStart = 0;

  /** Errors reported during the active throttling window. */
  private windowCount = 0;

  /**
   * @param ctx Capture context containing configuration, diagnostics, logger, and breadcrumbs.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Subscribes to global error and unhandledrejection events. */
  install(): void {
    if (this.installed || typeof addEventListener === "undefined") {
      return;
    }
    this.installed = true;

    // Uses capture phase to observe non-bubbling resource load errors.
    addEventListener("error", this.onError, true);
    addEventListener("unhandledrejection", this.onRejection);
  }

  /** Removes event listeners and clears tracked error signatures. */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;

    removeEventListener("error", this.onError, true);
    removeEventListener("unhandledrejection", this.onRejection);
    this.seen.clear();
  }

  /** Routes resource load failures and uncaught script errors. */
  private readonly onError = (event: ErrorEvent | Event): void => {
    const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
    const resourceUrl = target?.src ?? target?.href ?? "";

    // Filters element-level resource load failures from script errors.
    if (
      target !== null &&
      target !== (globalThis as unknown as EventTarget) &&
      resourceUrl !== ""
    ) {
      if (!this.ctx.config.capture.resourceErrors) {
        return;
      }

      this.ctx.breadcrumbs.push({
        t: Date.now(),
        category: "http",
        message: `resource failed: ${resourceUrl}`,
      });
      this.ctx.logger.warn("resource failed to load", {
        "error.type": "resource",
        "resource.url": resourceUrl,
        "resource.tag": target.tagName.toLowerCase(),
      });
      return;
    }

    if (!this.ctx.config.capture.errors) {
      return;
    }

    const errorEvent = event as ErrorEvent;
    const fallback = errorEvent.message === "" ? "unknown error" : errorEvent.message;
    const thrown: unknown = errorEvent.error;
    const error = thrown ?? new Error(fallback);

    this.report("window.onerror", error, {
      "error.source": errorEvent.filename,
      "error.line": errorEvent.lineno,
      "error.column": errorEvent.colno,
    });
  };

  /** Captures unhandled promise rejections. */
  private readonly onRejection = (event: PromiseRejectionEvent): void => {
    if (!this.ctx.config.capture.rejections) {
      return;
    }

    this.report("unhandledrejection", event.reason, {
      "error.type": "unhandledrejection",
    });
  };

  /**
   * Rate limits, deduplicates, and logs captured errors.
   * @param source Originating capture event name.
   * @param error Caught error instance or thrown value.
   * @param extra Contextual error attributes.
   */
  private report(source: string, error: unknown, extra: Record<string, unknown>): void {
    const now = Date.now();

    if (now - this.windowStart > ERROR_STORM_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }

    this.windowCount++;
    if (this.windowCount > ERROR_STORM_MAX_PER_WINDOW) {
      // A render loop throwing inside requestAnimationFrame produces thousands
      // per second. Shipping all of them is a denial of service on our ingest.
      this.ctx.diagnostics.report(
        "capture.rate_limited",
        `more than ${String(ERROR_STORM_MAX_PER_WINDOW)} errors in ${String(ERROR_STORM_WINDOW_MS)}ms, suppressing the rest of this window`,
      );
      return;
    }

    const asError = error instanceof Error ? error : new Error(String(error));
    const frame = (asError.stack ?? "").split("\n")[1] ?? "";
    const key = `${asError.name}|${asError.message}|${frame}`;
    const previous = this.seen.get(key);

    if (previous && now - previous.at < this.ctx.config.capture.errorDedupeMs) {
      previous.count++;
      previous.at = now;
      return;
    }

    // Occurrences swallowed since this signature was last reported. Counting
    // them and never emitting the number makes a storm look like a trickle.
    const suppressed = previous ? previous.count - 1 : 0;

    // Deleted before it is re-set so the map stays in least-recently-reported
    // order, which is what makes the eviction below evict the right entry.
    this.seen.delete(key);
    this.seen.set(key, { at: now, count: 1 });

    // A page throwing with a fresh message every render, which is what a bad
    // template literal inside a loop looks like, would grow this map for as
    // long as the document stays open.
    if (this.seen.size > MAX_TRACKED_ERROR_SIGNATURES) {
      const [oldest] = this.seen.keys();
      this.seen.delete(oldest);
    }

    this.ctx.logger.error(asError.message === "" ? source : asError.message, asError, {
      ...extra,
      "error.captured_by": source,
      "error.suppressed_count": suppressed,
    });
  }
}

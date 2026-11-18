// src/capture/errors.ts
//
// Captures uncaught errors, unhandled rejections and failed resource loads.

import { MAX_TRACKED_ERROR_SIGNATURES } from "../constants";
import { isErrorLike } from "../utils/error-like";
import { recordedUrl } from "../utils/platform";
import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext } from "./types";

/** Tracking metadata for a deduplicated error signature. */
interface SeenError {
  /** When the signature was last reported, in epoch milliseconds. */
  at: number;
  /** Occurrences recorded since the last report. */
  count: number;
}

/** A thrown value's message and deduplication key. */
interface Signature {
  /** The record's message. */
  message: string;
  /** Deduplication key. */
  key: string;
}

/**
 * Reads a thrown value's message and deduplication key.
 * Duck typing lets it read an error from another realm, which fails `instanceof Error`.
 * @param value Thrown value or rejection reason.
 * @returns The signature.
 * @throws When a getter or the value's text form throws. Call it inside a guard.
 */
function signatureOf(value: unknown): Signature {
  if (isErrorLike(value)) {
    const frame = (value.stack ?? "").split("\n")[1] ?? "";
    return { message: value.message, key: `${value.name}|${value.message}|${frame}` };
  }

  const message = String(value);
  return { message, key: `${typeof value}|${message}|` };
}

/** Captures uncaught exceptions, unhandled promise rejections, and failed resource loads. */
export class ErrorCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "errors";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /** Recently reported error signatures in LRU order. */
  private readonly seen = new Map<string, SeenError>();

  /** This capture's own rate limit. Console noise has a separate window and can't use it. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /**
   * @param ctx Capture context: configuration, diagnostics, logger and breadcrumbs.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Subscribes to global error and unhandledrejection events. */
  install(): void {
    if (this.installed || typeof addEventListener === "undefined") {
      return;
    }
    this.installed = true;

    // Resource load errors don't bubble, so listen in the capture phase.
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

    // An event from an element with a URL is a failed resource load, not a script error.
    if (
      target !== null &&
      target !== (globalThis as unknown as EventTarget) &&
      resourceUrl !== ""
    ) {
      if (!this.ctx.config.capture.resourceErrors) {
        return;
      }

      // A cache buster is noise and a signed URL is a credential, so the record keeps neither
      // unless you set fullUrls.
      const url = recordedUrl(
        resourceUrl,
        this.ctx.config.capture.fullUrls,
        this.ctx.config.capture.urlTransform,
        this.ctx.diagnostics,
      );

      this.ctx.breadcrumbs.push({
        t: Date.now(),
        category: "http",
        message: `resource failed: ${url}`,
      });
      this.ctx.logger.warn("resource failed to load", {
        "error.type": "resource",
        "resource.url": url,
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
      // A signed script URL is a credential.
      "error.source": recordedUrl(
        errorEvent.filename,
        this.ctx.config.capture.fullUrls,
        this.ctx.config.capture.urlTransform,
        this.ctx.diagnostics,
      ),
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
   * Rate limits, deduplicates and logs a captured error.
   * @param source Name of the capture event it came from.
   * @param error The caught error or thrown value.
   * @param extra Extra error attributes for the record.
   */
  private report(source: string, error: unknown, extra: Record<string, unknown>): void {
    if (
      !allowInWindow(
        this.window,
        this.ctx.config.captureLimits.errorsPerWindow,
        this.ctx.diagnostics,
        "errors",
        this.ctx.config.captureLimits.windowMs,
      )
    ) {
      return;
    }

    const now = Date.now();
    // A reason with no text form, for example a null-prototype object, gets an empty message,
    // and the record then uses the source as its message.
    const { message, key } = this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The library could not read the error reason. It records the error without its message.",
      () => signatureOf(error),
    ) ?? { message: "", key: `${typeof error}||` };
    const previous = this.seen.get(key);

    if (previous && now - previous.at < this.ctx.config.captureLimits.errorDedupeMs) {
      previous.count++;
      previous.at = now;
      return;
    }

    // How many occurrences deduplication dropped since the last report. Without this count,
    // many errors look like a few.
    const suppressed = previous ? previous.count - 1 : 0;

    // Delete, then set, to move the key to the end of the map. That keeps the map in
    // least-recently-reported order, which the eviction below relies on.
    this.seen.delete(key);
    this.seen.set(key, { at: now, count: 1 });

    // A page can throw with a new message on every render, for example from a template literal
    // in a loop. Without this cap, the map grows until the document closes.
    if (this.seen.size > MAX_TRACKED_ERROR_SIGNATURES) {
      const [oldest] = this.seen.keys();
      this.seen.delete(oldest);
    }

    // Hand the logger the original value, so it converts the reason and keeps its data.
    // With no reason at all, the record still needs error.message and error.stack_trace.
    const reason = error === undefined ? new Error(message) : error;
    this.ctx.logger.error(message === "" ? source : message, reason, {
      ...extra,
      "error.captured_by": source,
      "error.suppressed_count": suppressed,
    });
  }
}

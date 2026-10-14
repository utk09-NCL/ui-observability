// src/capture/network.ts
//
// Instruments fetch and XMLHttpRequest to record network request outcomes and timing.

import { isLibraryRequest } from "../utils/library-request";
import { stripUrlQuery } from "../utils/platform";
import { type Capture, type CaptureContext, matchesAny } from "./types";

/** Signature of the global fetch function. */
type FetchFn = typeof fetch;

/** XMLHttpRequest extended with internal telemetry tracking metadata. */
type Tracked = XMLHttpRequest & {
  __uiobs?: { method: string; url: string; startedAt: number };
};

/** Unbound prototype methods intercepted on XMLHttpRequest. */
interface XhrMethods {
  open: (this: XMLHttpRequest, ...args: never[]) => void;
  send: (this: XMLHttpRequest, ...args: never[]) => void;
}

/** Returns the XMLHttpRequest prototype. */
function xhrMethods(): XhrMethods {
  return XMLHttpRequest.prototype;
}

/** Instruments global fetch and XMLHttpRequest to capture request durations and outcomes. */
export class NetworkCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "network";

  /** Original uninstrumented fetch implementation. */
  private originalFetch: FetchFn | null = null;

  /** Original uninstrumented XMLHttpRequest.open implementation. */
  private originalOpen: XhrMethods["open"] | null = null;

  /** Original uninstrumented XMLHttpRequest.send implementation. */
  private originalSend: XhrMethods["send"] | null = null;

  /**
   * @param ctx Capture context containing configuration, diagnostics, logger, breadcrumbs, and tracing.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Instruments configured network transport APIs. */
  install(): void {
    if (this.ctx.config.capture.fetch) {
      this.installFetch();
    }
    if (this.ctx.config.capture.xhr) {
      this.installXhr();
    }
  }

  /** Restores native network transport implementations and clears references. */
  uninstall(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
    if (this.originalOpen) {
      xhrMethods().open = this.originalOpen;
      this.originalOpen = null;
    }
    if (this.originalSend) {
      xhrMethods().send = this.originalSend;
      this.originalSend = null;
    }
  }

  /**
   * Evaluates whether a URL matches ignore patterns.
   * @param url Request target URL.
   * @returns True if telemetry must exclude the URL.
   */
  private ignored(url: string): boolean {
    // resolveConfig always adds the endpoint to ignoreUrls. Without it, a failed POST
    // makes a log record. That record causes a new POST, and the loop does not stop.
    // A custom transport has no known URL. Its request starts inside the library scope.
    return isLibraryRequest() || matchesAny(url, this.ctx.config.capture.ignoreUrls);
  }

  /** Instruments globalThis.fetch with tracing injection and outcome logging. */
  private installFetch(): void {
    if (typeof globalThis.fetch !== "function" || this.originalFetch) {
      return;
    }

    const original = globalThis.fetch.bind(globalThis);
    this.originalFetch = globalThis.fetch;

    const ctx = this.ctx;
    const ignored = (url: string): boolean => this.ignored(url);
    const record = (
      method: string,
      url: string,
      status: number,
      durationMs: number,
      error: unknown,
    ): void => {
      this.record(method, url, status, durationMs, error);
    };

    globalThis.fetch = async function instrumentedFetch(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const requested = init?.method ?? (input instanceof Request ? input.method : "GET");
      const method = requested.toUpperCase();

      if (ignored(url)) {
        return original(input, init);
      }

      let fetchInput = input;
      let fetchInit = init;

      // Add headers only to allowlisted URLs. A traceparent on a third-party request causes
      // a CORS preflight. The third party does not answer it, and its API stops working.
      if (matchesAny(url, ctx.config.capture.propagateTraceHeaderTo)) {
        try {
          const injected = Object.entries(ctx.tracing.headers());

          if (input instanceof Request) {
            // Do not spread a non-empty init with a Request input. That runs the Request
            // constructor on `input` again and reads its body. A body that was read
            // before causes a TypeError.
            const headers = new Headers(input.headers);
            for (const [key, value] of injected) {
              headers.set(key, value);
            }
            fetchInput = new Request(input, { headers });
          } else {
            const headers = new Headers(init?.headers);
            for (const [key, value] of injected) {
              headers.set(key, value);
            }
            fetchInit = { ...init, headers };
          }
        } catch (error) {
          // Send the request that the caller gave, without changes. A missing header is
          // better than a failed request.
          fetchInput = input;
          fetchInit = init;
          ctx.diagnostics.report(
            "capture.header_failed",
            "The library could not add the traceparent header. It sends the request unchanged.",
            { url },
            error,
          );
        }
      }

      const startedAt = performance.now();
      try {
        const response = await original(fetchInput, fetchInit);
        record(method, url, response.status, performance.now() - startedAt, undefined);
        return response;
      } catch (error) {
        record(method, url, 0, performance.now() - startedAt, error);
        throw error;
      }
    };
  }

  /** Instruments XMLHttpRequest open and send prototype methods. */
  private installXhr(): void {
    if (typeof XMLHttpRequest === "undefined" || this.originalOpen) {
      return;
    }

    const ignored = (url: string): boolean => this.ignored(url);
    const record = (method: string, url: string, status: number, durationMs: number): void => {
      this.record(method, url, status, durationMs, undefined);
    };

    const proto = xhrMethods();
    const originalOpen = proto.open;
    const originalSend = proto.send;
    this.originalOpen = originalOpen;
    this.originalSend = originalSend;

    proto.open = function (this: Tracked, method: string, url: string | URL, ...rest: never[]) {
      this.__uiobs = {
        method: method.toUpperCase(),
        url: String(url),
        startedAt: 0,
      };
      originalOpen.apply(this, [method, url, ...rest] as never[]);
    };

    proto.send = function (this: Tracked, ...args: never[]) {
      const meta = this.__uiobs;
      if (meta && !ignored(meta.url)) {
        meta.startedAt = performance.now();
        this.addEventListener("loadend", () => {
          record(meta.method, meta.url, this.status, performance.now() - meta.startedAt);
        });
      }
      originalSend.apply(this, args);
    };
  }

  /**
   * Records request outcome attributes and breadcrumb entry.
   * @param method Uppercase HTTP method.
   * @param target Request target URL. The method removes the query unless fullUrls is set.
   * @param status HTTP response status code, or 0 on failure.
   * @param durationMs Request duration in milliseconds.
   * @param error Caught error instance on failed requests.
   */
  private record(
    method: string,
    target: string,
    status: number,
    durationMs: number,
    error: unknown,
  ): void {
    // Remove the query here, not at the call sites. ignoreUrls and propagateTraceHeaderTo
    // match on the full URL. Only the recorded URL loses the query string.
    const url = this.ctx.config.capture.fullUrls ? target : stripUrlQuery(target);

    // This code runs inside the fetch call of the caller. An error here must not cause
    // the request of the caller to fail.
    this.ctx.diagnostics.guard(
      "capture.record_failed",
      `The library could not record ${method} ${url}.`,
      () => {
        const rounded = Math.round(durationMs);

        this.ctx.breadcrumbs.push({
          t: Date.now(),
          category: "http",
          message: `${method} ${url} ${status === 0 ? "failed" : String(status)}`,
          data: { durationMs: rounded },
        });

        const attributes = {
          "http.request.method": method,
          "url.full": url,
          "http.response.status_code": status,
          "http.duration_ms": rounded,
        };

        if (status === 0) {
          this.ctx.logger.error(`${method} ${url} failed`, error, attributes);
          return;
        }
        if (status >= 400) {
          this.ctx.logger.warn(`${method} ${url} returned ${String(status)}`, attributes);
          return;
        }

        // Log a success at DEBUG. The default minLevel of INFO drops it.
        // Only failures use bandwidth.
        this.ctx.logger.debug(`${method} ${url}`, attributes);
      },
    );
  }
}

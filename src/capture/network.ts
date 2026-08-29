// src/capture/network.ts
//
// Instruments fetch and XMLHttpRequest to record network request outcomes and timing.

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
   * @returns True if URL should be excluded from telemetry.
   */
  private ignored(url: string): boolean {
    // The endpoint is always in ignoreUrls, added by resolveConfig. Without it
    // one failed POST logs, which POSTs, which logs, forever.
    return matchesAny(url, this.ctx.config.capture.ignoreUrls);
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

      // Allowlist only. An unexpected traceparent on a third-party request
      // forces a CORS preflight they will not answer, and their API stops
      // working inside the consumer's application.
      if (matchesAny(url, ctx.config.capture.propagateTraceHeaderTo)) {
        try {
          const injected = Object.entries(ctx.tracing.headers());

          if (input instanceof Request) {
            // Never spread a non-empty init alongside a Request input: that
            // re-runs the Request constructor over `input` and consumes its
            // body, which throws TypeError on an already-read body.
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
          // Send exactly what the caller passed. Losing our header is always
          // better than breaking their request.
          fetchInput = input;
          fetchInit = init;
          ctx.diagnostics.report(
            "capture.header_failed",
            "could not attach traceparent, sending the request unchanged",
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
   * @param url Request target URL.
   * @param status HTTP response status code, or 0 on failure.
   * @param durationMs Request duration in milliseconds.
   * @param error Caught error instance on failed requests.
   */
  private record(
    method: string,
    url: string,
    status: number,
    durationMs: number,
    error: unknown,
  ): void {
    // A throw here runs inside the caller's own fetch. Breaking their request
    // to record that their request broke is the one unacceptable outcome.
    this.ctx.diagnostics.guard("capture.record_failed", `recording ${method} ${url}`, () => {
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

      // DEBUG, so a successful request is dropped by the default minLevel of
      // INFO and only failures cost bandwidth.
      this.ctx.logger.debug(`${method} ${url}`, attributes);
    });
  }
}

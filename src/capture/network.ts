// src/capture/network.ts
//
// Instruments fetch and XMLHttpRequest to record network request outcomes and timing.

import type { InstrumentDef, MetricAttributes } from "../models/metric";
import { isErrorLike } from "../utils/error-like";
import { isLibraryRequest, isTransportPending } from "../utils/library-request";
import { patch } from "../utils/patch";
import { recordedUrl } from "../utils/platform";
import type { ClientSpan } from "../utils/tracing";
import { type Capture, type CaptureContext, matchesAny } from "./types";

/** Signature of the global fetch function. */
type FetchFn = typeof fetch;

/** Milliseconds in one second. The histogram is in seconds, as the OpenTelemetry name gives. */
const MS_PER_SECOND = 1000;

/**
 * The HTTP client duration histogram of the OpenTelemetry semantic conventions. Its boundaries
 * are the ones that the conventions advise.
 */
const HTTP_DURATION: InstrumentDef = {
  name: "http.client.request.duration",
  kind: "histogram",
  unit: "s",
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
};

/**
 * Gives the low-cardinality attributes of one request. The path and the query stay out. Each
 * value of an attribute makes a new series in the backend.
 * @param method Uppercase HTTP method.
 * @param url Request URL.
 * @param status HTTP status code, or 0 when no response came.
 * @param error Failure of a request without a response.
 * @returns The attribute set.
 */
function durationAttributes(
  method: string,
  url: string,
  status: number,
  error: unknown,
): MetricAttributes {
  // A relative URL needs the page URL as its base. A worker has a location too.
  const base = typeof location !== "undefined" ? location.href : undefined;
  const attributes: MetricAttributes = {
    "http.request.method": method,
    "server.address": new URL(url, base).hostname,
  };

  if (status === 0) {
    // A request without a response has the type of its error, for example TypeError.
    const name = isErrorLike(error) ? error.name : "";
    attributes["error.type"] = name === "" ? "_OTHER" : name;
    return attributes;
  }

  attributes["http.response.status_code"] = status;
  if (status >= 400) {
    attributes["error.type"] = String(status);
  }

  return attributes;
}

/** Request data that the XHR wrapper keeps from open to send. */
interface XhrMeta {
  /** Uppercase HTTP method. */
  method: string;
  /** Request target URL. */
  url: string;
  /** Performance timestamp at send. */
  startedAt: number;
  /** Client span that the traceparent names. */
  span?: ClientSpan;
}

/** XMLHttpRequest extended with internal telemetry tracking metadata. */
type Tracked = XMLHttpRequest & {
  __uiobs?: XhrMeta;
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

/** The fetch call to make, and the method and URL to record. */
interface FetchPlan {
  /** Uppercase HTTP method. */
  method: string;
  /** Request target URL. */
  url: string;
  /** Input to pass to the original fetch. */
  input: RequestInfo | URL;
  /** Init to pass to the original fetch. */
  init: RequestInit | undefined;
  /** Client span that the traceparent names. */
  span?: ClientSpan;
}

/**
 * Reads the URL of a fetch input or an XHR URL argument.
 * A Request from another realm fails `instanceof Request`. Its `url` property still works.
 * @param input String, URL, Request, or an object with a text form.
 * @returns The URL.
 * @throws TypeError when the input has no text form. Call it inside a diagnostics guard.
 */
function readUrl(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  if (typeof input === "object" && input !== null) {
    const { url } = input as { url?: unknown };
    if (typeof url === "string") {
      return url;
    }
  }

  // fetch accepts each value with a text form.
  return String(input);
}

/**
 * Reads the method of a fetch call. The init method wins over the Request method.
 * @param input Fetch input.
 * @param init Fetch init.
 * @returns Uppercase method. The default is GET.
 */
function readFetchMethod(input: unknown, init: RequestInit | undefined): string {
  let requested: unknown = init?.method;

  if (requested === undefined && typeof input === "object" && input !== null) {
    requested = (input as { method?: unknown }).method;
  }

  return toMethod(requested ?? "GET");
}

/**
 * Tests if a fetch input is an object that is not a Request or a URL of this realm.
 * An example is a Request from an iframe.
 * @param input Fetch input.
 * @returns True for a foreign object.
 */
function isForeignInput(input: unknown): boolean {
  return typeof input === "object" && !(input instanceof URL) && !(input instanceof Request);
}

/**
 * Converts a method argument to text. A method that is not a string does not throw.
 * @param method Method argument of the caller.
 * @returns Uppercase method for a string, or the text form of another value.
 */
function toMethod(method: unknown): string {
  return typeof method === "string" ? method.toUpperCase() : String(method);
}

/** Instruments global fetch and XMLHttpRequest to capture request durations and outcomes. */
export class NetworkCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "network";

  /** Prevents a second wrap on a wrapped function. */
  private installed = false;

  /** Restore functions of the installed wrappers. */
  private readonly restores: (() => void)[] = [];

  /** True after the report of a request during a custom transport call. It reports one time. */
  private warnedTransport = false;

  /**
   * @param ctx Capture context containing configuration, diagnostics, logger, breadcrumbs, and tracing.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Instruments configured network transport APIs. */
  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;

    if (this.ctx.config.capture.fetch) {
      this.installFetch();
    }
    if (this.ctx.config.capture.xhr) {
      this.installXhr();
    }
  }

  /**
   * Restores each host function that still holds the wrapper of this capture.
   * A wrapper that another script wrapped again stays in place and records nothing.
   */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;

    for (const restore of this.restores.splice(0)) {
      restore();
    }
  }

  /**
   * Tests if a URL matches ignore patterns.
   * @param url Request target URL.
   * @returns True if telemetry must exclude the URL.
   */
  private ignored(url: string): boolean {
    // resolveConfig always adds the endpoint to ignoreUrls. Without it, a failed POST
    // makes a log record. That record causes a new POST, and the loop does not stop.
    // A custom transport has no known URL. Its request starts inside the library scope.
    return isLibraryRequest() || matchesAny(url, this.ctx.config.capture.ignoreUrls);
  }

  /**
   * Tests if a request gets the trace headers.
   * @param url Request target URL.
   * @returns True if the URL is in propagateTraceHeaderTo.
   */
  private propagates(url: string): boolean {
    // Add headers only to allowlisted URLs. A traceparent on a third-party request causes
    // a CORS preflight. The third party does not answer it, and its API stops working.
    const targets = this.ctx.config.capture.propagateTraceHeaderTo;
    if (targets.length === 0) {
      return false;
    }

    // A string target is an origin. A relative URL resolves against the page.
    const origin = this.ctx.diagnostics.guard(
      "capture.header_failed",
      "The library could not read the origin of a request URL. Only a RegExp target can match it.",
      () => new URL(url, location.href).origin,
    );

    return targets.some((target) =>
      typeof target === "string" ? target === origin : target.test(url),
    );
  }

  /** Instruments globalThis.fetch with tracing injection and outcome logging. */
  private installFetch(): void {
    if (typeof globalThis.fetch !== "function") {
      return;
    }

    // Uninstall clears the flag. A wrapper that stays in place then only calls the original.
    let active = true;
    const prepare = (input: RequestInfo | URL, init: RequestInit | undefined) =>
      this.prepareFetch(input, init);
    const record = (plan: FetchPlan, status: number, durationMs: number, error: unknown): void => {
      this.record(plan.method, plan.url, status, durationMs, error, plan.span);
    };

    const restore = patch(globalThis, "fetch", (original: FetchFn) => {
      const call = original.bind(globalThis);

      return async function instrumentedFetch(input, init) {
        const plan = active ? prepare(input, init) : undefined;
        if (!plan) {
          return call(input, init);
        }

        const startedAt = performance.now();
        try {
          const response = await call(plan.input, plan.init);
          record(plan, response.status, performance.now() - startedAt, undefined);
          return response;
        } catch (error) {
          record(plan, 0, performance.now() - startedAt, error);
          throw error;
        }
      };
    });

    this.restores.push(() => {
      active = false;
      restore();
    });
  }

  /**
   * Reads a fetch call and adds the trace headers to an allowlisted request.
   * @param input Fetch input of the caller.
   * @param init Fetch init of the caller.
   * @returns The plan, or undefined to send the request unchanged and record nothing.
   */
  private prepareFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): FetchPlan | undefined {
    // A read here runs inside the fetch call of the caller. A throw must not fail the request.
    const read = this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The library could not read a fetch request. It sends the request unchanged.",
      (): { method: string; url: string; propagate: boolean } | undefined => {
        const url = readUrl(input);
        if (this.ignored(url)) {
          return undefined;
        }

        return { method: readFetchMethod(input, init), url, propagate: this.propagates(url) };
      },
    );

    if (!read) {
      return undefined;
    }

    const { method, url } = read;
    const plan: FetchPlan = { method, url, input, init };
    // An init with headers replaces all headers of a foreign Request, for example
    // Authorization. Send a foreign input without the trace headers.
    if (!read.propagate || isForeignInput(input)) {
      return plan;
    }

    try {
      const trace = this.ctx.tracing.request();
      const injected = Object.entries(trace.headers);

      if (input instanceof Request) {
        // Do not spread a non-empty init with a Request input. That runs the Request
        // constructor on `input` again and reads its body. A second read of a body
        // causes a TypeError.
        const headers = new Headers(input.headers);
        for (const [key, value] of injected) {
          headers.set(key, value);
        }
        plan.input = new Request(input, { headers });
      } else {
        const headers = new Headers(init?.headers);
        for (const [key, value] of injected) {
          headers.set(key, value);
        }
        plan.init = { ...init, headers };
      }

      // Record the client span only for a request that carries its traceparent.
      plan.span = trace.span;
    } catch (error) {
      // Send the request that the caller gave, without changes. A missing header is
      // better than a failed request.
      plan.input = input;
      plan.init = init;
      this.ctx.diagnostics.report(
        "capture.header_failed",
        "The library could not add the traceparent header. It sends the request unchanged.",
        { url },
        error,
      );
    }

    return plan;
  }

  /** Instruments XMLHttpRequest open and send prototype methods. */
  private installXhr(): void {
    if (typeof XMLHttpRequest === "undefined") {
      return;
    }

    // Uninstall clears the flag. A wrapper that stays in place then only calls the original.
    let active = true;
    const ctx = this.ctx;
    const ignored = (url: string): boolean => this.ignored(url);
    const propagates = (url: string): boolean => this.propagates(url);
    const record = (meta: XhrMeta, status: number, durationMs: number): void => {
      this.record(meta.method, meta.url, status, durationMs, undefined, meta.span);
    };

    const proto = xhrMethods();

    const restoreOpen = patch(
      proto,
      "open",
      (originalOpen) =>
        function (this: Tracked, method: unknown, url: unknown, ...rest: never[]) {
          if (active) {
            // A read here runs inside the open call of the caller. A throw must not fail it.
            ctx.diagnostics.guard(
              "capture.record_failed",
              "The library could not read an XMLHttpRequest. It does not record the request.",
              () => {
                this.__uiobs = { method: toMethod(method), url: readUrl(url), startedAt: 0 };
              },
            );
          }
          originalOpen.apply(this, [method, url, ...rest] as never[]);
        },
    );

    const restoreSend = patch(
      proto,
      "send",
      (originalSend) =>
        function (this: Tracked, ...args: never[]) {
          const meta = active ? this.__uiobs : undefined;
          if (meta) {
            ctx.diagnostics.guard(
              "capture.record_failed",
              `The library could not record ${meta.method} ${meta.url}.`,
              () => {
                if (ignored(meta.url)) {
                  return;
                }

                meta.startedAt = performance.now();
                // A reused XHR gets a new listener at each send. The old one must not fire again.
                this.addEventListener(
                  "loadend",
                  () => {
                    record(meta, this.status, performance.now() - meta.startedAt);
                  },
                  { once: true },
                );

                // setRequestHeader works only between open and send.
                if (propagates(meta.url)) {
                  meta.span = addTraceHeaders(this, meta.url, ctx);
                }
              },
            );
          }
          originalSend.apply(this, args);
        },
    );

    this.restores.push(() => {
      active = false;
      restoreOpen();
      restoreSend();
    });
  }

  /**
   * Records request outcome attributes and breadcrumb entry.
   * @param method Uppercase HTTP method.
   * @param target Request target URL. The method removes the query unless you set fullUrls.
   * @param status HTTP response status code, or 0 on failure.
   * @param durationMs Request duration in milliseconds.
   * @param error Caught error instance on failed requests.
   * @param span Client span that the traceparent of the request names.
   */
  private record(
    method: string,
    target: string,
    status: number,
    durationMs: number,
    error: unknown,
    span?: ClientSpan,
  ): void {
    // Remove the query here, not at the call sites. ignoreUrls and propagateTraceHeaderTo
    // match on the full URL. Only the recorded URL loses the query string.
    const url = recordedUrl(target, this.ctx.config.capture.fullUrls);

    // A request of the transport after an await records a value. That value causes the next send.
    if (!this.warnedTransport && isTransportPending()) {
      this.warnedTransport = true;
      this.ctx.diagnostics.report(
        "capture.transport_request",
        `Network capture saw ${method} ${url} during a custom transport call. If the transport sends this request, add its URL to capture.ignoreUrls.`,
      );
    }

    // The histogram has its own guard. A URL that does not parse must not stop the record.
    if (this.ctx.config.capture.httpMetrics) {
      this.ctx.diagnostics.guard(
        "capture.record_failed",
        `The library could not record the duration of ${method} ${url}.`,
        () => {
          const attributes = durationAttributes(method, target, status, error);
          this.ctx.recordMetric(HTTP_DURATION, durationMs / MS_PER_SECOND, attributes);
        },
      );
    }

    if (span) {
      this.ctx.diagnostics.guard(
        "capture.record_failed",
        `The library could not record the span of ${method} ${url}.`,
        () => {
          const endMs = Date.now();
          this.ctx.recordSpan({
            ...span,
            name: method,
            kind: "client",
            startMs: endMs - durationMs,
            endMs,
            error: status === 0 || status >= 400,
            attributes: { ...durationAttributes(method, target, status, error), "url.full": url },
          });
        },
      );
    }

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

/**
 * Adds the trace headers to an open XHR. A failure sends the request without them.
 * @param xhr Request between open and send.
 * @param url Request target URL, for the diagnostic.
 * @param ctx Capture context with tracing and diagnostics.
 * @returns The client span that the traceparent names, or undefined.
 */
function addTraceHeaders(
  xhr: XMLHttpRequest,
  url: string,
  ctx: CaptureContext,
): ClientSpan | undefined {
  try {
    const trace = ctx.tracing.request();
    for (const [key, value] of Object.entries(trace.headers)) {
      xhr.setRequestHeader(key, value);
    }
    return trace.span;
  } catch (error) {
    ctx.diagnostics.report(
      "capture.header_failed",
      "The library could not add the traceparent header. It sends the request unchanged.",
      { url },
      error,
    );
    return undefined;
  }
}

// src/capture/network.ts
//
// Instruments fetch and XMLHttpRequest to record the outcome and timing of network requests.

import { SERVER_TIMING_HEADER } from "../constants";
import { readServerTiming, xhrServerTiming } from "./server-timing";
import type { InstrumentDef, MetricAttributes } from "../models/metric";
import { isErrorLike } from "../utils/error-like";
import { isLibraryRequest, isTransportPending } from "../utils/library-request";
import { patch } from "../utils/patch";
import { recordedUrl } from "../utils/platform";
import type { ClientSpan } from "../utils/tracing";
import { type Capture, type CaptureContext, matchesAny } from "./types";

/** Signature of the global fetch function. */
type FetchFn = typeof fetch;

/** Milliseconds in one second. The histogram is in seconds, as its OpenTelemetry name says. */
const MS_PER_SECOND = 1000;

/**
 * The HTTP client duration histogram from the OpenTelemetry semantic conventions, with the
 * boundaries the conventions recommend.
 */
const HTTP_DURATION: InstrumentDef = {
  name: "http.client.request.duration",
  kind: "histogram",
  unit: "s",
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
};

/**
 * Builds the low-cardinality attributes for one request. The path and the query stay out,
 * because every distinct attribute value creates a new series in the backend.
 * @param method Uppercase HTTP method.
 * @param url Request URL.
 * @param status HTTP status code, or 0 when no response came.
 * @param error What failed, for a request with no response.
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
    // A request with no response takes its error's type, for example TypeError.
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

/** Request data the XHR wrapper keeps from open to send. */
interface XhrMeta {
  /** The delivery context when the request started. */
  routingContextId?: string;
  /** Uppercase HTTP method. */
  method: string;
  /** Request target URL. */
  url: string;
  /** Performance timestamp at send. */
  startedAt: number;
  /** The client span the traceparent names. */
  span?: ClientSpan;
}

/** An XMLHttpRequest with our tracking metadata attached. */
type Tracked = XMLHttpRequest & {
  __uiobs?: XhrMeta;
};

/** The XMLHttpRequest prototype methods we wrap, kept unbound. */
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
  /** The delivery context when the request started. */
  routingContextId?: string;
  /** Uppercase HTTP method. */
  method: string;
  /** Request target URL. */
  url: string;
  /** Input to pass to the original fetch. */
  input: RequestInfo | URL;
  /** Init to pass to the original fetch. */
  init: RequestInit | undefined;
  /** The client span the traceparent names. */
  span?: ClientSpan;
}

/**
 * Reads the URL from a fetch input or an XHR URL argument.
 * A Request from another realm fails `instanceof Request`, but its `url` property still works.
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

  // fetch accepts anything with a text form.
  return String(input);
}

/**
 * Reads the method of a fetch call. The init's method wins over the Request's.
 * @param input Fetch input.
 * @param init Fetch init.
 * @returns Uppercase method. Defaults to GET.
 */
function readFetchMethod(input: unknown, init: RequestInit | undefined): string {
  let requested: unknown = init?.method;

  if (requested === undefined && typeof input === "object" && input !== null) {
    requested = (input as { method?: unknown }).method;
  }

  return toMethod(requested ?? "GET");
}

/**
 * Checks whether a fetch input is an object that isn't a Request or a URL from this realm,
 * for example a Request from an iframe.
 * @param input Fetch input.
 * @returns True for a foreign object.
 */
function isForeignInput(input: unknown): boolean {
  return typeof input === "object" && !(input instanceof URL) && !(input instanceof Request);
}

/**
 * Converts a method argument to text. Never throws on a method that isn't a string.
 * @param method The caller's method argument.
 * @returns The uppercase method for a string, or the text form of anything else.
 */
function toMethod(method: unknown): string {
  return typeof method === "string" ? method.toUpperCase() : String(method);
}

/** Instruments global fetch and XMLHttpRequest to capture request durations and outcomes. */
export class NetworkCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "network";

  /** Guards against wrapping a function twice. */
  private installed = false;

  /** Restore functions for the installed wrappers. */
  private readonly restores: (() => void)[] = [];

  /** True once we've reported a request made during a custom transport call. Reported once. */
  private warnedTransport = false;

  /**
   * @param ctx Capture context: configuration, diagnostics, logger, breadcrumbs and tracing.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Instruments the network APIs the configuration selects. */
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
   * Restores every host function that still holds this capture's wrapper.
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
   * Checks whether a URL matches the ignore patterns.
   * @param url Request target URL.
   * @returns True if the URL must stay out of the telemetry.
   */
  private ignored(url: string): boolean {
    // resolveConfig always adds the endpoint to ignoreUrls. Otherwise a failed POST becomes a
    // log record, the record causes a new POST, and the loop never stops.
    // A custom transport has no known URL, but its request starts inside the library scope.
    return isLibraryRequest() || matchesAny(url, this.ctx.config.capture.ignoreUrls);
  }

  /**
   * Checks whether a request gets the trace headers.
   * @param url Request target URL.
   * @returns True if the URL is in propagateTraceHeaderTo.
   */
  private propagates(url: string): boolean {
    // Only add headers to allowlisted URLs. A traceparent on a third-party request triggers
    // a CORS preflight that the third party doesn't answer, and its API stops working.
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

  /** Wraps globalThis.fetch to inject the trace headers and log the outcome. */
  private installFetch(): void {
    if (typeof globalThis.fetch !== "function") {
      return;
    }

    // Uninstall clears the flag, so a wrapper that stays in place only calls the original.
    let active = true;
    const prepare = (input: RequestInfo | URL, init: RequestInit | undefined) =>
      this.prepareFetch(input, init);
    const record = (
      plan: FetchPlan,
      status: number,
      durationMs: number,
      error: unknown,
      readTiming?: () => string | null,
    ): void => {
      this.record(
        plan.method,
        plan.url,
        status,
        durationMs,
        error,
        plan.span,
        plan.routingContextId,
        readTiming,
      );
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
          record(plan, response.status, performance.now() - startedAt, undefined, () =>
            response.headers.get(SERVER_TIMING_HEADER),
          );
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
   * @param input The caller's fetch input.
   * @param init The caller's fetch init.
   * @returns The plan, or undefined to send the request unchanged and record nothing.
   */
  private prepareFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): FetchPlan | undefined {
    // This read runs inside the caller's fetch call, so a throw must not fail the request.
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
    const plan: FetchPlan = {
      method,
      url,
      input,
      init,
      routingContextId: this.ctx.config.securityContext.id,
    };
    // An init with headers replaces every header on a foreign Request, Authorization
    // included. So a foreign input goes out without the trace headers.
    if (!read.propagate || isForeignInput(input)) {
      return plan;
    }

    try {
      const trace = this.ctx.tracing.request();
      const injected = Object.entries(trace.headers);

      if (input instanceof Request) {
        // Don't spread a non-empty init next to a Request input. That runs the Request
        // constructor on `input` again and reads its body, and reading a body twice
        // throws a TypeError.
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

      // Only record the client span for a request that actually carries its traceparent.
      plan.span = trace.span;
    } catch (error) {
      // Send exactly what the caller gave us. A missing header is better than a failed
      // request.
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

  /** Wraps the open and send methods on the XMLHttpRequest prototype. */
  private installXhr(): void {
    if (typeof XMLHttpRequest === "undefined") {
      return;
    }

    // Uninstall clears the flag, so a wrapper that stays in place only calls the original.
    let active = true;
    const ctx = this.ctx;
    const ignored = (url: string): boolean => this.ignored(url);
    const propagates = (url: string): boolean => this.propagates(url);
    const record = (
      meta: XhrMeta,
      status: number,
      durationMs: number,
      readTiming: () => string | null,
    ): void => {
      this.record(
        meta.method,
        meta.url,
        status,
        durationMs,
        undefined,
        meta.span,
        meta.routingContextId,
        readTiming,
      );
    };

    const proto = xhrMethods();

    const restoreOpen = patch(
      proto,
      "open",
      (originalOpen) =>
        function (this: Tracked, method: unknown, url: unknown, ...rest: never[]) {
          if (active) {
            // This read runs inside the caller's open call, so a throw must not fail it.
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
                meta.routingContextId = ctx.config.securityContext.id;
                // A reused XHR gets a new listener on every send, so the old one must not
                // fire again.
                this.addEventListener(
                  "loadend",
                  () => {
                    record(meta, this.status, performance.now() - meta.startedAt, () =>
                      xhrServerTiming(this.getAllResponseHeaders()),
                    );
                  },
                  { once: true },
                );

                // setRequestHeader only works between open and send.
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
   * Records the outcome of a request as attributes and a breadcrumb.
   * @param method Uppercase HTTP method.
   * @param target Request target URL. The query is removed here unless you set fullUrls.
   * @param status HTTP response status code, or 0 on failure.
   * @param durationMs Request duration in milliseconds.
   * @param error The caught error, for a failed request.
   * @param span The client span the request's traceparent names.
   */
  private record(
    method: string,
    target: string,
    status: number,
    durationMs: number,
    error: unknown,
    span?: ClientSpan,
    routingContextId?: string,
    readTiming?: () => string | null,
  ): void {
    if (
      this.ctx.isActive?.() === false ||
      (this.ctx.config.securityContext.isolation &&
        routingContextId !== undefined &&
        routingContextId !== this.ctx.config.securityContext.id)
    ) {
      return;
    }

    const timing =
      this.ctx.config.capture.serverTiming && readTiming
        ? this.ctx.diagnostics.guard(
            "capture.record_failed",
            "The library could not read the Server-Timing response header.",
            () => readServerTiming(readTiming()),
          )
        : undefined;

    // Strip the query here, not at the call sites. ignoreUrls and propagateTraceHeaderTo
    // match on the full URL, and only the recorded URL loses its query string.
    const url = recordedUrl(
      target,
      this.ctx.config.capture.fullUrls,
      this.ctx.config.capture.urlTransform,
      this.ctx.diagnostics,
    );

    // A transport request made after an await gets recorded, and that record causes the next
    // send.
    if (!this.warnedTransport && isTransportPending()) {
      this.warnedTransport = true;
      this.ctx.diagnostics.report(
        "capture.transport_request",
        `Network capture saw ${method} ${url} during a custom transport call. If the transport sends this request, add its URL to capture.ignoreUrls.`,
      );
    }

    // The histogram has its own guard, so a URL that doesn't parse can't stop the record.
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
            link: timing?.link,
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

    // This runs inside the caller's fetch call, so an error here must not fail the caller's
    // request.
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
          ...(timing && timing.entries.length > 0 ? { "server.timing": timing.entries } : {}),
        };

        if (status === 0) {
          this.ctx.logger.error(`${method} ${url} failed`, error, attributes);
          return;
        }
        if (status >= 400) {
          this.ctx.logger.warn(`${method} ${url} returned ${String(status)}`, attributes);
          return;
        }

        // Log a success at DEBUG, which the default minLevel of INFO drops. That way only
        // failures use bandwidth.
        this.ctx.logger.debug(`${method} ${url}`, attributes);
      },
    );
  }
}

/**
 * Adds the trace headers to an open XHR. If that fails, the request goes out without them.
 * @param xhr A request between open and send.
 * @param url Request target URL, for the diagnostic.
 * @param ctx Capture context with tracing and diagnostics.
 * @returns The client span the traceparent names, or undefined.
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

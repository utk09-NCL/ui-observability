import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCapture } from "../src/capture/errors";
import { InteractionCapture } from "../src/capture/interactions";
import { NetworkCapture } from "../src/capture/network";
import { matchesAny } from "../src/capture/types";
import type { CaptureContext, CaptureLogger } from "../src/capture/types";
import { WebVitalsCapture } from "../src/capture/web-vitals";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { resolveConfig } from "../src/core/config";
import { Diagnostics, type DiagnosticEvent } from "../src/core/diagnostics";
import type { ObservabilityConfig, WebVitalsMetric } from "../src/models/config";
import { TraceEngine } from "../src/utils/tracing";

/** A logger whose every method is a spy, so a test can read what was recorded. */
interface SpyLogger {
  error: ReturnType<typeof vi.fn<CaptureLogger["error"]>>;
  warn: ReturnType<typeof vi.fn<CaptureLogger["warn"]>>;
  logEvent: ReturnType<typeof vi.fn<CaptureLogger["logEvent"]>>;
  logMetric: ReturnType<typeof vi.fn<CaptureLogger["logMetric"]>>;
  debug: ReturnType<typeof vi.fn<CaptureLogger["debug"]>>;
}

const INGEST = "https://ingest.example/v1/logs";

/**
 * Builds a capture context around a spy logger.
 * @param over Capture settings layered over errors and rejections on.
 * @returns The context and the spy logger inside it.
 */
function ctx(over: Partial<ObservabilityConfig["capture"]> = {}): {
  ctx: CaptureContext;
  logger: SpyLogger;
} {
  const diagnostics = new Diagnostics(vi.fn<(event: DiagnosticEvent) => void>(), 0);
  const logger: SpyLogger = {
    error: vi.fn<CaptureLogger["error"]>(),
    warn: vi.fn<CaptureLogger["warn"]>(),
    logEvent: vi.fn<CaptureLogger["logEvent"]>(),
    logMetric: vi.fn<CaptureLogger["logMetric"]>(),
    debug: vi.fn<CaptureLogger["debug"]>(),
  };

  return {
    logger,
    ctx: {
      config: resolveConfig(
        {
          endpoint: INGEST,
          serviceName: "svc",
          capture: { errors: true, rejections: true, ...over },
        },
        diagnostics,
      ),
      diagnostics,
      logger,
      breadcrumbs: new BreadcrumbBuffer(10),
      tracing: new TraceEngine(diagnostics),
    },
  };
}

/**
 * Builds an unhandledrejection event, which happy-dom does not construct.
 * @param reason The rejection value.
 * @returns The dispatchable event.
 */
function rejectionEvent(reason: unknown): Event {
  return Object.assign(new Event("unhandledrejection"), { reason });
}

describe("capture/types: matchesAny", () => {
  it("matches a string on substring and a regular expression on test", () => {
    expect(matchesAny("https://api.internal/orders", ["api.internal"])).toBe(true);
    expect(matchesAny("https://api.internal/orders", [/\/orders$/])).toBe(true);
    expect(matchesAny("https://api.internal/orders", ["other", /nope/])).toBe(false);
  });

  it("matches nothing against an empty pattern list", () => {
    expect(matchesAny("https://api.internal/orders", [])).toBe(false);
  });
});

describe("ErrorCapture", () => {
  it("logs an uncaught error once and deduplicates the repeat", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    for (let i = 0; i < 5; i++) {
      dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom" }));
    }

    expect(logger.error).toHaveBeenCalledTimes(1);
    capture.uninstall();
  });

  it("reports how many repeats it swallowed once the dedupe window rolls over", () => {
    vi.useFakeTimers();
    const { ctx: c, logger } = ctx({ errorDedupeMs: 50 });
    const capture = new ErrorCapture(c);
    capture.install();

    // One Error object, so the deduplication key is identical every time.
    const boom = new Error("boom");
    for (let i = 0; i < 4; i++) {
      dispatchEvent(new ErrorEvent("error", { error: boom, message: "boom" }));
    }
    vi.setSystemTime(Date.now() + 100);
    dispatchEvent(new ErrorEvent("error", { error: boom, message: "boom" }));

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[1][2]).toMatchObject({ "error.suppressed_count": 3 });
    capture.uninstall();
    vi.useRealTimers();
  });

  it("falls back to the event message when no error object was attached", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(new ErrorEvent("error", { message: "script parse failed" }));

    expect(logger.error).toHaveBeenCalledWith(
      "script parse failed",
      expect.any(Error),
      expect.objectContaining({ "error.captured_by": "window.onerror" }),
    );
    capture.uninstall();
  });

  it("names the source only when the error itself carries no message", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    // No error object and no message: the built Error carries the fallback.
    dispatchEvent(new ErrorEvent("error", { message: "" }));
    // An error object whose own message is empty: nothing is left to name it by.
    dispatchEvent(new ErrorEvent("error", { error: new Error(""), message: "" }));

    expect(logger.error.mock.calls[0][0]).toBe("unknown error");
    expect(logger.error.mock.calls[1][0]).toBe("window.onerror");
    capture.uninstall();
  });

  it("logs a failed resource only when resourceErrors is on", () => {
    const { ctx: c, logger } = ctx({ resourceErrors: true });
    const capture = new ErrorCapture(c);
    capture.install();

    document.body.innerHTML = `<img id="broken" src="https://cdn.example/missing.png" />`;
    document.querySelector("#broken")!.dispatchEvent(new Event("error"));

    expect(logger.warn).toHaveBeenCalledWith(
      "resource failed to load",
      expect.objectContaining({ "error.type": "resource", "resource.tag": "img" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(c.breadcrumbs.snapshot().at(-1)).toMatchObject({ category: "http" });
    capture.uninstall();
  });

  it("stays quiet about a failed resource when resourceErrors is off", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    document.body.innerHTML = `<img id="broken" src="https://cdn.example/missing.png" />`;
    document.querySelector("#broken")!.dispatchEvent(new Event("error"));

    expect(logger.warn).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("reads a link's href when the failed element has no src", () => {
    const { ctx: c, logger } = ctx({ resourceErrors: true });
    const capture = new ErrorCapture(c);
    capture.install();

    document.body.innerHTML = `<link id="sheet" href="https://cdn.example/missing.css" />`;
    document.querySelector("#sheet")!.dispatchEvent(new Event("error"));

    expect(logger.warn).toHaveBeenCalledWith(
      "resource failed to load",
      expect.objectContaining({ "resource.url": "https://cdn.example/missing.css" }),
    );
    capture.uninstall();
  });

  it("stays quiet when errors are switched off", () => {
    const { ctx: c, logger } = ctx({ errors: false });
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom" }));

    expect(logger.error).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("stays quiet when rejections are switched off", () => {
    const { ctx: c, logger } = ctx({ rejections: false });
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(rejectionEvent(new Error("promise boom")));

    expect(logger.error).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("captures an unhandled rejection, including one that rejected with a string", () => {
    const { ctx: c, logger } = ctx({ errorDedupeMs: 0 });
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(rejectionEvent(new Error("promise boom")));
    dispatchEvent(rejectionEvent("just a string"));

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[1][1]).toBeInstanceOf(Error);
    capture.uninstall();
  });

  it("bounds the deduplication map, so a fresh message per render cannot grow it forever", () => {
    const { ctx: c, logger } = ctx({ errorDedupeMs: 60_000 });
    const capture = new ErrorCapture(c);
    capture.install();

    // Distinct signatures, above the tracked cap, spread over enough windows
    // that the rate limiter does not swallow them all.
    vi.useFakeTimers();
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 15; i++) {
        dispatchEvent(
          new ErrorEvent("error", { error: new Error(`row ${String(round)}-${String(i)}`) }),
        );
      }
      vi.setSystemTime(Date.now() + 20_000);
    }
    vi.useRealTimers();

    // The map is bounded, so eviction ran without throwing and the module kept
    // reporting after passing the cap.
    expect(logger.error.mock.calls.length).toBeGreaterThan(200);
    capture.uninstall();
  });

  it("builds a signature from an error with no stack, and from a one-line stack", () => {
    const { ctx: c, logger } = ctx({ errorDedupeMs: 0 });
    const capture = new ErrorCapture(c);
    capture.install();

    // A thrown value rehydrated from another realm can arrive with no stack.
    const noStack = new Error("no stack");
    Object.defineProperty(noStack, "stack", { value: undefined });
    dispatchEvent(new ErrorEvent("error", { error: noStack, message: "no stack" }));

    // A stack with no caller frame leaves nothing at index 1.
    const oneLine = new Error("one line");
    Object.defineProperty(oneLine, "stack", { value: "Error: one line" });
    dispatchEvent(new ErrorEvent("error", { error: oneLine, message: "one line" }));

    expect(logger.error).toHaveBeenCalledTimes(2);
    capture.uninstall();
  });

  it("rate limits an error storm instead of amplifying it", () => {
    const { ctx: c, logger } = ctx({ errorDedupeMs: 0 });
    const capture = new ErrorCapture(c);
    capture.install();

    for (let i = 0; i < 100; i++) {
      dispatchEvent(
        new ErrorEvent("error", {
          error: new Error(`boom ${String(i)}`),
          message: `boom ${String(i)}`,
        }),
      );
    }

    expect(logger.error.mock.calls.length).toBeLessThanOrEqual(20);
    expect(c.diagnostics.snapshot()["capture.rate_limited"]).toBeGreaterThan(0);
    capture.uninstall();
  });

  it("installs once and uninstalls once, however many times it is asked", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);

    // A second install would chain a duplicate listener and double every record.
    capture.install();
    capture.install();
    dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom" }));
    expect(logger.error).toHaveBeenCalledTimes(1);

    capture.uninstall();
    capture.uninstall();
    dispatchEvent(new ErrorEvent("error", { error: new Error("after"), message: "after" }));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("NetworkCapture: fetch", () => {
  let original: typeof fetch;

  beforeEach(() => {
    original = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = original;
  });

  it("never logs a request to the ingest endpoint, or logging feeds itself", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch(INGEST, { method: "POST" });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("records the request URL, not the page it was made from", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal/orders");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ "url.full": "https://api.internal/orders" }),
    );
    capture.uninstall();
  });

  it("reads the URL and method from a URL and from a Request", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch(new URL("https://api.internal/from-url"));
    await fetch(new Request("https://api.internal/from-request", { method: "PUT" }));

    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      "url.full": "https://api.internal/from-url",
      "http.request.method": "GET",
    });
    expect(logger.warn.mock.calls[1][1]).toMatchObject({
      "url.full": "https://api.internal/from-request",
      "http.request.method": "PUT",
    });
    capture.uninstall();
  });

  it("restores the globals on uninstall", () => {
    const { ctx: c } = ctx({ fetch: true });
    const before = globalThis.fetch;
    const capture = new NetworkCapture(c);

    capture.install();
    expect(globalThis.fetch).not.toBe(before);

    capture.uninstall();
    expect(globalThis.fetch).toBe(before);
  });

  it("patches nothing when neither fetch nor xhr capture is on", () => {
    const { ctx: c } = ctx();
    const before = globalThis.fetch;
    const capture = new NetworkCapture(c);

    capture.install();

    expect(globalThis.fetch).toBe(before);
    capture.uninstall();
  });

  it("does not chain a second wrapper when installed twice", () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    const patched = globalThis.fetch;
    capture.install();

    expect(globalThis.fetch).toBe(patched);
    expect(logger.warn).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("only adds traceparent to allowlisted targets", async () => {
    const seen: Headers[] = [];
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response("", { status: 200 }));
    });

    const { ctx: c } = ctx({ fetch: true, propagateTraceHeaderTo: ["https://api.internal"] });
    const capture = new NetworkCapture(c);
    capture.install();

    await fetch("https://api.internal/orders");
    await fetch("https://third-party.example/widget");

    expect(seen[0].get("traceparent")).toBeTruthy();
    expect(seen[1].get("traceparent")).toBeNull();
    capture.uninstall();
  });

  it("rebuilds a Request rather than spreading an init over it", async () => {
    const seen: (RequestInfo | URL)[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      seen.push(input);
      return Promise.resolve(new Response("", { status: 200 }));
    });

    const { ctx: c } = ctx({ fetch: true, propagateTraceHeaderTo: ["https://api.internal"] });
    const capture = new NetworkCapture(c);
    capture.install();

    const request = new Request("https://api.internal/orders", { method: "POST", body: "x" });
    await fetch(request);

    const sent = seen[0];
    expect(sent).toBeInstanceOf(Request);
    expect((sent as Request).headers.get("traceparent")).toBeTruthy();
    capture.uninstall();
  });

  it("sends the caller's request unchanged when the header cannot be attached", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const seen: (RequestInfo | URL)[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      seen.push(input);
      return Promise.resolve(new Response("", { status: 200 }));
    });

    const { ctx: c } = ctx({ fetch: true, propagateTraceHeaderTo: ["https://api.internal"] });
    c.diagnostics.setHandler(handler);
    const capture = new NetworkCapture(c);
    capture.install();

    // A Request whose body was already read throws on header access, which is
    // the realistic way this happens.
    const hostile = new Request("https://api.internal/orders", { method: "POST", body: "x" });
    Object.defineProperty(hostile, "headers", {
      get() {
        throw new TypeError("body already read");
      },
    });
    await fetch(hostile);

    expect(seen[0]).toBe(hostile);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "capture.header_failed" }),
    );
    capture.uninstall();
  });

  it("logs a request that rejected, with a zero status", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));

    const capture = new NetworkCapture(c);
    capture.install();

    await expect(fetch("https://api.internal/orders")).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed"),
      expect.any(TypeError),
      expect.objectContaining({ "http.response.status_code": 0 }),
    );
    capture.uninstall();
  });

  it("logs a successful request at DEBUG, so the default minLevel drops it", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 200 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal/orders");

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("never lets a fault in recording escape into the caller's request", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 200 })));

    c.diagnostics.setHandler(handler);
    logger.debug.mockImplementation(() => {
      throw new Error("logger exploded");
    });

    const capture = new NetworkCapture(c);
    capture.install();

    await expect(fetch("https://api.internal/orders")).resolves.toBeInstanceOf(Response);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "capture.record_failed" }),
    );
    capture.uninstall();
  });
});

describe("NetworkCapture: XMLHttpRequest", () => {
  /**
   * Drives one request through the patched prototype without a network.
   * @param url The URL to open.
   * @param status The status to report on loadend.
   */
  function sendXhr(url: string, status: number): void {
    const xhr = new XMLHttpRequest();
    vi.spyOn(xhr, "status", "get").mockReturnValue(status);
    xhr.open("get", url);
    xhr.send();
    xhr.dispatchEvent(new Event("loadend"));
  }

  beforeEach(() => {
    // happy-dom would otherwise attempt a real request on send().
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a completed request and uppercases its method", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();

    sendXhr("https://api.internal/orders", 200);

    expect(logger.debug).toHaveBeenCalledWith(
      "GET https://api.internal/orders",
      expect.objectContaining({ "http.request.method": "GET" }),
    );
    capture.uninstall();
  });

  it("warns on a client error and reports a zero status as a failure", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();

    sendXhr("https://api.internal/missing", 404);
    sendXhr("https://api.internal/offline", 0);

    expect(logger.warn).toHaveBeenCalledWith(
      "GET https://api.internal/missing returned 404",
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "GET https://api.internal/offline failed",
      undefined,
      expect.objectContaining({ "http.response.status_code": 0 }),
    );
    capture.uninstall();
  });

  it("never records a request to the ingest endpoint", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();

    sendXhr(INGEST, 500);

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("passes a send through untouched when open was never called", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();

    const xhr = new XMLHttpRequest();
    expect(() => {
      xhr.send();
    }).not.toThrow();
    expect(logger.debug).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("restores both prototype methods on uninstall", () => {
    const { ctx: c } = ctx({ xhr: true });
    const beforeOpen = XMLHttpRequest.prototype.open;
    const beforeSend = XMLHttpRequest.prototype.send;
    const capture = new NetworkCapture(c);

    capture.install();
    expect(XMLHttpRequest.prototype.open).not.toBe(beforeOpen);

    capture.uninstall();
    expect(XMLHttpRequest.prototype.open).toBe(beforeOpen);
    expect(XMLHttpRequest.prototype.send).toBe(beforeSend);
  });

  it("does not chain a second wrapper when installed twice", () => {
    const { ctx: c } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);

    capture.install();
    const patched = XMLHttpRequest.prototype.open;
    capture.install();

    expect(XMLHttpRequest.prototype.open).toBe(patched);
    capture.uninstall();
  });
});

describe("InteractionCapture", () => {
  it("rotates the trace on a click, so a click and everything it causes share one id", () => {
    const { ctx: c } = ctx({ interactions: true });
    const capture = new InteractionCapture(c);
    capture.install();
    const before = c.tracing.resolve().traceId;

    document.body.innerHTML = `<button id="submit">Submit</button>`;
    document.querySelector("#submit")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(c.tracing.resolve().traceId).not.toBe(before);
    expect(c.breadcrumbs.snapshot().at(-1)).toMatchObject({
      category: "click",
      message: "#submit",
    });
    capture.uninstall();
  });

  it("describes a target by test id, then id, then aria-label, then tag and class", () => {
    const { ctx: c } = ctx({ interactions: true });
    const capture = new InteractionCapture(c);
    capture.install();

    document.body.innerHTML = `
      <button data-testid="buy">a</button>
      <button id="named">b</button>
      <button aria-label="Cancel order">c</button>
      <button class="btn primary extra">d</button>
      <button>e</button>`;
    for (const element of document.querySelectorAll("button")) {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    expect(c.breadcrumbs.snapshot().map((crumb) => crumb.message)).toEqual([
      '[data-testid="buy"]',
      "#named",
      'button[aria-label="Cancel order"]',
      "button.btn.primary",
      "button",
    ]);
    capture.uninstall();
  });

  it("falls back to data-test-id and reports an unknown target", () => {
    const { ctx: c } = ctx({ interactions: true });
    const capture = new InteractionCapture(c);
    capture.install();

    document.body.innerHTML = `<button data-test-id="legacy">a</button>`;
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // An event with no target at all, which is what a synthetic dispatch on the
    // window looks like.
    dispatchEvent(new MouseEvent("click"));

    const messages = c.breadcrumbs.snapshot().map((crumb) => crumb.message);
    expect(messages).toContain('[data-testid="legacy"]');
    expect(messages).toContain("unknown");
    capture.uninstall();
  });

  it("keeps the clicked text on the breadcrumb, and omits it when there is none", () => {
    const { ctx: c } = ctx({ interactions: true });
    const capture = new InteractionCapture(c);
    capture.install();

    document.body.innerHTML = `<button id="a">Submit order</button><button id="b"></button>`;
    document.querySelector("#a")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector("#b")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const crumbs = c.breadcrumbs.snapshot();
    expect(crumbs.at(-2)?.data).toEqual({ text: "Submit order" });
    expect(crumbs.at(-1)?.data).toBeUndefined();
    capture.uninstall();
  });

  it("logs a route change and restores history on uninstall", async () => {
    const { ctx: c, logger } = ctx({ navigation: true });
    const original = history.pushState;
    const capture = new InteractionCapture(c);
    capture.install();
    expect(history.pushState).not.toBe(original);

    history.pushState({}, "", "/orders/1");
    // onNavigate is queued as a microtask: location.href only updates once
    // pushState returns.
    await Promise.resolve();

    expect(logger.logEvent).toHaveBeenCalledWith("NAVIGATION", {
      "page.url.previous": expect.any(String) as string,
    });
    // Not `url.full`: that name belongs to an HTTP request, and the record
    // builder stamps the new URL as `page.url` on its own.
    expect(logger.logEvent.mock.calls[0][1]).not.toHaveProperty("url.full");

    capture.uninstall();
    expect(history.pushState).toBe(original);
  });

  it("logs a replaceState that moved the URL", async () => {
    const { ctx: c, logger } = ctx({ navigation: true });
    const capture = new InteractionCapture(c);
    capture.install();

    history.replaceState({}, "", "/replaced/1");
    await Promise.resolve();

    expect(logger.logEvent).toHaveBeenCalledWith("NAVIGATION", expect.anything());
    capture.uninstall();
  });

  it("ignores a pushState that did not actually change the URL", async () => {
    const { ctx: c, logger } = ctx({ navigation: true });
    const capture = new InteractionCapture(c);
    capture.install();

    history.replaceState({}, "", location.href);
    await Promise.resolve();

    expect(logger.logEvent).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("responds to popstate and hashchange", () => {
    const { ctx: c, logger } = ctx({ navigation: true });
    const capture = new InteractionCapture(c);
    capture.install();

    history.replaceState({}, "", "/moved-by-hand");
    dispatchEvent(new Event("popstate"));

    expect(logger.logEvent).toHaveBeenCalledWith("NAVIGATION", expect.anything());
    capture.uninstall();
  });

  it("installs once and ignores an uninstall it never installed", () => {
    const { ctx: c } = ctx({ interactions: true, navigation: true });
    const capture = new InteractionCapture(c);

    capture.uninstall();

    const original = history.pushState;
    capture.install();
    capture.install();
    expect(history.pushState).not.toBe(original);

    capture.uninstall();
    expect(history.pushState).toBe(original);
  });

  it("patches no history in a realm that has none", () => {
    const { ctx: c, logger } = ctx({ navigation: true });
    // A worker realm has no History object at all.
    vi.stubGlobal("history", undefined);

    const capture = new InteractionCapture(c);
    expect(() => {
      capture.install();
    }).not.toThrow();

    vi.unstubAllGlobals();
    capture.uninstall();
    expect(logger.logEvent).not.toHaveBeenCalled();
  });

  it("subscribes to nothing when both interactions and navigation are off", () => {
    const { ctx: c, logger } = ctx();
    const original = history.pushState;
    const capture = new InteractionCapture(c);
    capture.install();

    document.body.innerHTML = `<button id="quiet">a</button>`;
    document.querySelector("#quiet")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(history.pushState).toBe(original);
    expect(logger.logEvent).not.toHaveBeenCalled();
    expect(c.breadcrumbs.snapshot()).toHaveLength(0);
    capture.uninstall();
  });
});

describe("WebVitalsCapture", () => {
  /** Nothing here loads the real package: the loader is the injectable seam. */
  const nullLoader = (): Promise<never> =>
    Promise.reject(new Error("Cannot find module 'web-vitals'"));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a vital through an injected loader", async () => {
    const reporters: Record<string, (metric: WebVitalsMetric) => void> = {};
    const subscribe = (name: string) => (report: (metric: WebVitalsMetric) => void) => {
      reporters[name] = report;
    };
    const { ctx: c, logger } = ctx({
      webVitals: true,
      webVitalsLoader: () =>
        Promise.resolve({
          onLCP: subscribe("lcp"),
          onCLS: subscribe("cls"),
          onINP: subscribe("inp"),
          onFCP: subscribe("fcp"),
          onTTFB: subscribe("ttfb"),
        }),
    });

    const capture = new WebVitalsCapture(c);
    capture.install();
    await vi.waitFor(() => {
      expect(reporters.lcp).toBeTypeOf("function");
    });

    reporters.lcp({ value: 1234.5678, id: "v1", rating: "good" });

    expect(logger.logMetric).toHaveBeenCalledWith("web_vitals.lcp", 1234.568, "ms", "gauge", {
      "metric.rating": "good",
      "metric.id": "v1",
    });
    capture.uninstall();
  });

  it("says what is missing when the optional peer is not installed", async () => {
    const { ctx: c } = ctx({ webVitals: true, webVitalsLoader: nullLoader });

    new WebVitalsCapture(c).install();

    await vi.waitFor(() => {
      expect(c.diagnostics.snapshot()["capture.install_failed"]).toBeGreaterThan(0);
    });
  });

  it("goes through the default loader when none is injected", async () => {
    const { ctx: c } = ctx({ webVitals: true });
    const guardAsync = vi.spyOn(c.diagnostics, "guardAsync");

    new WebVitalsCapture(c).install();

    // Asserts the default path was taken. Whether the peer reports a vital in
    // this environment is not what is under test, and is not deterministic.
    await vi.waitFor(() => {
      expect(guardAsync).toHaveBeenCalledWith(
        "capture.install_failed",
        "loading web-vitals",
        expect.any(Function),
      );
    });
  });

  it("emits navigation timing, and skips a measurement that is not real", () => {
    const { ctx: c, logger } = ctx({ webVitals: true, webVitalsLoader: nullLoader });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      {
        domainLookupEnd: 10,
        domainLookupStart: 5,
        connectEnd: 8,
        connectStart: 6,
        responseStart: 20,
        requestStart: 15,
        responseEnd: 30,
        domInteractive: 40,
        domComplete: 50,
        // Not finished at read time. Reporting -1 as a duration poisons the
        // percentile chart it lands in.
        loadEventEnd: -1,
        type: "navigate",
      } as never,
    ]);

    new WebVitalsCapture(c).install();

    const names = logger.logMetric.mock.calls.map((call) => call[0]);
    expect(names).toContain("navigation.dns_ms");
    expect(names).not.toContain("navigation.load_ms");
  });

  it("returns quietly when there is no navigation entry at all", () => {
    const { ctx: c, logger } = ctx({ webVitals: true, webVitalsLoader: nullLoader });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);

    new WebVitalsCapture(c).install();

    expect(logger.logMetric).not.toHaveBeenCalled();
  });

  it("reads navigation timing once, however many times it is installed", () => {
    const { ctx: c, logger } = ctx({ webVitals: true, webVitalsLoader: nullLoader });
    // happy-dom reports no navigation entry, so one is supplied here.
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { domainLookupEnd: 10, domainLookupStart: 5, type: "navigate" } as never,
    ]);
    const capture = new WebVitalsCapture(c);

    capture.install();
    const first = logger.logMetric.mock.calls.length;
    capture.install();

    expect(logger.logMetric.mock.calls.length).toBe(first);

    capture.uninstall();
    capture.install();
    expect(logger.logMetric.mock.calls.length).toBeGreaterThan(first);
  });
});

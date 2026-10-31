import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCapture } from "../src/capture/errors";
import { InteractionCapture } from "../src/capture/interactions";
import { NetworkCapture } from "../src/capture/network";
import { matchesAny } from "../src/capture/types";
import type { CaptureContext, CaptureLogger } from "../src/capture/types";
import { WebVitalsCapture } from "../src/capture/web-vitals";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { ERROR_DEDUPE_MS } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics, type DiagnosticEvent } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig, WebVitalsMetric } from "../src/models/config";
import { CustomTransport } from "../src/transport/custom-transport";
import { runAsLibraryRequest } from "../src/utils/library-request";
import { type SpanHooks, TraceEngine } from "../src/utils/tracing";

/** A logger with a spy for each method. A test can read what the logger recorded. */
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
 * @param spans Span decisions of the trace engine. Without them, spans are off.
 * @returns The context and the spy logger inside it.
 */
function ctx(
  over: Partial<ObservabilityConfig["capture"]> = {},
  spans?: SpanHooks,
): {
  ctx: CaptureContext;
  logger: SpyLogger;
  recordMetric: ReturnType<typeof vi.fn<CaptureContext["recordMetric"]>>;
  recordSpan: ReturnType<typeof vi.fn<CaptureContext["recordSpan"]>>;
} {
  const recordMetric = vi.fn<CaptureContext["recordMetric"]>();
  const recordSpan = vi.fn<CaptureContext["recordSpan"]>();
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
    recordMetric,
    recordSpan,
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
      tracing: new TraceEngine(diagnostics, undefined, undefined, spans),
      // Fresh per context, as a new runtime gets a fresh set.
      once: { webVitals: false, navigationTiming: false, longFrames: false },
      recordMetric,
      recordSpan,
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

  it("matches nothing for a URL that is not a string", () => {
    expect(matchesAny(undefined as unknown as string, ["https://api.internal"])).toBe(false);
  });

  it("matches nothing against an empty pattern list", () => {
    expect(matchesAny("https://api.internal/orders", [])).toBe(false);
  });
});

describe("ErrorCapture", () => {
  it("removes the user info and the query from the script URL of an uncaught error", () => {
    // A signed CDN URL is a credential.
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("source"),
        message: "source",
        filename: "https://user:pw@cdn.example/app.js?Signature=abc",
      }),
    );

    expect(logger.error.mock.calls[0][2]).toMatchObject({
      "error.source": "https://cdn.example/app.js",
    });
    capture.uninstall();
  });

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
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    // One Error object, so the deduplication key is identical every time.
    const boom = new Error("boom");
    for (let i = 0; i < 4; i++) {
      dispatchEvent(new ErrorEvent("error", { error: boom, message: "boom" }));
    }
    vi.setSystemTime(Date.now() + ERROR_DEDUPE_MS + 1);
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

    // The call gives no error object and no message. The built Error has the fallback message.
    dispatchEvent(new ErrorEvent("error", { message: "" }));
    // The own message of the error object is empty. The error has no other text that names it.
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

  it("records a failed resource without its query string", () => {
    const { ctx: c, logger } = ctx({ resourceErrors: true });
    const capture = new ErrorCapture(c);
    capture.install();

    document.body.innerHTML = `<img id="shot" src="https://cdn.example/a.png?sig=secret" />`;
    document.querySelector("#shot")!.dispatchEvent(new Event("error"));

    expect(logger.warn).toHaveBeenCalledWith(
      "resource failed to load",
      expect.objectContaining({ "resource.url": "https://cdn.example/a.png" }),
    );
    capture.uninstall();
  });

  it("keeps the whole resource URL when the consumer asks for it", () => {
    const { ctx: c, logger } = ctx({ resourceErrors: true, fullUrls: true });
    const capture = new ErrorCapture(c);
    capture.install();

    document.body.innerHTML = `<img id="kept" src="https://cdn.example/b.png?sig=secret" />`;
    document.querySelector("#kept")!.dispatchEvent(new Event("error"));

    expect(logger.warn).toHaveBeenCalledWith(
      "resource failed to load",
      expect.objectContaining({ "resource.url": "https://cdn.example/b.png?sig=secret" }),
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
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(rejectionEvent(new Error("promise boom")));
    dispatchEvent(rejectionEvent("just a string"));

    expect(logger.error).toHaveBeenCalledTimes(2);
    // The logger converts the reason. It keeps a non-Error reason as error.data.
    expect(logger.error.mock.calls[1][0]).toBe("just a string");
    expect(logger.error.mock.calls[1][1]).toBe("just a string");
    capture.uninstall();
  });

  it("gives an Error to the logger for a rejection with no reason", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(rejectionEvent(undefined));

    const reason = logger.error.mock.calls[0][1];
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("undefined");
    capture.uninstall();
  });

  it("reads the message and stack of an error from another realm", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();
    // An error from an iframe fails instanceof Error in this realm.
    const foreign = {
      name: "TypeError",
      message: "x is undefined",
      stack: "TypeError: x is undefined\n    at render (app.js:1:1)",
    };

    dispatchEvent(rejectionEvent(foreign));
    dispatchEvent(rejectionEvent(foreign));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "x is undefined",
      foreign,
      expect.objectContaining({ "error.captured_by": "unhandledrejection" }),
    );
    capture.uninstall();
  });

  it("records a reason that has no text form, and reports it", () => {
    const { ctx: c, logger } = ctx();
    const capture = new ErrorCapture(c);
    capture.install();
    const reason = Object.create(null) as object;

    dispatchEvent(rejectionEvent(reason));

    expect(logger.error).toHaveBeenCalledWith(
      "unhandledrejection",
      reason,
      expect.objectContaining({ "error.captured_by": "unhandledrejection" }),
    );
    expect(c.diagnostics.snapshot()["capture.record_failed"]).toBe(1);
    capture.uninstall();
  });

  it("bounds the deduplication map, so a fresh message per render cannot grow it forever", () => {
    const { ctx: c, logger } = ctx();
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

    // The map has a size limit. The eviction ran without a throw. The module continued to report
    // after the cap.
    expect(logger.error.mock.calls.length).toBeGreaterThan(200);
    capture.uninstall();
  });

  it("builds a signature from an error with no stack, and from a one-line stack", () => {
    const { ctx: c, logger } = ctx();
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
    const { ctx: c, logger } = ctx();
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

    // A second install adds a duplicate listener. Each record then occurs two times.
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

  it("removes the user info from a recorded URL, also with fullUrls", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 200 })));
    const { ctx: c, logger } = ctx({ fetch: true, fullUrls: true });
    const capture = new NetworkCapture(c);
    capture.install();

    await fetch("https://user:pass@api.internal/orders?id=7");

    expect(logger.debug).toHaveBeenCalledWith(
      "GET https://api.internal/orders?id=7",
      expect.objectContaining({ "url.full": "https://api.internal/orders?id=7" }),
    );
    capture.uninstall();
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

  it("never logs a fetch that a custom transport starts", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await runAsLibraryRequest(() => fetch("https://telemetry.app.internal/logs"));

    expect(logger.warn).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("reports one time a fetch that starts during a custom transport call", async () => {
    // A fetch after an await is outside the library request scope. Each send then records a value,
    // and that value causes the next send.
    const { ctx: c } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const capture = new NetworkCapture(c);
    capture.install();

    const own = new Diagnostics(vi.fn(), 0);
    const send = async () => {
      await Promise.resolve();
      await fetch("https://telemetry.app.internal/metrics");
      return { status: 204 };
    };
    const transport = new CustomTransport(
      resolveConfig({ endpoint: null, serviceName: "svc", transport: send }, own),
      own,
    );
    const batch: LogBatch = {
      id: "b1",
      createdAt: 0,
      attempts: 0,
      records: [
        {
          timeUnixNano: "1755543600123000000",
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
          severityNumber: 9,
          severityText: "INFO",
          body: "x",
          attributes: {},
          resource: {},
        },
      ],
    };

    await transport.send(batch);
    await transport.send(batch);
    await fetch("https://api.internal/orders");

    expect(c.diagnostics.snapshot()["capture.transport_request"]).toBe(1);
    capture.uninstall();
  });

  it("records the duration histogram in seconds with the attributes of the semantic conventions", async () => {
    const { ctx: c, recordMetric } = ctx({ fetch: true });
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal:8443/orders/42?token=secret", { method: "post" });
    await fetch("https://api.internal/orders");

    // The path, the query and the port stay out. Each value makes a new series in the backend.
    expect(
      recordMetric.mock.calls.map(([def, , attributes]) => [def.name, def.unit, attributes]),
    ).toEqual([
      [
        "http.client.request.duration",
        "s",
        {
          "http.request.method": "POST",
          "server.address": "api.internal",
          "http.response.status_code": 503,
          "error.type": "503",
        },
      ],
      [
        "http.client.request.duration",
        "s",
        {
          "http.request.method": "GET",
          "server.address": "api.internal",
          "http.response.status_code": 200,
        },
      ],
    ]);
    expect(recordMetric.mock.calls[0][1]).toBeLessThan(1);
    capture.uninstall();
  });

  it("gives a request without a response the type of its error", async () => {
    const { ctx: c, recordMetric } = ctx({ fetch: true });
    globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("network down"));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal/a").catch(() => undefined);

    expect(recordMetric.mock.calls[0][2]).toEqual({
      "http.request.method": "GET",
      "server.address": "api.internal",
      "error.type": "TypeError",
    });
    capture.uninstall();
  });

  it("gives a rejection that is not an error the type _OTHER", async () => {
    const { ctx: c, recordMetric } = ctx({ fetch: true });
    // A script can reject with any value. This value is not an error.
    globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValueOnce("nope");

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal/a").catch(() => undefined);

    expect(recordMetric.mock.calls[0][2]).toMatchObject({ "error.type": "_OTHER" });
    capture.uninstall();
  });

  it("reads the server of a relative URL from the page", async () => {
    vi.stubGlobal("location", { href: "https://app.example/blotter" });
    const { ctx: c, recordMetric } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 204 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("/api/orders");

    expect(recordMetric.mock.calls[0][2]).toMatchObject({ "server.address": "app.example" });
    capture.uninstall();
  });

  it("reports a URL that does not parse, and still logs the request", async () => {
    // A worker or a host without location has no base for a relative URL.
    vi.stubGlobal("location", undefined);
    const { ctx: c, logger, recordMetric } = ctx({ fetch: true });
    const report = vi.spyOn(c.diagnostics, "report");
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("/api/orders");

    expect(recordMetric).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      "capture.record_failed",
      expect.stringContaining("duration"),
      undefined,
      expect.any(TypeError),
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    capture.uninstall();
  });

  it("records no histogram with httpMetrics off", async () => {
    const { ctx: c, recordMetric } = ctx({ fetch: true, httpMetrics: false });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 204 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal/orders");

    expect(recordMetric).not.toHaveBeenCalled();
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

  it("records the request path without its query string", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal/orders?token=secret");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.not.stringContaining("token=secret"),
      expect.objectContaining({ "url.full": "https://api.internal/orders" }),
    );
    expect(c.breadcrumbs.snapshot().at(-1)?.message).not.toContain("token=secret");
    capture.uninstall();
  });

  it("keeps the whole request URL when the consumer asks for it", async () => {
    const { ctx: c, logger } = ctx({ fetch: true, fullUrls: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch("https://api.internal/orders?token=secret");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ "url.full": "https://api.internal/orders?token=secret" }),
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

  it("leaves a later fetch wrapper in place on uninstall and stops recording", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    const ours = globalThis.fetch;
    const later: typeof fetch = (input, init) => ours(input, init);
    globalThis.fetch = later;

    capture.uninstall();
    await fetch("https://api.internal/after");

    expect(globalThis.fetch).toBe(later);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reads the URL of a fetch input that is only stringifiable", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));
    const input = { toString: () => "https://api.internal/text" } as unknown as string;

    const capture = new NetworkCapture(c);
    capture.install();

    await expect(fetch(input)).resolves.toBeInstanceOf(Response);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      "url.full": "https://api.internal/text",
    });
    capture.uninstall();
  });

  it("reads the URL and method of a Request from another realm", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));
    // A Request from an iframe fails instanceof Request in this realm.
    const foreign = { url: "https://api.internal/foreign", method: "delete" } as unknown as Request;

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch(foreign);

    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      "url.full": "https://api.internal/foreign",
      "http.request.method": "DELETE",
    });
    capture.uninstall();
  });

  it("records the init method over the Request method", async () => {
    const { ctx: c, logger } = ctx({ fetch: true });
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("", { status: 500 })));

    const capture = new NetworkCapture(c);
    capture.install();
    await fetch(new Request("https://api.internal/orders", { method: "PUT" }), { method: "post" });

    expect(logger.warn.mock.calls[0][1]).toMatchObject({ "http.request.method": "POST" });
    capture.uninstall();
  });

  it("sends a fetch unchanged when the library cannot read its input", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const seen: unknown[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      seen.push(input);
      return Promise.resolve(new Response("", { status: 200 }));
    });
    const hostile = Object.defineProperty({}, "url", {
      get() {
        throw new Error("unreadable url");
      },
    }) as Request;

    const { ctx: c, logger } = ctx({ fetch: true });
    c.diagnostics.setHandler(handler);
    const capture = new NetworkCapture(c);
    capture.install();

    await expect(fetch(hostile)).resolves.toBeInstanceOf(Response);
    expect(seen[0]).toBe(hostile);
    expect(logger.debug).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "capture.record_failed" }),
    );
    capture.uninstall();
  });

  it("ignores an uninstall before install", () => {
    const { ctx: c } = ctx({ fetch: true });
    const before = globalThis.fetch;
    const capture = new NetworkCapture(c);

    capture.uninstall();

    expect(globalThis.fetch).toBe(before);
  });

  it("patches nothing in a realm without fetch or XMLHttpRequest", () => {
    const { ctx: c } = ctx({ fetch: true, xhr: true });
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("XMLHttpRequest", undefined);

    const capture = new NetworkCapture(c);
    expect(() => {
      capture.install();
    }).not.toThrow();

    vi.unstubAllGlobals();
    capture.uninstall();
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
    await fetch(new URL("https://api.internal/by-url"));

    expect(seen[0].get("traceparent")).toBeTruthy();
    expect(seen[1].get("traceparent")).toBeNull();
    expect(seen[2].get("traceparent")).toBeTruthy();
    capture.uninstall();
  });

  it("records the client span that the traceparent of a request names", async () => {
    const seen: Headers[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/offline")) {
        return Promise.reject(new TypeError("offline"));
      }
      return Promise.resolve(new Response("", { status: url.endsWith("/fail") ? 500 : 200 }));
    });
    const spans: SpanHooks = { enabled: () => true, keeps: () => true, onEnd: vi.fn() };
    const { ctx: c, recordSpan } = ctx(
      { fetch: true, propagateTraceHeaderTo: ["https://api.internal"] },
      spans,
    );
    const root = c.tracing.resolve();
    const capture = new NetworkCapture(c);
    capture.install();

    await fetch("https://api.internal/orders?id=7");
    await fetch("https://api.internal/fail", { method: "post" });
    await fetch("https://api.internal/offline").catch(() => undefined);
    await fetch("https://third-party.example/widget");

    const recorded = recordSpan.mock.calls.map(([span]) => span);
    expect(recorded.map((span) => span.spanId)).toEqual(
      seen.slice(0, 3).map((headers) => headers.get("traceparent")?.split("-")[2]),
    );
    expect(recorded[0]).toMatchObject({
      name: "GET",
      kind: "client",
      traceId: root.traceId,
      parentSpanId: root.spanId,
      error: false,
      attributes: {
        "http.request.method": "GET",
        "url.full": "https://api.internal/orders",
        "server.address": "api.internal",
        "http.response.status_code": 200,
      },
    });
    expect(recorded[0].startMs).toBeLessThanOrEqual(recorded[0].endMs);
    expect(recorded.map((span) => span.error)).toEqual([false, true, true]);
    expect(recorded[2].attributes["error.type"]).toBe("TypeError");
    capture.uninstall();
  });

  it("matches a string entry on the origin of the URL only", async () => {
    // A substring test also matches a query value or a longer host name of a third party.
    const seen: Headers[] = [];
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response("", { status: 200 }));
    });

    const { ctx: c } = ctx({
      fetch: true,
      propagateTraceHeaderTo: ["https://api.example.com", location.origin],
    });
    const capture = new NetworkCapture(c);
    capture.install();

    await fetch("https://tracker.example.net/p?ref=https://api.example.com/x");
    await fetch("https://api.example.com.evil.example/");
    await fetch("https://api.example.com/v1/orders");
    await fetch("/api/orders");

    expect(seen.map((headers) => headers.get("traceparent") !== null)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    capture.uninstall();
  });

  it("reports a URL with no origin, and still sends and records the request", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const seen: Headers[] = [];
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response("", { status: 200 }));
    });

    const { ctx: c, logger } = ctx({
      fetch: true,
      propagateTraceHeaderTo: ["https://api.example.com", /\[/],
    });
    c.diagnostics.setHandler(handler);
    const capture = new NetworkCapture(c);
    capture.install();

    await fetch("http://[");

    expect(seen[0].get("traceparent")).not.toBeNull();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "capture.header_failed" }),
    );
    capture.uninstall();
  });

  it("sends an allowlisted Request from another realm unchanged", async () => {
    const seen: { input: unknown; init: RequestInit | undefined }[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ input, init });
      return Promise.resolve(new Response("", { status: 200 }));
    });
    // An init with headers replaces all headers of the Request, for example Authorization.
    const foreign = {
      url: "https://api.internal/orders",
      method: "GET",
      headers: new Headers({ Authorization: "Bearer token" }),
    } as unknown as Request;

    const { ctx: c } = ctx({ fetch: true, propagateTraceHeaderTo: ["https://api.internal"] });
    const capture = new NetworkCapture(c);
    capture.install();
    await fetch(foreign);

    expect(seen[0].input).toBe(foreign);
    expect(seen[0].init).toBeUndefined();
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
    // Without this stub, happy-dom tries a real request on send().
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a reused XHR one time for each send", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();
    const xhr = new XMLHttpRequest();
    vi.spyOn(xhr, "status", "get").mockReturnValue(200);

    for (const path of ["a", "b"]) {
      xhr.open("get", `https://api.internal/${path}`);
      xhr.send();
      xhr.dispatchEvent(new Event("loadend"));
    }

    expect(logger.debug.mock.calls.map(([message]) => message)).toEqual([
      "GET https://api.internal/a",
      "GET https://api.internal/b",
    ]);
    capture.uninstall();
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

  it("never logs an XHR that a custom transport starts", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();

    runAsLibraryRequest(() => {
      sendXhr("https://telemetry.app.internal/logs", 500);
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
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

  it("leaves later open and send wrappers in place on uninstall and stops recording", () => {
    type XhrFn = (this: XMLHttpRequest, ...args: never[]) => void;
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();
    const ourOpen: XhrFn = XMLHttpRequest.prototype.open;
    const ourSend: XhrFn = XMLHttpRequest.prototype.send;
    const laterOpen = function (this: XMLHttpRequest, ...args: never[]): void {
      ourOpen.apply(this, args);
    };
    const laterSend = function (this: XMLHttpRequest, ...args: never[]): void {
      ourSend.apply(this, args);
    };
    XMLHttpRequest.prototype.open = laterOpen;
    XMLHttpRequest.prototype.send = laterSend;

    capture.uninstall();
    sendXhr("https://api.internal/after", 200);

    expect(XMLHttpRequest.prototype.open).toBe(laterOpen);
    expect(XMLHttpRequest.prototype.send).toBe(laterSend);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("records an XHR whose method is not a string", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();
    const method = { toString: () => "PATCH" } as unknown as string;

    const xhr = new XMLHttpRequest();
    vi.spyOn(xhr, "status", "get").mockReturnValue(200);
    expect(() => {
      xhr.open(method, "https://api.internal/orders");
      xhr.send();
    }).not.toThrow();
    xhr.dispatchEvent(new Event("loadend"));

    expect(logger.debug).toHaveBeenCalledWith(
      "PATCH https://api.internal/orders",
      expect.objectContaining({ "http.request.method": "PATCH" }),
    );
    capture.uninstall();
  });

  it("records an XHR opened with a null URL as the text null", () => {
    const { ctx: c, logger } = ctx({ xhr: true });
    const capture = new NetworkCapture(c);
    capture.install();

    sendXhr(null as unknown as string, 200);

    expect(logger.debug).toHaveBeenCalledWith(
      "GET null",
      expect.objectContaining({ "url.full": "null" }),
    );
    capture.uninstall();
  });

  it("opens an XHR unchanged and records nothing when its method cannot be read", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const { ctx: c, logger } = ctx({ xhr: true });
    c.diagnostics.setHandler(handler);
    const capture = new NetworkCapture(c);
    capture.install();
    const method = {
      toString: () => {
        throw new Error("unreadable method");
      },
    } as unknown as string;

    const xhr = new XMLHttpRequest();
    expect(() => {
      xhr.open(method, "https://api.internal/orders");
      xhr.send();
    }).not.toThrow();
    xhr.dispatchEvent(new Event("loadend"));

    expect(logger.debug).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "capture.record_failed" }),
    );
    capture.uninstall();
  });

  it("adds traceparent only to an allowlisted XHR", () => {
    const setHeader = vi
      .spyOn(XMLHttpRequest.prototype, "setRequestHeader")
      .mockImplementation(() => undefined);
    const { ctx: c } = ctx({ xhr: true, propagateTraceHeaderTo: ["https://api.internal"] });
    const capture = new NetworkCapture(c);
    capture.install();

    sendXhr("https://third.party/widget", 200);
    expect(setHeader).not.toHaveBeenCalled();

    sendXhr("https://api.internal/orders", 200);
    expect(setHeader).toHaveBeenCalledWith("traceparent", expect.any(String));
    capture.uninstall();
  });

  it("records the client span of an allowlisted XHR at loadend", () => {
    const setHeader = vi
      .spyOn(XMLHttpRequest.prototype, "setRequestHeader")
      .mockImplementation(() => undefined);
    const spans: SpanHooks = { enabled: () => true, keeps: () => true, onEnd: vi.fn() };
    const { ctx: c, recordSpan } = ctx(
      { xhr: true, propagateTraceHeaderTo: ["https://api.internal"] },
      spans,
    );
    const capture = new NetworkCapture(c);
    capture.install();

    sendXhr("https://api.internal/orders", 404);

    const header = setHeader.mock.calls[0][1];
    expect(recordSpan).toHaveBeenCalledOnce();
    expect(recordSpan.mock.calls[0][0]).toMatchObject({
      name: "GET",
      spanId: header.split("-")[2],
      error: true,
      attributes: { "http.response.status_code": 404, "error.type": "404" },
    });
    capture.uninstall();
  });

  it("sends the XHR when the trace header cannot be attached", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(() => {
      throw new Error("header refused");
    });
    const send = vi.mocked(XMLHttpRequest.prototype.send);
    const { ctx: c, logger } = ctx({ xhr: true, propagateTraceHeaderTo: ["https://api.internal"] });
    c.diagnostics.setHandler(handler);
    const capture = new NetworkCapture(c);
    capture.install();

    sendXhr("https://api.internal/orders", 200);

    expect(send).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "capture.header_failed" }),
    );
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
    // onNavigate runs as a microtask. location.href changes only after pushState returns.
    await Promise.resolve();

    expect(logger.logEvent).toHaveBeenCalledWith("NAVIGATION", {
      "page.url.previous": expect.any(String) as string,
    });
    // Do not use `url.full`. That name is for an HTTP request. The record builder sets the new URL
    // as `page.url` itself.
    expect(logger.logEvent.mock.calls[0][1]).not.toHaveProperty("url.full");

    capture.uninstall();
    expect(history.pushState).toBe(original);
  });

  it("leaves later history wrappers in place on uninstall and stops recording", async () => {
    type HistoryFn = (this: History, ...args: Parameters<History["pushState"]>) => void;
    const { ctx: c, logger } = ctx({ navigation: true });
    const nativePush = history.pushState;
    const nativeReplace = history.replaceState;
    const capture = new InteractionCapture(c);
    capture.install();
    const ourPush: HistoryFn = history.pushState;
    const ourReplace: HistoryFn = history.replaceState;
    const routerPush: HistoryFn = function (this: History, ...args) {
      ourPush.apply(this, args);
    };
    const routerReplace: HistoryFn = function (this: History, ...args) {
      ourReplace.apply(this, args);
    };
    history.pushState = routerPush;
    history.replaceState = routerReplace;

    capture.uninstall();
    history.pushState({}, "", "/after-uninstall");
    history.replaceState({}, "", "/after-uninstall-2");
    await Promise.resolve();

    expect(history.pushState).toBe(routerPush);
    expect(history.replaceState).toBe(routerReplace);
    expect(logger.logEvent).not.toHaveBeenCalled();
    history.pushState = nativePush;
    history.replaceState = nativeReplace;
  });

  it("reports the previous route without its query string", async () => {
    history.replaceState({}, "", "/seed?token=secret");
    const { ctx: c, logger } = ctx({ navigation: true });
    const capture = new InteractionCapture(c);
    capture.install();

    history.pushState({}, "", "/orders/1");
    await Promise.resolve();

    expect(logger.logEvent).toHaveBeenCalledWith("NAVIGATION", {
      "page.url.previous": `${location.origin}/seed`,
    });
    expect(c.breadcrumbs.snapshot().at(-1)?.message).not.toContain("token=secret");
    capture.uninstall();
  });

  it("keeps the whole previous route when the consumer asks for it", async () => {
    history.replaceState({}, "", "/kept?token=secret");
    const { ctx: c, logger } = ctx({ navigation: true, fullUrls: true });
    const capture = new InteractionCapture(c);
    capture.install();

    history.pushState({}, "", "/orders/2");
    await Promise.resolve();

    expect(logger.logEvent).toHaveBeenCalledWith("NAVIGATION", {
      "page.url.previous": `${location.origin}/kept?token=secret`,
    });
    capture.uninstall();
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
  /** Nothing here loads the real package. The loader is the seam for the test. */
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

  it("reports config.invalid and imports nothing without a loader", async () => {
    // The Vite dev server fails on a bare import of a peer that is not installed.
    // web-vitals loads only through webVitalsLoader.
    const { ctx: c } = ctx({ webVitals: true });
    const guardAsync = vi.spyOn(c.diagnostics, "guardAsync");

    new WebVitalsCapture(c).install();
    await Promise.resolve();

    expect(guardAsync).not.toHaveBeenCalled();
    expect(c.diagnostics.snapshot()["config.invalid"]).toBe(1);
  });

  it("subscribes once a later configure supplies the loader", async () => {
    let subscriptions = 0;
    const subscribe = () => () => {
      subscriptions++;
    };
    const { ctx: c } = ctx({ webVitals: true });

    const first = new WebVitalsCapture(c);
    first.install();
    first.uninstall();

    c.config.capture.webVitalsLoader = () =>
      Promise.resolve({
        onLCP: subscribe(),
        onCLS: subscribe(),
        onINP: subscribe(),
        onFCP: subscribe(),
        onTTFB: subscribe(),
      });
    const second = new WebVitalsCapture(c);
    second.install();

    await vi.waitFor(() => {
      expect(subscriptions).toBe(5);
    });
    second.uninstall();
  });

  it("loads web-vitals again on a later install after a failed load", async () => {
    let subscriptions = 0;
    const subscribe = () => () => {
      subscriptions++;
    };
    let loads = 0;
    const { ctx: c } = ctx({
      webVitals: true,
      webVitalsLoader: () => {
        loads++;
        // The first load fails, for example a chunk that the network did not deliver.
        return loads === 1
          ? Promise.reject(new Error("chunk failed"))
          : Promise.resolve({
              onLCP: subscribe(),
              onCLS: subscribe(),
              onINP: subscribe(),
              onFCP: subscribe(),
              onTTFB: subscribe(),
            });
      },
    });

    const first = new WebVitalsCapture(c);
    first.install();
    await vi.waitFor(() => {
      expect(c.diagnostics.snapshot()["capture.install_failed"]).toBeGreaterThan(0);
    });
    first.uninstall();

    const second = new WebVitalsCapture(c);
    second.install();
    await vi.waitFor(() => {
      expect(subscriptions).toBe(5);
    });
    second.uninstall();
  });

  it("subscribes one set of reporters when two installs load in the same turn", async () => {
    let subscriptions = 0;
    const subscribe = () => () => {
      subscriptions++;
    };
    const { ctx: c } = ctx({
      webVitals: true,
      webVitalsLoader: () =>
        Promise.resolve({
          onLCP: subscribe(),
          onCLS: subscribe(),
          onINP: subscribe(),
          onFCP: subscribe(),
          onTTFB: subscribe(),
        }),
    });

    const first = new WebVitalsCapture(c);
    const second = new WebVitalsCapture(c);
    first.install();
    second.install();
    await vi.waitFor(() => {
      expect(subscriptions).toBe(5);
    });
    await Promise.resolve();

    expect(subscriptions).toBe(5);
    first.uninstall();
    second.uninstall();
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
    // happy-dom has no navigation entry. This test supplies one.
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { domainLookupEnd: 10, domainLookupStart: 5, type: "navigate" } as never,
    ]);
    const capture = new WebVitalsCapture(c);

    capture.install();
    const first = logger.logMetric.mock.calls.length;
    capture.install();

    expect(logger.logMetric.mock.calls.length).toBe(first);

    // A reconfigure uninstalls and rebuilds. The entry describes the one
    // navigation this document made, so reporting it again duplicates it.
    capture.uninstall();
    capture.install();
    expect(logger.logMetric.mock.calls.length).toBe(first);
  });

  it("does not subscribe a second set of reporters after a reinstall", async () => {
    let subscriptions = 0;
    const subscribe = () => () => {
      subscriptions++;
    };
    const { ctx: c } = ctx({
      webVitals: true,
      webVitalsLoader: () =>
        Promise.resolve({
          onLCP: subscribe(),
          onCLS: subscribe(),
          onINP: subscribe(),
          onFCP: subscribe(),
          onTTFB: subscribe(),
        }),
    });

    const first = new WebVitalsCapture(c);
    first.install();
    await vi.waitFor(() => {
      expect(subscriptions).toBe(5);
    });

    // web-vitals has no unsubscribe. The rebuilt instance must not call the reporters again. If it
    // does, it reports each LCP two times.
    first.uninstall();
    const second = new WebVitalsCapture(c);
    second.install();
    await Promise.resolve();

    expect(subscriptions).toBe(5);
    second.uninstall();
  });
});

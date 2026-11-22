import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCapture } from "../src/capture/errors";
import { InteractionCapture } from "../src/capture/interactions";
import { observedWindows } from "../src/capture/observed-windows";
import { NetworkCapture } from "../src/capture/network";
import { matchesAny } from "../src/capture/types";
import type { CaptureContext, CaptureLogger } from "../src/capture/types";
import { WebVitalsCapture } from "../src/capture/web-vitals";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import {
  ERROR_DEDUPE_MS,
  MAX_TRACKED_ERROR_SIGNATURES,
  OBSERVED_WINDOWS_KEY,
  TELEMETRY_SDK_VERSION,
} from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics, type DiagnosticEvent } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { CaptureOptions, ObservabilityConfig, WebVitalsMetric } from "../src/models/config";
import { observeWindow } from "../src/index";
import { CustomTransport } from "../src/transport/custom-transport";
import { runAsLibraryRequest } from "../src/utils/library-request";
import { type SpanHooks, TraceEngine } from "../src/utils/tracing";
import {
  asWindow,
  blockedDocumentWindow,
  foreignRealm,
  foreignWindow,
  leftOn,
  openBlankPopout,
  openPopout,
  REGIONS,
  regions,
  stubClosed,
  stubMutationObserver,
  type Popout,
  type Regions,
} from "./window-fakes";

/** A logger with a spy for every method, so a test can read what the logger recorded. */
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
 * @param spans The trace engine's span decisions. Without them, spans are off.
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
      once: {
        webVitals: false,
        navigationTiming: false,
        longFrames: false,
        uncleanExit: false,
        userTiming: false,
      },
      recordMetric,
      recordSpan,
      sessionId: () => "session",
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

  it("forgets the oldest error signature past the cap, so its repeat logs again", () => {
    const { ctx: c, logger } = ctx();
    c.config.captureLimits.errorsPerWindow = null;
    const capture = new ErrorCapture(c);
    capture.install();
    const fail = (message: string): void => {
      dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
    };

    for (let i = 0; i <= MAX_TRACKED_ERROR_SIGNATURES; i++) {
      fail(`boom ${String(i)}`);
    }
    fail("boom 0");

    expect(logger.error).toHaveBeenCalledTimes(MAX_TRACKED_ERROR_SIGNATURES + 2);
    capture.uninstall();
  });

  it("captures no error with errorsPerWindow 0, and every error with null", () => {
    const { ctx: c, logger } = ctx();
    c.config.captureLimits.errorsPerWindow = 0;
    const capture = new ErrorCapture(c);
    capture.install();

    dispatchEvent(new ErrorEvent("error", { error: new Error("first"), message: "first" }));
    expect(logger.error).not.toHaveBeenCalled();

    c.config.captureLimits.errorsPerWindow = null;
    for (let i = 0; i < 30; i++) {
      const message = `storm ${String(i)}`;
      dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
    }

    expect(logger.error).toHaveBeenCalledTimes(30);
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

    // The call gives no error object and no message, so the built Error has the fallback message.
    dispatchEvent(new ErrorEvent("error", { message: "" }));
    // The error object's own message is empty, and no other text names the error.
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
    // The logger converts the reason and keeps a non-Error reason as error.data.
    expect(logger.error.mock.calls[1][0]).toBe("just a string");
    expect(logger.error.mock.calls[1][1]).toBe("just a string");
    capture.uninstall();
  });

  it("passes an Error to the logger for a rejection with no reason", () => {
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

    // The map has a size limit. The eviction ran without throwing, and the module kept reporting
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

    // A second install would add a duplicate listener, and every record would occur twice.
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

  it("reports a fetch that starts during a custom transport call only once", async () => {
    // A fetch after an await is outside the library request scope. Every send would then record a
    // value, and that value would cause the next send.
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

    // The path, query and port stay out, because every value makes a new series in the backend.
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

  it("uses the error's type for a request without a response", async () => {
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

  it("uses the type _OTHER for a rejection that is not an error", async () => {
    const { ctx: c, recordMetric } = ctx({ fetch: true });
    // A script can reject with any value, and this one is not an error.
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
    // A substring test would also match a query value or a third party's longer host name.
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
    // An init with headers replaces every header on the Request, for example Authorization.
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

  describe("trace headers on the request that actually goes out", () => {
    const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    /** Stubs fetch the way a browser reads its arguments, and keeps each effective request. */
    function effectiveRequests(): Request[] {
      const sent: Request[] = [];
      globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Request(input, init));
        return Promise.resolve(new Response("", { status: 200 }));
      });
      return sent;
    }

    /** Installs fetch capture with client spans on for https://api.internal. */
    function install() {
      const spans: SpanHooks = { enabled: () => true, keeps: () => true, onEnd: vi.fn() };
      const handler = vi.fn<(event: DiagnosticEvent) => void>();
      const made = ctx({ fetch: true, propagateTraceHeaderTo: ["https://api.internal"] }, spans);
      made.ctx.diagnostics.setHandler(handler);
      const capture = new NetworkCapture(made.ctx);
      capture.install();
      return { capture, handler, recordSpan: made.recordSpan };
    }

    it("adds the header after the init's headers replace the Request's own", async () => {
      const sent = effectiveRequests();
      const { capture, recordSpan } = install();
      const controller = new AbortController();

      await fetch(
        new Request("https://api.internal/orders", {
          method: "POST",
          body: "from the request",
          headers: { Authorization: "Bearer request" },
        }),
        { headers: { Authorization: "Bearer init", "X-Tenant": "t1" }, signal: controller.signal },
      );
      capture.uninstall();

      const [request] = sent;
      expect(request.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      expect(request.headers.get("Authorization")).toBe("Bearer init");
      expect(request.headers.get("X-Tenant")).toBe("t1");
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe("from the request");
      controller.abort();
      expect(request.signal.aborted).toBe(true);
      expect(recordSpan).toHaveBeenCalledOnce();
    });

    it.each([
      ["no init", undefined],
      ["an empty init", {}],
    ])("keeps the referrer and referrer policy of a Request sent with %s", async (_name, init) => {
      const sent = effectiveRequests();
      const { capture } = install();

      // A referrer from another origin always becomes about:client, so use the page's own.
      const referrer = `${location.origin}/checkout`;
      await fetch(
        new Request("https://api.internal/orders", { referrer, referrerPolicy: "no-referrer" }),
        init,
      );
      capture.uninstall();

      expect(sent[0].headers.get("traceparent")).toBeTruthy();
      expect(sent[0].referrerPolicy).toBe("no-referrer");
      expect(sent[0].referrer).toBe(referrer);
    });

    it("keeps the init's method and body over the Request's", async () => {
      const sent = effectiveRequests();
      const { capture } = install();

      await fetch(new Request("https://api.internal/orders"), {
        method: "PUT",
        body: "from the init",
        headers: { "X-Tenant": "t1" },
      });
      capture.uninstall();

      const [request] = sent;
      expect(request.method).toBe("PUT");
      expect(await request.text()).toBe("from the init");
      expect(request.headers.get("traceparent")).toBeTruthy();
    });

    it("adds the header when the init's headers drop a traceparent the Request had", async () => {
      const sent = effectiveRequests();
      const { capture, recordSpan } = install();

      await fetch(
        new Request("https://api.internal/orders", { headers: { traceparent: TRACEPARENT } }),
        {
          headers: { "X-Tenant": "t1" },
        },
      );
      capture.uninstall();

      expect(sent[0].headers.get("traceparent")).not.toBe(TRACEPARENT);
      expect(sent[0].headers.get("traceparent")).toBeTruthy();
      expect(recordSpan).toHaveBeenCalledOnce();
    });

    it.each([
      [
        "a string and init headers",
        () => fetch("https://api.internal/orders", { headers: { traceparent: TRACEPARENT } }),
      ],
      [
        "a Request's own headers",
        () =>
          fetch(
            new Request("https://api.internal/orders", { headers: { traceparent: TRACEPARENT } }),
          ),
      ],
      [
        "a Request and init headers",
        () =>
          fetch(new Request("https://api.internal/orders"), {
            headers: { Traceparent: TRACEPARENT },
          }),
      ],
    ])("keeps the caller's own traceparent from %s and says so", async (_name, call) => {
      const sent = effectiveRequests();
      const { capture, handler, recordSpan } = install();

      await call();
      capture.uninstall();

      expect(sent[0].headers.get("traceparent")).toBe(TRACEPARENT);
      expect(recordSpan).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "capture.trace_header_kept",
          message:
            "The request already has a traceparent header. The library keeps it and records no client span.",
          detail: { url: "https://api.internal/orders" },
        }),
      );
    });
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

  it("records a reused XHR once per send", () => {
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
      message: "unknown-click",
    });
    capture.uninstall();
  });

  it("describes a target by test id, then id, then aria-label, then tag and class", () => {
    const { ctx: c } = ctx({ interactions: { selector: true } });
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

    expect(c.breadcrumbs.snapshot().map((crumb) => crumb.data?.selector)).toEqual([
      '[data-testid="buy"]',
      "#named",
      'button[aria-label="Cancel order"]',
      "button.btn.primary",
      "button",
    ]);
    capture.uninstall();
  });

  it("falls back to data-test-id and reports an unknown target", () => {
    const { ctx: c } = ctx({ interactions: { selector: true } });
    const capture = new InteractionCapture(c);
    capture.install();

    document.body.innerHTML = `<button data-test-id="legacy">a</button>`;
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // An event with no target at all, which is what a synthetic dispatch on the
    // window looks like.
    dispatchEvent(new MouseEvent("click"));

    const messages = c.breadcrumbs.snapshot().map((crumb) => crumb.data?.selector);
    expect(messages).toContain('[data-testid="legacy"]');
    expect(messages).toHaveLength(1);
    capture.uninstall();
  });

  it("keeps the clicked text on the breadcrumb, and omits it when there is none", () => {
    const { ctx: c } = ctx({ interactions: { text: true } });
    const capture = new InteractionCapture(c);
    capture.install();

    document.body.innerHTML = `<button id="a">Submit order</button><button id="b"></button>`;
    document.querySelector("#a")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector("#b")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const crumbs = c.breadcrumbs.snapshot();
    expect(crumbs.at(-2)?.data).toEqual({ text: "Submit order" });
    expect(crumbs.at(-1)?.data).toEqual({ text: "" });
    capture.uninstall();
  });

  it("logs a route change and restores history on uninstall", async () => {
    const { ctx: c, logger } = ctx({ navigation: true });
    const original = history.pushState;
    const capture = new InteractionCapture(c);
    capture.install();
    expect(history.pushState).not.toBe(original);

    history.pushState({}, "", "/orders/1");
    // onNavigate runs as a microtask, since location.href only changes after pushState returns.
    await Promise.resolve();

    expect(logger.logEvent).toHaveBeenCalledWith("NAVIGATION", {
      "page.url.previous": expect.any(String) as string,
    });
    // Do not use `url.full`, which is the name for an HTTP request. The record builder sets the
    // new URL as `page.url` itself.
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

describe("InteractionCapture ignoreSelector", () => {
  // Each button names its action, so a breadcrumb shows which click was recorded.
  const REGIONS = `
    <button id="private" class="private" data-observability-action="private">Private</button>
    <div data-observability-ignore>
      <button id="blocked" data-observability-action="blocked">Blocked</button>
    </div>
    <button id="open" data-observability-action="open">Open</button>`;

  /** The capture of the running spec, so afterEach removes its click listener. */
  let running: InteractionCapture | undefined;

  /**
   * Installs the capture on a page with a custom region, a built-in region and a plain button.
   * @param ignoreSelector The first `capture.interactions.ignoreSelector`, checked as an app's is.
   * @returns The capture context and a click helper that reads each button by its id.
   */
  const start = (ignoreSelector: string | null) => {
    const { ctx: c } = ctx({ interactions: { ignoreSelector } });
    running = new InteractionCapture(c);
    running.install();
    document.body.innerHTML = REGIONS;
    return {
      c,
      click: (id: string): void => {
        document.getElementById(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      },
    };
  };

  /**
   * Applies a later configure() call's click settings on top of the current config.
   * @param c The capture context.
   * @param interactions The later `capture.interactions` value.
   */
  const reconfigure = (c: CaptureContext, interactions: CaptureOptions["interactions"]): void => {
    c.config.capture.interactions = resolveConfig(
      { capture: { interactions } },
      c.diagnostics,
      c.config,
    ).capture.interactions;
  };

  /** Lists the message of each click breadcrumb. */
  const crumbs = (c: CaptureContext): string[] =>
    c.breadcrumbs.snapshot().map((one) => one.message);

  afterEach(() => {
    running?.uninstall();
    running = undefined;
  });

  it("skips a click inside the custom selector", () => {
    const { c, click } = start(".private");

    click("private");
    click("open");

    expect(crumbs(c)).toEqual(["open"]);
  });

  it("records a click again after a later empty selector turns the custom filter off", () => {
    const { c, click } = start(".private");
    click("private");
    expect(crumbs(c)).toEqual([]);

    reconfigure(c, { ignoreSelector: "" });
    click("private");

    expect(crumbs(c)).toEqual(["private"]);
  });

  it("still skips a click inside the built-in region after a later empty selector", () => {
    const { c, click } = start(".private");

    reconfigure(c, { ignoreSelector: "" });
    click("blocked");
    click("open");

    // Only the plain button records, so the built-in block still applies.
    expect(crumbs(c)).toEqual(["open"]);
  });

  it("skips a click inside the built-in region when the first selector is empty", () => {
    const { c, click } = start("");

    click("blocked");
    click("private");

    // The custom button records, because "" leaves no custom filter. The blocked one doesn't.
    expect(crumbs(c)).toEqual(["private"]);
  });
});

describe("InteractionCapture rage and dead clicks", () => {
  /** Clicks an element with an event that bubbles. */
  const click = (element: Element): void => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };

  /**
   * Installs the capture on a page with two controls and one plain element.
   * @param interactions Interaction options, which skip the config checks.
   * @returns The capture, its context, the spy logger and the elements.
   */
  const page = (interactions: CaptureOptions["interactions"]) => {
    vi.useFakeTimers();
    const { ctx: c, logger } = ctx();
    c.config.capture.interactions = interactions;
    const capture = new InteractionCapture(c);
    capture.install();
    document.body.innerHTML = `
      <button data-observability-action="buy">Buy</button>
      <span role="button" data-observability-action="sell">Sell</span>
      <div id="plain">Text</div>`;
    const [buy, sell, plain] = ["button", "span", "#plain"].map((one) =>
      document.querySelector(one)!,
    );
    return { capture, c, logger, buy, sell, plain };
  };

  /** Returns the payloads of every event with the given name. */
  const events = (logger: SpyLogger, name: string) =>
    logger.logEvent.mock.calls.filter(([event]) => event === name).map(([, payload]) => payload);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fills the default thresholds in the config checks", () => {
    const { ctx: c } = ctx({ interactions: { rageClicks: true } });

    expect(c.config.capture.interactions).toMatchObject({
      rageClicks: true,
      rageClickCount: 3,
      rageClickWindowMs: 1000,
      deadClicks: false,
      deadClickMs: 1000,
    });
  });

  it("records one rage click for each burst of clicks on one element", () => {
    const { capture, logger, buy, sell } = page({ rageClicks: true });

    click(buy);
    click(buy);
    click(sell);
    click(buy);
    click(buy);
    // The click on another element started a new count.
    expect(events(logger, "ui.rage_click")).toEqual([]);

    click(buy);
    click(buy);
    expect(events(logger, "ui.rage_click")).toEqual([{ "click.action": "buy", "click.count": 3 }]);

    // Clicks after the window start a new burst.
    vi.advanceTimersByTime(1000);
    click(buy);
    click(buy);
    expect(events(logger, "ui.rage_click")).toHaveLength(1);
    capture.uninstall();
  });

  it("uses the configured rage click count and window", () => {
    const { capture, logger, buy } = page({
      rageClicks: true,
      rageClickCount: 2,
      rageClickWindowMs: 200,
    });

    click(buy);
    vi.advanceTimersByTime(200);
    click(buy);
    expect(events(logger, "ui.rage_click")).toEqual([]);

    click(buy);
    expect(events(logger, "ui.rage_click")).toEqual([{ "click.action": "buy", "click.count": 2 }]);
    capture.uninstall();
  });

  it("records one rage click while clicks slide through the window", () => {
    const { capture, logger, buy } = page({ rageClicks: true });

    for (let index = 0; index < 5; index++) {
      click(buy);
      vi.advanceTimersByTime(400);
    }
    expect(events(logger, "ui.rage_click")).toHaveLength(1);

    // A pause longer than the window ends the burst.
    vi.advanceTimersByTime(1000);
    click(buy);
    click(buy);
    click(buy);
    expect(events(logger, "ui.rage_click")).toHaveLength(2);
    capture.uninstall();
  });

  it("records no dead click on a link that opens elsewhere", async () => {
    const { capture, logger } = page({ deadClicks: true });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<a id="tab" target="_blank">Tab</a><a id="file" download>File</a>',
    );

    click(document.querySelector("#tab")!);
    await vi.advanceTimersByTimeAsync(1000);
    click(document.querySelector("#file")!);
    await vi.advanceTimersByTimeAsync(1000);

    expect(events(logger, "ui.dead_click")).toEqual([]);
    capture.uninstall();
  });

  it("records a dead click on a control that gives no response", async () => {
    const { capture, logger, buy, plain } = page({ deadClicks: true });

    click(plain);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events(logger, "ui.dead_click")).toEqual([]);

    click(buy);
    // A second click while the check runs starts no second check.
    click(buy);
    await vi.advanceTimersByTimeAsync(999);
    expect(events(logger, "ui.dead_click")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
    capture.uninstall();
  });

  it("records no dead click after a DOM change, a scroll or a navigation", async () => {
    const { capture, logger, buy, sell } = page({ deadClicks: true, deadClickMs: 500 });
    const original = location.href;

    buy.addEventListener("click", () => {
      document.body.append(document.createElement("p"));
    });
    click(buy);
    await vi.advanceTimersByTimeAsync(500);

    click(sell);
    sell.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(500);

    click(sell);
    history.replaceState(null, "", "/moved");
    await vi.advanceTimersByTimeAsync(500);
    history.replaceState(null, "", original);

    expect(events(logger, "ui.dead_click")).toEqual([]);
    capture.uninstall();
  });

  it("records no dead click after uninstall, while inactive or without MutationObserver", async () => {
    const { capture, c, logger, buy } = page({ deadClicks: true });

    click(buy);
    capture.uninstall();
    await vi.advanceTimersByTimeAsync(1000);

    capture.install();
    click(buy);
    c.isActive = () => false;
    await vi.advanceTimersByTimeAsync(1000);

    c.isActive = undefined;
    vi.stubGlobal("MutationObserver", undefined);
    click(buy);
    await vi.advanceTimersByTimeAsync(1000);

    expect(events(logger, "ui.dead_click")).toEqual([]);
    capture.uninstall();
  });

  describe("with a live region", () => {
    // One region the default selector marks, one it doesn't mark, and one that ".ticker" marks.
    const REGIONS = `
      <div id="grid" data-observability-live><span id="price">100</span></div>
      <div id="feed"><span id="headline">Open</span></div>
      <div class="ticker"><span id="tick">7</span></div>`;

    /** The capture of the running spec, so afterEach removes its click listener. */
    let running: InteractionCapture | undefined;

    /**
     * Builds the page of the parent suite and adds the three regions.
     * @param interactions Interaction options.
     * @param checked True to run the options through the config checks, as an app's options go.
     * @returns The parent's page, plus the region elements.
     */
    const livePage = (interactions: CaptureOptions["interactions"], checked = false) => {
      const view = page(interactions);
      if (checked) {
        view.c.config.capture.interactions = resolveConfig(
          { capture: { interactions } },
          view.c.diagnostics,
        ).capture.interactions;
      }
      document.body.insertAdjacentHTML("beforeend", REGIONS);
      const [grid, price, feed, headline, tick] = [
        "#grid",
        "#price",
        "#feed",
        "#headline",
        "#tick",
      ].map((one) => document.querySelector(one)!);
      running = view.capture;
      return { ...view, grid, price, feed, headline, tick };
    };
    type Live = ReturnType<typeof livePage>;

    /** A change to the page, named for the spec title. */
    type Change = [name: string, apply: (live: Live) => void];

    const INSIDE: Change[] = [
      ["a child added to the live region", ({ grid }) => grid.append(document.createElement("i"))],
      ["a child removed from the live region", ({ price }) => price.remove()],
      [
        "the text of an element inside the live region",
        ({ price }) => {
          price.textContent = "101";
        },
      ],
      ["an attribute of the live region", ({ grid }) => grid.setAttribute("data-flash", "up")],
      ["an attribute of an element inside it", ({ price }) => price.setAttribute("class", "up")],
      [
        "the data of a text node inside it",
        ({ price }) => {
          (price.firstChild as Text).data = "101";
        },
      ],
    ];

    const OUTSIDE: Change[] = [
      [
        "a child added outside the live region",
        ({ feed }) => feed.append(document.createElement("i")),
      ],
      ["an attribute changed outside it", ({ feed }) => feed.setAttribute("data-flash", "up")],
      [
        "the data of a text node outside it",
        ({ headline }) => {
          (headline.firstChild as Text).data = "Closed";
        },
      ],
      ["a child added to the body", () => document.body.append(document.createElement("i"))],
    ];

    afterEach(() => {
      running?.uninstall();
      running = undefined;
    });

    it.each(INSIDE)("records a dead click when the only change is %s", async (_name, change) => {
      const live = livePage({ deadClicks: true });

      click(live.buy);
      change(live);
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
    });

    it.each(OUTSIDE)("records no dead click when the only change is %s", async (_name, change) => {
      const live = livePage({ deadClicks: true });

      click(live.buy);
      change(live);
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it("records no dead click when the page changes in and out of the live region", async () => {
      const live = livePage({ deadClicks: true });

      click(live.buy);
      live.price.textContent = "101";
      live.feed.append(document.createElement("i"));
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it.each<[string, (live: Live) => Element]>([
      ["the live region itself", ({ grid }) => grid],
      ["an element inside the live region", ({ price }) => price],
    ])("records a dead click when %s scrolls", async (_name, scroller) => {
      const live = livePage({ deadClicks: true });

      click(live.buy);
      scroller(live).dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
    });

    it("records no dead click when an element outside the live region scrolls", async () => {
      const live = livePage({ deadClicks: true });

      click(live.buy);
      live.feed.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it.each<[string, () => EventTarget]>([
      ["document", () => document],
      ["window", () => window],
    ])("records no dead click when a scroll event targets the %s", async (_name, target) => {
      // Neither one is an Element, so a selector match on the target would throw or find nothing.
      const live = livePage({ deadClicks: true });

      click(live.buy);
      target().dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it("records no dead click after a navigation when only the live region changed", async () => {
      const original = location.href;
      const live = livePage({ deadClicks: true });

      click(live.buy);
      live.price.textContent = "101";
      history.replaceState(null, "", "/moved");
      await vi.advanceTimersByTimeAsync(1000);
      history.replaceState(null, "", original);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it("records a dead click when only a region of the custom selector changes", async () => {
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: ".ticker" });

      click(live.buy);
      live.tick.textContent = "8";
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
    });

    it("treats a change in the default region as a response with a custom selector", async () => {
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: ".ticker" });

      click(live.buy);
      live.price.textContent = "101";
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it("treats every change as a response when the selector is empty", async () => {
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: "" });

      click(live.buy);
      live.price.textContent = "101";
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it("uses the default live region after the config checks", async () => {
      const live = livePage({ deadClicks: true }, true);

      click(live.buy);
      live.price.textContent = "101";
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
    });

    it("uses the app's own selector instead of the default after the config checks", async () => {
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: ".ticker" }, true);

      click(live.buy);
      live.tick.textContent = "8";
      await vi.advanceTimersByTimeAsync(1000);
      expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);

      click(live.buy);
      live.price.textContent = "101";
      await vi.advanceTimersByTimeAsync(1000);
      expect(events(live.logger, "ui.dead_click")).toHaveLength(1);
    });

    it("keeps an empty selector through the config checks, so every change responds", async () => {
      // An empty string isn't valid CSS, so a plain validity check would replace it.
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: "" }, true);

      click(live.buy);
      live.price.textContent = "101";
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
    });

    it("falls back to the default region and raises no page error for a bad selector", async () => {
      const pageErrors = vi.fn();
      addEventListener("error", pageErrors);
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: "[" }, true);

      click(live.buy);
      live.price.textContent = "101";
      await vi.advanceTimersByTimeAsync(1000);
      removeEventListener("error", pageErrors);

      expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      expect(pageErrors).not.toHaveBeenCalled();
    });

    it("counts a change as a response and reports it for a selector that can't match", async () => {
      // This selector skips the config checks, so the match inside the observer throws.
      const pageErrors = vi.fn();
      const reported = vi.fn<(event: DiagnosticEvent) => void>();
      addEventListener("error", pageErrors);
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: "[" });
      live.c.diagnostics.setHandler(reported);

      click(live.buy);
      live.grid.setAttribute("data-flash", "up");
      await vi.advanceTimersByTimeAsync(1000);
      removeEventListener("error", pageErrors);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
      expect(pageErrors).not.toHaveBeenCalled();
      expect(reported.mock.calls.map(([event]) => [event.code, event.message])).toEqual([
        [
          "capture.record_failed",
          "The library could not check a page change for a dead click. " +
            "It counts the change as a response.",
        ],
      ]);
    });

    it("counts a scroll as a response and reports it for a selector that can't match", async () => {
      const reported = vi.fn<(event: DiagnosticEvent) => void>();
      const live = livePage({ deadClicks: true, deadClickIgnoreSelector: "[" });
      live.c.diagnostics.setHandler(reported);

      click(live.buy);
      live.price.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(1000);

      expect(events(live.logger, "ui.dead_click")).toEqual([]);
      expect(reported.mock.calls.map(([event]) => event.code)).toEqual(["capture.record_failed"]);
    });

    describe("a child list change and a same-value write", () => {
      /** Makes a cell that the default selector marks as live. */
      const marked = (): HTMLElement => {
        const cell = document.createElement("i");
        cell.setAttribute("data-observability-live", "");
        return cell;
      };

      /** Adds a row outside every live region, before the click, so the observer misses it. */
      const rowOf = (html: string): HTMLElement => {
        const row = document.createElement("div");
        row.innerHTML = html;
        document.body.append(row);
        return row;
      };

      /** Adds an input, as React renders it: with a type and a name. */
      const field = (): HTMLInputElement => {
        const input = document.createElement("input");
        input.setAttribute("type", "text");
        input.setAttribute("name", "qty");
        input.setAttribute("class", "box");
        input.setAttribute("data-state", "idle");
        document.body.append(input);
        return input;
      };

      const CELL = "<i data-observability-live></i>";

      it.each<[string, string, (row: HTMLElement) => void]>([
        [
          "a marked cell replaced by another marked cell",
          CELL + CELL,
          (row) => {
            row.replaceChildren(marked());
          },
        ],
      ])("records a dead click when the only change is %s", async (_name, html, apply) => {
        const live = livePage({ deadClicks: true });
        const row = rowOf(html);

        click(live.buy);
        apply(row);
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it.each<[string, string, (row: HTMLElement) => void]>([
        [
          "a marked cell added to the row",
          CELL,
          (row) => {
            row.append(marked());
          },
        ],
        [
          "a marked cell removed from the row",
          CELL + CELL,
          (row) => {
            row.firstElementChild?.remove();
          },
        ],
        [
          "a marked cell replaced by an unmarked node",
          CELL,
          (row) => {
            row.replaceChildren(document.createElement("b"));
          },
        ],
        [
          "an unmarked node added next to a marked cell",
          CELL,
          (row) => {
            row.append(document.createElement("b"));
          },
        ],
        [
          "an unmarked node removed next to a marked cell",
          `${CELL}<b></b>`,
          (row) => {
            row.lastElementChild?.remove();
          },
        ],
        [
          "a text node added next to a marked cell",
          CELL,
          (row) => {
            row.append(document.createTextNode("x"));
          },
        ],
      ])("records no dead click when the change is %s", async (_name, html, apply) => {
        const live = livePage({ deadClicks: true });
        const row = rowOf(html);

        click(live.buy);
        apply(row);
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([]);
      });

      it.each<[string, (row: HTMLElement) => Partial<MutationRecord>, string]>([
        [
          "records a dead click when one record replaces a marked cell with another",
          (row) => ({
            type: "childList",
            target: row,
            addedNodes: [marked()] as unknown as NodeList,
            removedNodes: [row.firstElementChild] as unknown as NodeList,
          }),
          "dead",
        ],
        [
          "records no dead click when one record adds a marked cell and an unmarked node",
          (row) => ({
            type: "childList",
            target: row,
            addedNodes: [marked(), document.createElement("b")] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
          }),
          "answered",
        ],
        [
          "records no dead click when one record swaps a marked cell for an unmarked node",
          (row) => ({
            type: "childList",
            target: row,
            addedNodes: [document.createElement("b")] as unknown as NodeList,
            removedNodes: [row.firstElementChild] as unknown as NodeList,
          }),
          "answered",
        ],
      ])("%s", async (_name, record, outcome) => {
        // A browser reports a replaced child as one record, and happy-dom reports two.
        const live = livePage({ deadClicks: true });
        const row = rowOf(CELL);
        const observer = stubMutationObserver();

        click(live.buy);
        observer.deliver([record(row)]);
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual(
          outcome === "dead" ? [{ "click.action": "buy" }] : [],
        );
      });

      it.each<
        [string, (row: HTMLElement, other: HTMLElement) => Partial<MutationRecord>[], string]
      >([
        [
          "records a dead click when two records of one batch swap a marked cell under one parent",
          (row) => [
            {
              type: "childList",
              target: row,
              addedNodes: [] as unknown as NodeList,
              removedNodes: [row.firstElementChild] as unknown as NodeList,
            },
            {
              type: "childList",
              target: row,
              addedNodes: [marked()] as unknown as NodeList,
              removedNodes: [] as unknown as NodeList,
            },
          ],
          "dead",
        ],
        [
          "records a dead click when two records of one batch swap in the other order",
          (row) => [
            {
              type: "childList",
              target: row,
              addedNodes: [marked()] as unknown as NodeList,
              removedNodes: [] as unknown as NodeList,
            },
            {
              type: "childList",
              target: row,
              addedNodes: [] as unknown as NodeList,
              removedNodes: [row.firstElementChild] as unknown as NodeList,
            },
          ],
          "dead",
        ],
        [
          "records no dead click when a batch adds under one parent and removes under another",
          (row, other) => [
            {
              type: "childList",
              target: row,
              addedNodes: [marked()] as unknown as NodeList,
              removedNodes: [] as unknown as NodeList,
            },
            {
              type: "childList",
              target: other,
              addedNodes: [] as unknown as NodeList,
              removedNodes: [other.firstElementChild] as unknown as NodeList,
            },
          ],
          "answered",
        ],
      ])("%s", async (_name, records, outcome) => {
        // A swap is an add and a remove of marked cells under one parent in one callback batch.
        const live = livePage({ deadClicks: true });
        const row = rowOf(CELL);
        const other = rowOf(CELL);
        const observer = stubMutationObserver();

        click(live.buy);
        observer.deliver(records(row, other));
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual(
          outcome === "dead" ? [{ "click.action": "buy" }] : [],
        );
      });

      it("records a dead click when the only writes keep an attribute's value", async () => {
        const live = livePage({ deadClicks: true });
        const input = field();

        click(live.buy);
        input.setAttribute("type", input.getAttribute("type") ?? "");
        input.setAttribute("name", input.getAttribute("name") ?? "");
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("records a dead click for same-value writes when the selector is empty", async () => {
        // An empty selector counts every change as a response, but a write that keeps the old
        // value isn't a change.
        const live = livePage({ deadClicks: true, deadClickIgnoreSelector: "" });
        const input = field();

        click(live.buy);
        input.setAttribute("type", input.getAttribute("type") ?? "");
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("records a dead click when the only write keeps a text node's data", async () => {
        const live = livePage({ deadClicks: true });
        const text = live.headline.firstChild as Text;
        const current = text.data;

        click(live.buy);
        text.data = current;
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it.each<[string, (input: HTMLInputElement, text: Text) => void]>([
        ["an attribute with a new value", (input) => input.setAttribute("type", "number")],
        ["an added attribute", (input) => input.setAttribute("placeholder", "Qty")],
        ["a removed attribute", (input) => input.removeAttribute("name")],
        [
          "an attribute set twice, and the last value differs from the first",
          (input) => {
            input.setAttribute("type", "number");
            input.setAttribute("type", "email");
          },
        ],
        [
          "a class removed, read into layout and added back",
          (input) => {
            // The layout read restarts a CSS animation, so the user sees an answer.
            input.classList.remove("box");
            const _layout = input.offsetWidth;
            input.classList.add("box");
          },
        ],
        [
          "a class set to another value and back",
          (input) => {
            input.setAttribute("class", "other");
            input.setAttribute("class", "box");
          },
        ],
        [
          "a data attribute set and removed again",
          (input) => {
            input.setAttribute("data-flash", "1");
            input.removeAttribute("data-flash");
          },
        ],
        [
          "a data attribute changed and restored",
          (input) => {
            input.setAttribute("data-state", "busy");
            input.setAttribute("data-state", "idle");
          },
        ],
        [
          "an attribute added and removed again",
          (input) => {
            input.setAttribute("placeholder", "Qty");
            input.removeAttribute("placeholder");
          },
        ],
        [
          "a text node with new data",
          (_input, text) => {
            text.data = "Closed";
          },
        ],
        [
          "a text node set twice, and the last data differs from the first",
          (_input, text) => {
            text.data = "Closed";
            text.data = "Halted";
          },
        ],
      ])("records no dead click when the change is %s", async (_name, change) => {
        const live = livePage({ deadClicks: true });
        const input = field();

        click(live.buy);
        change(input, live.headline.firstChild as Text);
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([]);
      });

      it.each<[string, (input: HTMLInputElement, text: Text) => void]>([
        [
          "the type attribute set to another value and back",
          (input) => {
            input.setAttribute("type", "number");
            input.setAttribute("type", "text");
          },
        ],
        [
          "the name attribute removed and put back with its old value",
          (input) => {
            input.removeAttribute("name");
            input.setAttribute("name", "qty");
          },
        ],
        [
          "a text node set to other data and back",
          (_input, text) => {
            const original = text.data;
            text.data = "Closed";
            text.data = original;
          },
        ],
      ])("records a dead click when one batch leaves %s as it was", async (_name, change) => {
        // Nothing between the writes is painted, so only the net change counts.
        const live = livePage({ deadClicks: true });
        const input = field();

        click(live.buy);
        change(input, live.headline.firstChild as Text);
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("records a dead click when the only write keeps the class attribute's value", async () => {
        const live = livePage({ deadClicks: true });
        const input = field();

        click(live.buy);
        input.setAttribute("class", input.getAttribute("class") ?? "");
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("records no dead click when one batch restarts an animation with style", async () => {
        // The element ends with the style it had, but the layout read between the two writes
        // restarts the animation, so the user sees an answer.
        const live = livePage({ deadClicks: true });
        const box = document.createElement("div");
        box.setAttribute("style", "color: red;");
        document.body.append(box);
        const observer = stubMutationObserver();
        const style = (oldValue: string) => ({
          type: "attributes" as const,
          target: box,
          attributeName: "style",
          attributeNamespace: null,
          oldValue,
        });

        click(live.buy);
        observer.deliver([style("color: red;"), style("color: red; animation: none;")]);
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([]);
      });

      it.each(["href", "type"])(
        "records no dead click when only the xlink:%s of one element changes net",
        async (name) => {
          // The plain and the namespaced attribute share a name, and they are separate pairs.
          const xlink = "http://www.w3.org/1999/xlink";
          const live = livePage({ deadClicks: true });
          const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
          use.setAttribute(name, "a");
          use.setAttributeNS(xlink, `xlink:${name}`, "after");
          document.body.append(use);
          const observer = stubMutationObserver();
          const write = (attributeNamespace: string | null, oldValue: string) => ({
            type: "attributes" as const,
            target: use,
            attributeName: name,
            attributeNamespace,
            oldValue,
          });

          click(live.buy);
          observer.deliver([write(null, "a"), write(xlink, "before")]);
          await vi.advanceTimersByTimeAsync(1000);

          expect(events(live.logger, "ui.dead_click")).toEqual([]);
        },
      );

      it.each<[string, string | undefined]>([
        ["the default selector", undefined],
        ["an empty selector", ""],
      ])("records a dead click for the React write pattern with %s", async (_name, selector) => {
        // React sets name, then type, then removes name again, on an input that has no name. Chrome
        // reports the old value of the last record as "", and happy-dom reports null for it, so a
        // spec that writes the attributes can't show the fault. The records here are Chrome's.
        const live = livePage({ deadClicks: true, deadClickIgnoreSelector: selector });
        const input = document.createElement("input");
        input.setAttribute("type", "number");
        document.body.append(input);
        const observer = stubMutationObserver();
        const attribute = (attributeName: string, oldValue: string | null) => ({
          type: "attributes" as const,
          target: input,
          attributeName,
          attributeNamespace: null,
          oldValue,
        });

        click(live.buy);
        observer.deliver([
          attribute("name", null),
          attribute("type", "number"),
          attribute("name", ""),
        ]);
        await vi.advanceTimersByTimeAsync(1000);

        expect(events(live.logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });
    });
  });

  describe("in an observed window", () => {
    const OTHER_ORIGIN =
      "The library cannot observe a window from another origin. It captures no clicks there.";

    const stops: (() => void)[] = [];
    const popouts: Popout[] = [];
    const captures: InteractionCapture[] = [];

    /**
     * Opens a popout for the spec, and observes it unless told not to.
     * @param observe False to leave the observing to the spec.
     * @returns The popout.
     */
    const open = (observe = true, make: () => Popout = openPopout): Popout => {
      const popout = make();
      popouts.push(popout);
      if (observe) {
        stops.push(observeWindow(popout.win));
      }
      return popout;
    };

    /**
     * Builds the capture on a page that holds the regions. It stays uninstalled. Call this
     * before open(), because it replaces the body, and a popout's iframe lives in the body.
     * @param interactions The interaction options.
     * @param over More capture settings.
     * @returns The capture, its context, the logger and the page's regions.
     */
    const build = (
      interactions: CaptureOptions["interactions"],
      over: Partial<CaptureOptions> = {},
    ) => {
      vi.useFakeTimers();
      const view = ctx({ interactions, ...over });
      document.body.innerHTML = REGIONS;
      const capture = new InteractionCapture(view.ctx);
      captures.push(capture);
      return { capture, c: view.ctx, logger: view.logger, page: regions(document) };
    };

    /** Builds the capture and installs it. */
    const install = (
      interactions: CaptureOptions["interactions"],
      over: Partial<CaptureOptions> = {},
    ) => {
      const built = build(interactions, over);
      built.capture.install();
      return built;
    };

    /** Lets a dead click check time out, which flushes the observer's records first. */
    const wait = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(1000);
    };

    afterEach(() => {
      for (const stop of stops.splice(0)) {
        stop();
      }
      for (const capture of captures.splice(0)) {
        capture.uninstall();
      }
      for (const popout of popouts.splice(0)) {
        popout.close();
      }
      document.body.innerHTML = "";
    });

    it("delivers a click in the popout to a capture listener on its window", () => {
      // A check of the stand-in window, so a red spec below can't blame the harness.
      const popout = open(false);
      const seen = vi.fn();
      popout.win.addEventListener("click", seen, true);

      click(popout.buy);

      expect(seen).toHaveBeenCalledTimes(1);
    });

    it("records the same click breadcrumb as a click in the page's own window", () => {
      const { c, page } = install(true);
      const popout = open();

      click(page.buy);
      click(popout.buy);

      expect(
        c.breadcrumbs.snapshot().map(({ category, message }) => ({ category, message })),
      ).toEqual([
        { category: "click", message: "buy" },
        { category: "click", message: "buy" },
      ]);
    });

    it("rotates the trace on a click in the observed window", () => {
      const { c } = install(true);
      const popout = open();
      const before = c.tracing.resolve().traceId;

      click(popout.buy);

      expect(c.tracing.resolve().traceId).not.toBe(before);
    });

    it("counts rage clicks in the observed window", () => {
      const { logger } = install({ rageClicks: true });
      const popout = open();

      click(popout.buy);
      click(popout.buy);
      click(popout.buy);

      expect(events(logger, "ui.rage_click")).toEqual([
        { "click.action": "buy", "click.count": 3 },
      ]);
    });

    it("records a click on an element that another realm created", () => {
      // happy-dom windows share one Element class, so this makes the page's own class foreign.
      const { c } = install(true);
      const popout = open();
      foreignRealm();

      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toMatchObject([{ category: "click", message: "buy" }]);
    });

    it("skips a click inside an ignore region of the observed window", () => {
      const { c } = install(true);
      const popout = open();
      popout.doc.body.insertAdjacentHTML(
        "beforeend",
        '<div data-observability-ignore><button id="secret">Secret</button></div>',
      );

      click(popout.doc.querySelector("#secret")!);

      expect(c.breadcrumbs.snapshot()).toEqual([]);
    });

    it("records a click in each observed window and in the page's own window", () => {
      const { c, page } = install(true);
      const first = open();
      const second = open();

      click(page.buy);
      click(first.buy);
      click(second.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(3);
    });

    it("adds no listener when the page's own window is observed, so a click records once", () => {
      const { c, page } = install(true);
      const added = vi.spyOn(window, "addEventListener");

      stops.push(observeWindow(window));
      expect(added).not.toHaveBeenCalled();
      click(page.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it("adds one listener when the same window is observed twice", () => {
      const { c } = install(true);
      const popout = open();
      stops.push(observeWindow(popout.win));

      click(popout.buy);

      expect(leftOn(popout, "click")).toBe(1);
      expect(leftOn(popout, "pagehide")).toBe(1);
      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it("removes the listener when the stop function runs, and a second call is fine", () => {
      const { c } = install(true);
      const popout = open(false);
      const stop = observeWindow(popout.win);
      click(popout.buy);

      stop();
      click(popout.buy);

      expect(() => {
        stop();
      }).not.toThrow();
      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
      expect(leftOn(popout, "click")).toBe(0);
    });

    it("stops one window without touching the others", () => {
      const { c } = install(true);
      const first = open(false);
      const second = open();
      const stopFirst = observeWindow(first.win);

      stopFirst();
      click(first.buy);
      click(second.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it("removes a window at pagehide, as if the stop function ran", () => {
      const { c } = install(true);
      const popout = open(false);
      const stop = observeWindow(popout.win);

      popout.win.dispatchEvent(new Event("pagehide"));
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toEqual([]);
      expect(leftOn(popout, "click")).toBe(0);
      expect(leftOn(popout, "pagehide")).toBe(0);
      expect(() => {
        stop();
      }).not.toThrow();
    });

    it("keeps a window observed at the pagehide of its initial about:blank document", () => {
      // The browser fires pagehide on the blank document, then loads the page into the same
      // window object. Forgetting the window here would leave the real page uncaptured.
      const { c } = install(true);
      const popout = open(true, openBlankPopout);

      popout.win.dispatchEvent(new Event("pagehide"));
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
      expect(observedWindows().includes(popout.win)).toBe(true);
      expect(leftOn(popout, "click")).toBe(1);
      expect(leftOn(popout, "pagehide")).toBe(1);
    });

    it("forgets a window at the pagehide of a document that isn't the initial about:blank", () => {
      const { c } = install(true);
      const popout = open(true, openBlankPopout);
      popout.win.history.replaceState(null, "", "#moved");

      popout.win.dispatchEvent(new Event("pagehide"));
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toEqual([]);
      expect(leftOn(popout, "click")).toBe(0);
      expect(leftOn(popout, "pagehide")).toBe(0);
    });

    it("forgets a closed window at the pagehide of its about:blank document", () => {
      const { c } = install(true);
      const popout = open(true, openBlankPopout);
      stubClosed(popout.win, true);

      popout.win.dispatchEvent(new Event("pagehide"));
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toEqual([]);
      expect(leftOn(popout, "click")).toBe(0);
    });

    it("attaches a listed window again when the app observes it a second time", () => {
      // The page behind the handle can get a new Window object, which has none of our listeners.
      const { c } = install(true);
      const popout = open();
      for (const [type, listener, options] of popout.add.mock.calls) {
        popout.win.removeEventListener(type, listener, options);
      }
      click(popout.buy);
      expect(c.breadcrumbs.snapshot()).toEqual([]);

      stops.push(observeWindow(popout.win));
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it("keeps a pagehide handler throw from the page, and forgets the window", async () => {
      install(true);
      const popout = open(true, openBlankPopout);
      const pageErrors = vi.fn();
      addEventListener("error", pageErrors);
      popout.win.addEventListener("error", pageErrors);
      await popout.block();

      try {
        popout.win.dispatchEvent(new Event("pagehide"));
      } finally {
        removeEventListener("error", pageErrors);
      }

      expect(pageErrors).not.toHaveBeenCalled();
      expect(observedWindows().includes(popout.win)).toBe(false);
    });

    it("observes a window again after its stop function ran", () => {
      const { c } = install(true);
      const popout = open(false);
      observeWindow(popout.win)();

      stops.push(observeWindow(popout.win));
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it("attaches a window that was observed before the capture installed", () => {
      const { capture, c } = build(true);
      const popout = open();

      capture.install();
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it("forgets a window that closed before the capture installed, for good", () => {
      // Nothing hears the pagehide of a window while clicks are off, so the install prunes it.
      const { capture, c } = build(true);
      const popout = open();
      const setClosed = stubClosed(popout.win, true);

      capture.install();
      click(popout.buy);
      expect(popout.add).not.toHaveBeenCalled();
      expect(c.breadcrumbs.snapshot()).toEqual([]);

      setClosed(false);
      capture.uninstall();
      capture.install();
      click(popout.buy);
      expect(popout.add).not.toHaveBeenCalled();
      expect(c.breadcrumbs.snapshot()).toEqual([]);
    });

    it("removes the listener at uninstall and adds it again at the next install", () => {
      const { capture, c } = install(true);
      const popout = open();
      click(popout.buy);

      capture.uninstall();
      click(popout.buy);
      expect(leftOn(popout, "click")).toBe(0);
      expect(c.breadcrumbs.snapshot()).toHaveLength(1);

      capture.install();
      click(popout.buy);
      expect(c.breadcrumbs.snapshot()).toHaveLength(2);
    });

    it("attaches the window to the capture that replaces an uninstalled one", () => {
      const { capture, c } = install(true);
      const popout = open();
      capture.uninstall();

      const next = new InteractionCapture(c);
      captures.push(next);
      next.install();
      click(popout.buy);

      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it.each([
      ["interactions are off", {}],
      ["only navigation is on", { navigation: true }],
    ])("adds nothing to the observed window when %s", (_name, over) => {
      const { c } = install(false, over);
      const popout = open();

      click(popout.buy);

      expect(popout.add).not.toHaveBeenCalled();
      expect(c.breadcrumbs.snapshot()).toEqual([]);
    });

    it("adds no navigation capture to the observed window", () => {
      install(true, { navigation: true });
      const popout = open(false);
      const { pushState, replaceState } = popout.win.history;

      stops.push(observeWindow(popout.win));

      expect(popout.win.history.pushState).toBe(pushState);
      expect(popout.win.history.replaceState).toBe(replaceState);
      const added = popout.add.mock.calls.map(([type]) => type);
      expect(added).not.toContain("popstate");
      expect(added).not.toContain("hashchange");
    });

    it.each([
      ["blocks every read", foreignWindow],
      ["blocks only the document", blockedDocumentWindow],
    ])("reports a window from another origin once when it %s", (_name, make) => {
      const { c, page } = install(true);
      const reported = vi.fn<(event: DiagnosticEvent) => void>();
      c.diagnostics.setHandler(reported);
      let stop: (() => void) | undefined;

      expect(() => {
        stop = observeWindow(make());
      }).not.toThrow();

      expect(stop).toBeTypeOf("function");
      expect(() => {
        stop?.();
      }).not.toThrow();
      expect(reported.mock.calls.map(([event]) => [event.code, event.message])).toEqual([
        ["capture.install_failed", OTHER_ORIGIN],
      ]);
      click(page.buy);
      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    it("reports a window from another origin that was observed before the install", () => {
      const { capture, c } = build(true);
      const reported = vi.fn<(event: DiagnosticEvent) => void>();
      c.diagnostics.setHandler(reported);
      stops.push(observeWindow(foreignWindow()));

      capture.install();

      expect(reported.mock.calls.map(([event]) => [event.code, event.message])).toEqual([
        ["capture.install_failed", OTHER_ORIGIN],
      ]);
    });

    it.each([null, undefined, {}])("gives a stop function that does nothing for %s", (value) => {
      const { c, page } = install(true);
      const reported = vi.fn<(event: DiagnosticEvent) => void>();
      c.diagnostics.setHandler(reported);

      const stop = observeWindow(asWindow(value));

      expect(stop).toBeTypeOf("function");
      expect(() => {
        stop();
      }).not.toThrow();
      expect(reported.mock.calls.map(([event]) => event.message)).not.toContain(OTHER_ORIGIN);
      click(page.buy);
      expect(c.breadcrumbs.snapshot()).toHaveLength(1);
    });

    describe("when an observed window turns cross-origin", () => {
      let originals: Pick<History, "pushState" | "replaceState"> | undefined;

      beforeEach(() => {
        originals = { pushState: history.pushState, replaceState: history.replaceState };
      });

      afterEach(() => {
        // A failed uninstall leaves the history patches in, and the next spec mustn't inherit them.
        if (originals) {
          history.pushState = originals.pushState;
          history.replaceState = originals.replaceState;
        }
      });

      it("lets the stop function run without a throw", async () => {
        install(true);
        const popout = open(false);
        const stop = observeWindow(popout.win);
        await popout.block();

        expect(() => {
          stop();
        }).not.toThrow();
        expect(observedWindows().includes(popout.win)).toBe(false);
      });

      it("lets uninstall run without a throw, and restores the history patches", async () => {
        const { capture, c, page } = build(true, { navigation: true });
        const { pushState, replaceState } = history;
        capture.install();
        const popout = open();
        await popout.block();

        expect(() => {
          capture.uninstall();
        }).not.toThrow();

        expect(history.pushState).toBe(pushState);
        expect(history.replaceState).toBe(replaceState);
        click(page.buy);
        expect(c.breadcrumbs.snapshot()).toEqual([]);
      });

      it("detaches the other windows when one throws at uninstall", async () => {
        const { capture } = install(true);
        const blocked = open();
        const healthy = open();
        await blocked.block();

        expect(() => {
          capture.uninstall();
        }).not.toThrow();

        expect(leftOn(healthy, "click")).toBe(0);
      });

      it("counts a URL read that throws as a URL change in the dead check", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        await popout.block();
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("ends a dead check without a throw, and the next click gets a check", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open();
        click(page.buy);
        await popout.block();

        await wait();
        const before = events(logger, "ui.dead_click").length;
        click(page.buy);
        await wait();

        expect(events(logger, "ui.dead_click")).toHaveLength(before + 1);
      });

      it("skips and forgets a window whose document can't be read in a dead check", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open();
        await popout.block();

        click(page.buy);
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
        expect(observedWindows().includes(popout.win)).toBe(false);
      });
    });

    it.each<[string, unknown]>([
      ["an empty object", {}],
      ["null", null],
      ["a registry with members of the wrong type", { windows: "x", observers: 1 }],
    ])("replaces %s under the registry key with a fresh registry", (_name, value) => {
      const { capture, c } = build(true);
      const popout = open(false);
      const key = Symbol.for(`${OBSERVED_WINDOWS_KEY}@${TELEMETRY_SDK_VERSION}`);
      (globalThis as Record<symbol, unknown>)[key] = value;

      try {
        expect(() => {
          stops.push(observeWindow(popout.win));
        }).not.toThrow();
        capture.install();
        click(popout.buy);

        expect(c.breadcrumbs.snapshot()).toHaveLength(1);
      } finally {
        Reflect.deleteProperty(globalThis, key);
      }
    });

    it.each<[string, (page: Regions, popout: Popout) => Element]>([
      ["the page's own window", (page) => page.buy],
      ["an observed window", (_page, popout) => popout.buy],
    ])("keeps a throw while it handles a click in %s away from the page", (_name, pick) => {
      const { c, page } = install(true);
      const popout = open();
      const reported = vi.fn<(event: DiagnosticEvent) => void>();
      c.diagnostics.setHandler(reported);
      const pageErrors = vi.fn();
      addEventListener("error", pageErrors);
      popout.win.addEventListener("error", pageErrors);
      const target = pick(page, popout);
      vi.spyOn(target, "closest").mockImplementation(() => {
        throw new TypeError("closest failed");
      });

      click(target);
      removeEventListener("error", pageErrors);

      expect(pageErrors).not.toHaveBeenCalled();
      expect(reported.mock.calls.map(([event]) => event.code)).toEqual(["capture.record_failed"]);
    });

    it.each([
      ["has no addEventListener", { document: {} }],
      ["has an addEventListener that isn't a function", { document: {}, addEventListener: "x" }],
    ])(
      "gives a stop function that does nothing for a value with a document that %s",
      (_n, value) => {
        const { c, page } = install(true);
        const reported = vi.fn<(event: DiagnosticEvent) => void>();
        c.diagnostics.setHandler(reported);

        const stop = observeWindow(asWindow(value));

        expect(stop).toBeTypeOf("function");
        expect(() => {
          stop();
        }).not.toThrow();
        expect(reported).not.toHaveBeenCalled();
        click(page.buy);
        expect(c.breadcrumbs.snapshot()).toHaveLength(1);
      },
    );

    describe("dead clicks", () => {
      it("drops a window that closed after the install at the next dead check", async () => {
        // A user-closed about:blank popout still reads closed false at its pagehide, so the
        // registry sees it close later.
        const { logger, page } = install({ deadClicks: true });
        const popout = open(true, openBlankPopout);
        stubClosed(popout.win, true);

        click(page.buy);
        popout.feed.append(popout.doc.createElement("i"));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
        expect(observedWindows().includes(popout.win)).toBe(false);
        expect(popout.add.mock.calls.filter(([type]) => type === "scroll")).toEqual([]);
      });

      it("doesn't observe a dropped window again, even if it reads open", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open(true, openBlankPopout);
        const setClosed = stubClosed(popout.win, true);
        click(page.buy);
        await wait();

        setClosed(false);
        click(page.buy);
        popout.feed.append(popout.doc.createElement("i"));
        await wait();

        expect(events(logger, "ui.dead_click")).toHaveLength(2);
        expect(observedWindows().includes(popout.win)).toBe(false);
      });

      it("records a dead click for a click in the observed window with no answer", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("records no dead click when the page's own document answers the click", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        page.feed.append(document.createElement("i"));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("records no dead click when the observed window's own document answers", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        popout.feed.append(popout.doc.createElement("i"));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("records no dead click when a click in the page changes an observed window", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open();

        click(page.buy);
        popout.feed.append(popout.doc.createElement("i"));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("ignores a change in a live region of the observed window", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        popout.price.textContent = "101";
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("ignores a live region of the page for a click in the observed window", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        page.price.textContent = "101";
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("ignores a live region of an observed window for a click in the page", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open();

        click(page.buy);
        popout.price.textContent = "101";
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it("counts a change outside a live region in one document as a response", async () => {
        const { logger, page } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        popout.price.textContent = "101";
        page.feed.append(document.createElement("i"));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("records no dead click when the observed window's document scrolls", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        popout.doc.dispatchEvent(new Event("scroll", { bubbles: true }));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("records no dead click when an element outside a live region scrolls there", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        popout.feed.dispatchEvent(new Event("scroll"));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("ignores a scroll inside a live region of the observed window", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        popout.grid.dispatchEvent(new Event("scroll"));
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });

      it.each<[string, (popout: Popout, stop: () => void) => void]>([
        [
          "goes away at pagehide",
          (popout) => {
            popout.win.dispatchEvent(new Event("pagehide"));
          },
        ],
        [
          "stops being observed",
          (_popout, stop) => {
            stop();
          },
        ],
      ])(
        "records no dead click and keeps no listener when the clicked window %s",
        async (_name, leave) => {
          const { logger } = install({ deadClicks: true });
          const popout = open(false);
          const stop = observeWindow(popout.win);
          click(popout.buy);

          leave(popout, stop);
          await wait();

          expect(events(logger, "ui.dead_click")).toEqual([]);
          expect(["click", "pagehide", "scroll"].map((type) => leftOn(popout, type))).toEqual([
            0, 0, 0,
          ]);
        },
      );

      it("records no dead click when the URL of the clicked window changes", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();

        click(popout.buy);
        popout.win.history.replaceState(null, "", "#moved");
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it("records no dead click when the URL of the page changes", async () => {
        const { logger } = install({ deadClicks: true });
        const popout = open();
        const original = location.href;

        click(popout.buy);
        history.replaceState(null, "", "/moved");
        await wait();
        history.replaceState(null, "", original);

        expect(events(logger, "ui.dead_click")).toEqual([]);
      });

      it.each<[string, (popout: Popout) => void]>([
        [
          "the data of a text node",
          ({ price }) => {
            (price.firstChild as Text).data = "101";
          },
        ],
        [
          "an attribute",
          ({ price }) => {
            price.setAttribute("class", "up");
          },
        ],
      ])("ignores %s in a live region of another realm", async (_name, change) => {
        const { logger } = install({ deadClicks: true });
        const popout = open();
        foreignRealm();

        click(popout.buy);
        change(popout);
        await wait();

        expect(events(logger, "ui.dead_click")).toEqual([{ "click.action": "buy" }]);
      });
    });
  });
});

describe("WebVitalsCapture", () => {
  /** Nothing here loads the real package. The loader is the test seam. */
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
      webVitals: {
        loader: () =>
          Promise.resolve({
            onLCP: subscribe("lcp"),
            onCLS: subscribe("cls"),
            onINP: subscribe("inp"),
            onFCP: subscribe("fcp"),
            onTTFB: subscribe("ttfb"),
          }),
      },
    });

    const capture = new WebVitalsCapture(c);
    capture.install();
    await vi.waitFor(() => {
      expect(reporters.lcp).toBeTypeOf("function");
    });

    reporters.lcp({ value: 1234.5678, id: "v1", rating: "good" });

    expect(logger.logMetric).toHaveBeenCalledWith(
      "web_vitals.lcp",
      1234.568,
      "ms",
      "gauge",
      { "metric.rating": "good" },
      { "metric.id": "v1" },
    );
    capture.uninstall();
  });

  it("says what is missing when the optional peer is not installed", async () => {
    const { ctx: c } = ctx({ webVitals: { loader: nullLoader } });

    new WebVitalsCapture(c).install();

    await vi.waitFor(() => {
      expect(c.diagnostics.snapshot()["capture.install_failed"]).toBeGreaterThan(0);
    });
  });

  it("reports config.invalid and imports nothing without a loader", async () => {
    // The Vite dev server fails on a bare import of a peer that is not installed.
    // web-vitals loads only through capture.webVitals.loader.
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

    c.config.capture.webVitals = {
      loader: () =>
        Promise.resolve({
          onLCP: subscribe(),
          onCLS: subscribe(),
          onINP: subscribe(),
          onFCP: subscribe(),
          onTTFB: subscribe(),
        }),
    };
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
      webVitals: {
        loader: () => {
          loads++;
          // The first load fails, for example a chunk the network didn't deliver.
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
      webVitals: {
        loader: () =>
          Promise.resolve({
            onLCP: subscribe(),
            onCLS: subscribe(),
            onINP: subscribe(),
            onFCP: subscribe(),
            onTTFB: subscribe(),
          }),
      },
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
    const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      {
        domainLookupEnd: 10,
        domainLookupStart: 5,
        // connectEnd before connectStart gives a negative duration, which would poison the
        // percentile chart it lands in.
        connectEnd: 8,
        connectStart: 9,
        responseStart: 20,
        requestStart: 15,
        responseEnd: 30,
        domInteractive: 40,
        domComplete: 50,
        loadEventEnd: 60,
        type: "navigate",
      } as never,
    ]);

    new WebVitalsCapture(c).install();

    const names = logger.logMetric.mock.calls.map((call) => call[0]);
    expect(names).toContain("navigation.dns_ms");
    expect(names).toContain("navigation.load_ms");
    expect(names).not.toContain("navigation.tcp_ms");
  });

  describe("before the load event has finished", () => {
    // A browser reports 0 for domComplete and loadEventEnd until the load event has finished.
    const entry = {
      domainLookupEnd: 10,
      domainLookupStart: 5,
      connectEnd: 8,
      connectStart: 6,
      responseStart: 20,
      requestStart: 15,
      responseEnd: 30,
      domInteractive: 40,
      domComplete: 0,
      loadEventEnd: 0,
      type: "navigate",
    };

    const values = (logger: { logMetric: { mock: { calls: unknown[][] } } }) =>
      Object.fromEntries(logger.logMetric.mock.calls.map((call) => [call[0], call[1]]));

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits for the load event instead of reporting a load time of 0", async () => {
      const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
      const nav = { ...entry };
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([nav as never]);
      vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");

      new WebVitalsCapture(c).install();

      expect(logger.logMetric).not.toHaveBeenCalled();

      // The browser fills in loadEventEnd only after the load handlers have returned.
      nav.domComplete = 50;
      window.dispatchEvent(new Event("load"));
      expect(logger.logMetric).not.toHaveBeenCalled();
      nav.loadEventEnd = 60;
      await vi.advanceTimersByTimeAsync(0);

      expect(values(logger)).toMatchObject({
        "navigation.dns_ms": 5,
        "navigation.dom_interactive_ms": 40,
        "navigation.dom_complete_ms": 50,
        "navigation.load_ms": 60,
      });
      expect(logger.logMetric).toHaveBeenCalledTimes(7);
    });

    it("reads one task later when it starts inside a load handler", async () => {
      const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
      const nav = { ...entry, domComplete: 50 };
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([nav as never]);
      // readyState is already "complete" while the load handlers run, and no second load
      // event will come.
      vi.spyOn(document, "readyState", "get").mockReturnValue("complete");

      new WebVitalsCapture(c).install();
      nav.loadEventEnd = 60;
      await vi.advanceTimersByTimeAsync(0);

      expect(values(logger)).toMatchObject({ "navigation.load_ms": 60 });
    });

    it("leaves out a milestone that is still 0 after the load event", async () => {
      const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ ...entry } as never]);
      vi.spyOn(document, "readyState", "get").mockReturnValue("complete");

      new WebVitalsCapture(c).install();
      await vi.advanceTimersByTimeAsync(0);

      // A DNS time of 0 is real (a cached lookup). A load time of 0 is not.
      const seen = values(logger);
      expect(seen).toMatchObject({ "navigation.dns_ms": 5, "navigation.dom_interactive_ms": 40 });
      expect(seen).not.toHaveProperty("navigation.dom_complete_ms");
      expect(seen).not.toHaveProperty("navigation.load_ms");
    });

    it("logs what is ready when the page is hidden before the load event, and the rest after it", async () => {
      const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
      // The document is still downloading, so responseEnd is 0 as well.
      const nav = { ...entry, responseEnd: 0 };
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([nav as never]);
      vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

      new WebVitalsCapture(c).install();

      // Back to visible is not a reason to report.
      document.dispatchEvent(new Event("visibilitychange"));
      expect(logger.logMetric).not.toHaveBeenCalled();

      // The user leaves a slow page. Without this report, the slowest loads go missing.
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));

      expect(values(logger)).toEqual({
        "navigation.dns_ms": 5,
        "navigation.tcp_ms": 2,
        "navigation.ttfb_ms": 5,
        "navigation.dom_interactive_ms": 40,
      });

      // The user comes back and the page finishes. Only the missing metrics follow.
      nav.responseEnd = 30;
      nav.domComplete = 50;
      window.dispatchEvent(new Event("load"));
      nav.loadEventEnd = 60;
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.logMetric).toHaveBeenCalledTimes(7);
      expect(values(logger)).toMatchObject({
        "navigation.response_ms": 10,
        "navigation.dom_complete_ms": 50,
        "navigation.load_ms": 60,
      });

      // The late read took the listener away, so a later hide reports nothing more.
      document.dispatchEvent(new Event("visibilitychange"));
      expect(logger.logMetric).toHaveBeenCalledTimes(7);
    });

    it("reports a fault of the early read to diagnostics", () => {
      const { ctx: c, logger } = ctx({ webVitals: true });
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ ...entry } as never]);
      vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      logger.logMetric.mockImplementation(() => {
        throw new Error("logger fault");
      });

      new WebVitalsCapture(c).install();
      document.dispatchEvent(new Event("visibilitychange"));

      expect(c.diagnostics.snapshot()["capture.install_failed"]).toBe(1);
    });

    it("reports a fault of the late read to diagnostics", async () => {
      // No loader, so the only capture.install_failed report can come from the late read.
      const { ctx: c, logger } = ctx({ webVitals: true });
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ ...entry } as never]);
      vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
      logger.logMetric.mockImplementation(() => {
        throw new Error("logger fault");
      });

      new WebVitalsCapture(c).install();
      await vi.advanceTimersByTimeAsync(0);

      expect(c.diagnostics.snapshot()["capture.install_failed"]).toBe(1);
    });
  });

  describe("on a prerendered page", () => {
    // The browser loaded the page 4 s before the user opened it. Every time in the entry
    // counts from the start of the prerender.
    const entry = {
      domainLookupEnd: 10,
      domainLookupStart: 5,
      connectEnd: 8,
      connectStart: 6,
      responseStart: 20,
      requestStart: 15,
      responseEnd: 30,
      domInteractive: 3000,
      domComplete: 4500,
      loadEventEnd: 5000,
      activationStart: 4000,
      type: "navigate",
    };

    const sent = (logger: { logMetric: { mock: { calls: unknown[][] } } }) =>
      Object.fromEntries(logger.logMetric.mock.calls.map((call) => [call[0], call[1]]));

    /** Sets document.prerendering, which happy-dom doesn't have. */
    const prerendering = (value: boolean): void => {
      Object.defineProperty(document, "prerendering", { configurable: true, value });
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (document as { prerendering?: boolean }).prerendering;
    });

    it("counts the milestones from the activation and marks the navigation as prerender", () => {
      const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ ...entry } as never]);

      new WebVitalsCapture(c).install();

      expect(sent(logger)).toEqual({
        // The request phases are durations, so the prerender doesn't change them.
        "navigation.dns_ms": 5,
        "navigation.tcp_ms": 2,
        "navigation.ttfb_ms": 5,
        "navigation.response_ms": 10,
        // Interactive before the user opened the page: they waited 0 ms for it.
        "navigation.dom_interactive_ms": 0,
        "navigation.dom_complete_ms": 500,
        "navigation.load_ms": 1000,
      });
      const types = logger.logMetric.mock.calls.map(
        (call) => (call[4] as Record<string, string>)["navigation.type"],
      );
      expect(types).toEqual(Array(7).fill("prerender"));
    });

    it("reports nothing until the user opens a page that finished loading in the prerender", () => {
      const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
      // activationStart is 0 until the activation.
      const nav = { ...entry, activationStart: 0 };
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([nav as never]);
      prerendering(true);

      new WebVitalsCapture(c).install();

      // A page that nobody opens must not report a load at all.
      expect(logger.logMetric).not.toHaveBeenCalled();

      prerendering(false);
      nav.activationStart = 6000;
      document.dispatchEvent(new Event("prerenderingchange"));

      expect(sent(logger)).toMatchObject({
        "navigation.dom_interactive_ms": 0,
        "navigation.dom_complete_ms": 0,
        "navigation.load_ms": 0,
      });
    });

    it("waits for the activation when the load event ends during the prerender", async () => {
      const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
      const nav = { ...entry, activationStart: 0, domComplete: 0, loadEventEnd: 0 };
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([nav as never]);
      vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
      // A prerendered page is hidden, but that is not the user leaving.
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      prerendering(true);

      new WebVitalsCapture(c).install();
      document.dispatchEvent(new Event("visibilitychange"));
      expect(logger.logMetric).not.toHaveBeenCalled();

      nav.domComplete = 4500;
      window.dispatchEvent(new Event("load"));
      nav.loadEventEnd = 5000;
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.logMetric).not.toHaveBeenCalled();

      prerendering(false);
      nav.activationStart = 4000;
      document.dispatchEvent(new Event("prerenderingchange"));

      expect(sent(logger)).toMatchObject({
        "navigation.dom_complete_ms": 500,
        "navigation.load_ms": 1000,
      });
      expect(logger.logMetric).toHaveBeenCalledTimes(7);
    });
  });

  it("returns quietly when there is no navigation entry at all", () => {
    const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);

    new WebVitalsCapture(c).install();

    expect(logger.logMetric).not.toHaveBeenCalled();
  });

  it("reads navigation timing once, however many times it is installed", () => {
    const { ctx: c, logger } = ctx({ webVitals: { loader: nullLoader } });
    // happy-dom has no navigation entry. This test supplies one.
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { domainLookupEnd: 10, domainLookupStart: 5, loadEventEnd: 60, type: "navigate" } as never,
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
      webVitals: {
        loader: () =>
          Promise.resolve({
            onLCP: subscribe(),
            onCLS: subscribe(),
            onINP: subscribe(),
            onFCP: subscribe(),
            onTTFB: subscribe(),
          }),
      },
    });

    const first = new WebVitalsCapture(c);
    first.install();
    await vi.waitFor(() => {
      expect(subscriptions).toBe(5);
    });

    // web-vitals has no unsubscribe, so the rebuilt instance must not call the reporters again.
    // Otherwise it reports every LCP twice.
    first.uninstall();
    const second = new WebVitalsCapture(c);
    second.install();
    await Promise.resolve();

    expect(subscriptions).toBe(5);
    second.uninstall();
  });
});

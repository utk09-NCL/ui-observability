import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkCapture } from "../src/capture/network";
import { readServerTiming } from "../src/capture/server-timing";
import type { CaptureContext } from "../src/capture/types";
import { SERVER_TIMING_MAX_ENTRIES } from "../src/constants";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { rootSpan, spanFields } from "../src/core/spans";
import type { LogRecord } from "../src/models/log-record";
import { otlpTracesSerializer } from "../src/transport/serializers/otlp-traces";
import { TraceEngine } from "../src/utils/tracing";

const TRACE = "a".repeat(32);
const SPAN = "b".repeat(16);
const HEADER = `cache;dur=3.5;desc="hit, local; fast", traceparent;desc="00-${TRACE}-${SPAN}-01"`;

function context(serverTiming = true): CaptureContext {
  const diagnostics = new Diagnostics(vi.fn(), 0);
  return {
    config: resolveConfig(
      {
        endpoint: null,
        serviceName: "svc",
        capture: {
          fetch: true,
          xhr: true,
          serverTiming,
          propagateTraceHeaderTo: ["https://api.example"],
        },
      },
      diagnostics,
    ),
    diagnostics,
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      logEvent: vi.fn(),
      logMetric: vi.fn(),
      debug: vi.fn(),
    },
    breadcrumbs: new BreadcrumbBuffer(10),
    tracing: new TraceEngine(diagnostics, undefined, undefined, {
      enabled: () => true,
      keeps: () => true,
      onEnd: vi.fn(),
    }),
    once: {
      webVitals: false,
      navigationTiming: false,
      longFrames: false,
      uncleanExit: false,
      userTiming: false,
    },
    recordMetric: vi.fn(),
    recordSpan: vi.fn(),
    sessionId: () => "session",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Server-Timing entries", () => {
  it("reads durations, quoted separators, escapes and a server traceparent", () => {
    expect(readServerTiming(`${HEADER}, db;dur="12";desc="a\\"b\\\\c"`)).toEqual({
      entries: [
        { name: "cache", duration: 3.5, description: "hit, local; fast" },
        { name: "traceparent", duration: 0, description: `00-${TRACE}-${SPAN}-01` },
        { name: "db", duration: 12, description: 'a"b\\c' },
      ],
      link: { traceId: TRACE, spanId: SPAN },
    });
  });

  it("uses the first parameter and ignores invalid names and durations", () => {
    expect(
      readServerTiming(
        "bad name;dur=2, cache;flag;dur=-1;dur=9;desc=a;desc=b;other=x, db;dur=NaN, app;dur=Infinity, ",
      ),
    ).toEqual({
      entries: [
        { name: "cache", duration: 0, description: "a" },
        { name: "db", duration: 0, description: "" },
        { name: "app", duration: 0, description: "" },
      ],
    });
    expect(readServerTiming(null)).toEqual({ entries: [] });
    expect(readServerTiming("")).toEqual({ entries: [] });
  });

  it.each(["invalid", `00-${"0".repeat(32)}-${SPAN}-01`, `00-${TRACE}-${"0".repeat(16)}-01`])(
    "refuses the invalid traceparent %s",
    (parent) => {
      expect(readServerTiming(`traceparent;desc="${parent}"`).link).toBeUndefined();
    },
  );

  it("bounds the header length and the number of entries", () => {
    expect(
      readServerTiming(Array.from({ length: 100 }, () => "db;dur=1").join(",")).entries,
    ).toHaveLength(SERVER_TIMING_MAX_ENTRIES);
    expect(readServerTiming(`db;desc="${"x".repeat(5000)}",late;dur=1`).entries).toHaveLength(1);
  });
});

describe("Server-Timing in request capture", () => {
  it("adds entries to fetch records and links the client span to the server span", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { headers: { "Server-Timing": HEADER } })),
    );
    const ctx = context();
    const sut = new NetworkCapture(ctx);
    sut.install();
    await fetch("https://api.example/orders");
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      "GET https://api.example/orders",
      expect.objectContaining({ "server.timing": readServerTiming(HEADER).entries }),
    );
    expect(ctx.recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({ link: { traceId: TRACE, spanId: SPAN } }),
    );
    sut.uninstall();
  });

  it("does not read the header when server timing is off", async () => {
    const response = new Response(null);
    const read = vi.spyOn(response.headers, "get");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    const ctx = context(false);
    const sut = new NetworkCapture(ctx);
    sut.install();
    await fetch("https://api.example/orders");
    expect(read).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.logger.debug).mock.calls[0][1]).not.toHaveProperty("server.timing");
    sut.uninstall();
  });

  it("keeps a response when reading its timing header fails", async () => {
    const response = new Response(null);
    vi.spyOn(response.headers, "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    const ctx = context();
    const sut = new NetworkCapture(ctx);
    sut.install();
    await expect(fetch("https://api.example/orders")).resolves.toBe(response);
    expect(ctx.diagnostics.snapshot()["capture.record_failed"]).toBe(1);
    sut.uninstall();
  });

  it("keeps an empty response header and a failed fetch without timing entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null))
        .mockRejectedValueOnce(new Error("network")),
    );
    const ctx = context();
    const sut = new NetworkCapture(ctx);
    sut.install();
    await fetch("https://api.example/orders");
    await expect(fetch("https://api.example/orders")).rejects.toThrow("network");
    expect(vi.mocked(ctx.logger.debug).mock.calls[0][1]).not.toHaveProperty("server.timing");
    expect(vi.mocked(ctx.logger.error).mock.calls[0][2]).not.toHaveProperty("server.timing");
    sut.uninstall();
  });

  it.each([false, true])("reads an XHR response with a header failure set to %j", (fails) => {
    vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(() => undefined);
    const ctx = context();
    const sut = new NetworkCapture(ctx);
    sut.install();
    const xhr = new XMLHttpRequest();
    vi.spyOn(xhr, "status", "get").mockReturnValue(200);
    // Chrome prints a console error for a direct read of a hidden cross-origin header.
    const direct = vi.spyOn(xhr, "getResponseHeader");
    vi.spyOn(xhr, "getAllResponseHeaders").mockImplementation(() => {
      if (fails) {
        throw new Error("blocked");
      }
      return `content-type: text/plain\r\nserver-timing: ${HEADER}\r\n`;
    });
    xhr.open("GET", "https://api.example/orders");
    xhr.send();
    xhr.dispatchEvent(new Event("loadend"));
    expect(direct).not.toHaveBeenCalled();
    expect(ctx.logger.debug).toHaveBeenCalledOnce();
    expect(ctx.diagnostics.snapshot()["capture.record_failed"] ?? 0).toBe(fails ? 1 : 0);
    if (!fails) {
      expect(vi.mocked(ctx.logger.debug).mock.calls[0][1]).toHaveProperty(
        "server.timing",
        readServerTiming(HEADER).entries,
      );
    }
    sut.uninstall();
  });

  it("adds no entries for an XHR response without the header", () => {
    vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);
    vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(() => undefined);
    const ctx = context();
    const sut = new NetworkCapture(ctx);
    sut.install();
    const xhr = new XMLHttpRequest();
    vi.spyOn(xhr, "status", "get").mockReturnValue(200);
    vi.spyOn(xhr, "getAllResponseHeaders").mockReturnValue("content-type: text/plain\r\n");
    xhr.open("GET", "https://api.example/orders");
    xhr.send();
    xhr.dispatchEvent(new Event("loadend"));
    expect(vi.mocked(ctx.logger.debug).mock.calls[0][1]).not.toHaveProperty("server.timing");
    sut.uninstall();
  });
});

describe("Server links in OTLP spans", () => {
  it("writes a link without making the server span the parent", () => {
    const root = rootSpan({
      traceId: TRACE,
      spanId: SPAN,
      startedAt: 1,
      endedAt: 2,
      reason: "start",
    });
    const fields = spanFields({ ...root, link: { traceId: TRACE, spanId: SPAN } });
    const record: LogRecord = {
      timeUnixNano: "1",
      traceId: TRACE,
      spanId: SPAN,
      traceFlags: 1,
      severityNumber: 9,
      severityText: "INFO",
      body: "GET",
      attributes: fields,
      resource: {},
    };
    const payload = JSON.parse(otlpTracesSerializer.serialize([record]).body);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.links).toEqual([{ traceId: TRACE, spanId: SPAN }]);
    expect(span).not.toHaveProperty("parentSpanId");
    expect(span.attributes).toEqual([]);

    Reflect.deleteProperty(fields, "span.link.span_id");
    const withoutSpan = JSON.parse(otlpTracesSerializer.serialize([record]).body);
    expect(withoutSpan.resourceSpans[0].scopeSpans[0].spans[0]).not.toHaveProperty("links");
  });
});

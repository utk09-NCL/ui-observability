import { describe, expect, it, vi } from "vitest";
import {
  BEACON_LIMIT_BYTES,
  COMPRESSION_THRESHOLD_BYTES,
  REQUEST_TIMEOUT_MS,
  RETRY_MAX_DELAY_MS,
} from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig } from "../src/models/config";
import { gzip } from "../src/transport/compression";
import { parseRetryAfter, TransportError } from "../src/transport/errors";
import { HttpTransport } from "../src/transport/http-transport";

const diagnostics = () => new Diagnostics(vi.fn(), 0);

const config = (over: Partial<ObservabilityConfig> = {}) =>
  resolveConfig(
    { endpoint: "https://x/v1/logs", serviceName: "svc", compression: "none", ...over },
    diagnostics(),
  );

/**
 * The tests below use a `count` of 0. An empty batch must do nothing. It must not send a request.
 */
const batch = (count = 2): LogBatch => ({
  id: "batch-1",
  createdAt: Date.now(),
  attempts: 0,
  records: Array.from({ length: count }, (_unused, i) => ({
    timeUnixNano: "1755543600123000000",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
    severityNumber: 9,
    severityText: "INFO" as const,
    body: `r${String(i)}`,
    attributes: {},
    resource: { "service.name": "svc" },
  })),
});

/** A batch whose serialized body clears COMPRESSION_THRESHOLD_BYTES with room to spare. */
const bigBatch = (): LogBatch => {
  const b = batch(1);
  return {
    ...b,
    records: [{ ...b.records[0], body: "x".repeat(COMPRESSION_THRESHOLD_BYTES * 2) }],
  };
};

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/** The body is null by default. 204 is a null-body status. A Response with both throws. */
const answer = (status: number, body: string | null = null, headers: Record<string, string> = {}) =>
  stubFetch(() => Promise.resolve(new Response(body, { status, headers })));

/** The request init of one call, which is where the headers and the body live. */
const initOf = (fetchMock: any, index = 0): RequestInit => fetchMock.mock.calls[index][1];

const headersOf = (fetchMock: any, index = 0): Headers =>
  initOf(fetchMock, index).headers as Headers;

describe("HttpTransport", () => {
  it("gives the sampling header of a 2xx answer to the sampling callback", async () => {
    answer(204, null, { "X-UiObs-Sampling": '{"v":1,"ttlMs":1000}' });
    const onSampling = vi.fn();
    const t = new HttpTransport(config({ sampling: { remote: true } }), diagnostics(), onSampling);

    await t.send(batch());

    expect(onSampling).toHaveBeenCalledWith('{"v":1,"ttlMs":1000}');
  });

  it("ignores the sampling header with remote sampling off, and a 2xx with no header", async () => {
    answer(204, null, { "X-UiObs-Sampling": '{"v":1,"ttlMs":1000}' });
    const onSampling = vi.fn();
    const off = new HttpTransport(config(), diagnostics(), onSampling);
    await off.send(batch());

    answer(204);
    const on = new HttpTransport(config({ sampling: { remote: true } }), diagnostics(), onSampling);
    await on.send(batch());

    expect(onSampling).not.toHaveBeenCalled();
  });

  it("accepts a header with no sampling callback", async () => {
    answer(204, null, { "X-UiObs-Sampling": '{"v":1,"ttlMs":1000}' });
    const t = new HttpTransport(config({ sampling: { remote: true } }), diagnostics());

    await expect(t.send(batch())).resolves.toBeUndefined();
  });

  it("classifies a 400 as permanent so it is never retried forever", async () => {
    answer(400);
    const t = new HttpTransport(config(), diagnostics());

    await expect(t.send(batch())).rejects.toMatchObject({ kind: "permanent" });
  });

  it("honours Retry-After on a 429, and holds the live path off for that long", async () => {
    answer(429, null, { "Retry-After": "7" });
    const t = new HttpTransport(config(), diagnostics());

    await expect(t.send(batch())).rejects.toMatchObject({ kind: "throttled", retryAfterMs: 7000 });
    expect(t.throttledForMs()).toBeGreaterThan(6000);
  });

  it("caps Retry-After at RETRY_MAX_DELAY_MS", async () => {
    answer(429, null, { "Retry-After": "86400" });
    const t = new HttpTransport(config(), diagnostics());

    await expect(t.send(batch())).rejects.toMatchObject({
      kind: "throttled",
      retryAfterMs: RETRY_MAX_DELAY_MS,
    });
    expect(t.throttledForMs()).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  it("classifies a 413 as too_large and surfaces the limit the server reported", async () => {
    answer(413, JSON.stringify({ maxBytes: 65536 }));
    const t = new HttpTransport(config(), diagnostics());

    await expect(t.send(batch(4))).rejects.toMatchObject({ kind: "too_large", maxBytes: 65536 });
  });

  it("survives a 413 whose body is not the JSON the contract makes optional", async () => {
    answer(413, "Payload Too Large");
    const t = new HttpTransport(config(), diagnostics());

    await expect(t.send(batch(4))).rejects.toMatchObject({
      kind: "too_large",
      maxBytes: undefined,
    });
  });

  it("ignores a 413 maxBytes that is not a number", async () => {
    answer(413, JSON.stringify({ maxBytes: "lots" }));
    const t = new HttpTransport(config(), diagnostics());

    await expect(t.send(batch(4))).rejects.toMatchObject({
      kind: "too_large",
      maxBytes: undefined,
    });
  });

  it("lets a consumer header be added without letting it rewrite ours", async () => {
    const fetchMock = answer(204);
    const headers = { Authorization: "Bearer x", "X-UiObs-Batch-Id": "spoofed" };
    const t = new HttpTransport(config({ headers }), diagnostics());

    await t.send(batch());

    expect(headersOf(fetchMock).get("Authorization")).toBe("Bearer x");
    expect(headersOf(fetchMock).get("X-UiObs-Batch-Id")).toBe("batch-1");
  });

  it("overwrites our headers whatever case the consumer spells them in", async () => {
    // Header names ignore case. With a plain object, BOTH keys stay. fetch joins them into
    // "spoofed, batch-1". That id matches no batch on the server. Deduplication then fails with no
    // sign.
    const fetchMock = answer(204);
    const headers = { "x-uiobs-batch-id": "spoofed", "content-type": "text/csv" };
    const t = new HttpTransport(config({ headers }), diagnostics());

    await t.send(batch());

    expect(headersOf(fetchMock).get("x-uiobs-batch-id")).toBe("batch-1");
    expect(headersOf(fetchMock).get("content-type")).toBe("application/json");
  });

  it("sends the batch id so the server can deduplicate a double delivery", async () => {
    const fetchMock = answer(204);
    const t = new HttpTransport(config(), diagnostics());

    await t.send(batch());

    expect(headersOf(fetchMock).get("X-UiObs-Batch-Id")).toBe("batch-1");
    expect(headersOf(fetchMock).get("X-UiObs-Attempt")).toBe("0");
    expect(initOf(fetchMock).credentials).toBe("omit");
  });

  it("reports a timeout rather than hanging forever", async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const handler = vi.fn();
    const t = new HttpTransport(config(), new Diagnostics(handler, 0));

    const pending = t.send(batch()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const failure = await pending;

    expect(failure).toBeInstanceOf(TransportError);
    expect(failure).toMatchObject({ kind: "timeout" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "transport.timeout" }));
    vi.useRealTimers();
  });

  it("bounds a headers() that never settles by the request deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = answer(204);
    const handler = vi.fn();
    const stalled = () => new Promise<Record<string, string>>(() => undefined);
    const t = new HttpTransport(config({ headers: stalled }), new Diagnostics(handler, 0));

    const pending = t.send(batch()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

    expect(await pending).toMatchObject({ kind: "timeout" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "transport.timeout" }));
    vi.useRealTimers();
  });

  it("sends one time more with new headers after a 401, when headers is a function", async () => {
    let token = 0;
    const headers = () => ({ authorization: `Bearer t${String(++token)}` });
    const statuses = [401, 204];
    const fetchMock = stubFetch(() =>
      Promise.resolve(new Response(null, { status: statuses.shift() ?? 204 })),
    );

    await new HttpTransport(config({ headers }), diagnostics()).send(batch());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock, 1).get("authorization")).toBe("Bearer t2");
  });

  it("drops the batch after a second 403, and does not retry static headers", async () => {
    const fetchMock = answer(403);
    const headers = () => ({ authorization: "Bearer expired" });

    await expect(
      new HttpTransport(config({ headers }), diagnostics()).send(batch()),
    ).rejects.toMatchObject({ kind: "permanent", status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    await expect(
      new HttpTransport(config({ headers: { authorization: "Bearer x" } }), diagnostics()).send(
        batch(),
      ),
    ).rejects.toMatchObject({ kind: "permanent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives the last headers that it sent, for the exit flush", async () => {
    answer(204);
    let fail = false;
    const headers = () => {
      if (fail) {
        throw new Error("token refresh failed");
      }
      return { authorization: "Bearer t1" };
    };
    const dynamic = new HttpTransport(config({ headers }), diagnostics());

    expect(new HttpTransport(config(), diagnostics()).lastHeaders()).toBeUndefined();
    expect(
      new HttpTransport(config({ headers: { "x-app": "a" } }), diagnostics()).lastHeaders(),
    ).toEqual({ "x-app": "a" });
    expect(dynamic.lastHeaders()).toBeUndefined();

    await dynamic.send(batch());
    fail = true;
    await dynamic.send(batch());

    expect(dynamic.lastHeaders()).toEqual({ authorization: "Bearer t1" });
  });

  it("gives no cached headers after configure() replaces the headers function", async () => {
    // At a tenant switch, the old Authorization value must not go to the new endpoint.
    answer(204);
    const live = config({ headers: () => ({ authorization: "Bearer tenant-a" }) });
    const t = new HttpTransport(live, diagnostics());

    await t.send(batch());
    live.headers = () => ({ authorization: "Bearer tenant-b" });

    expect(t.lastHeaders()).toBeUndefined();
  });

  it("gives no cached headers after configure() changes the endpoint", async () => {
    // One headers function can give the token of each tenant. The old token is for the old endpoint.
    answer(204);
    const live = config({ headers: () => ({ authorization: "Bearer tenant-a" }) });
    const t = new HttpTransport(live, diagnostics());

    await t.send(batch());
    live.endpoint = "https://tenant-b/v1/logs";

    expect(t.lastHeaders()).toBeUndefined();
  });

  it("calls onKeepalive only for a send that uses keepalive", async () => {
    // A keepalive send continues after unload. The pipeline must not give it to the exit flush.
    answer(204);
    const t = new HttpTransport(config(), diagnostics());
    const onKeepalive = vi.fn<() => void>();

    await t.send(batch(), onKeepalive);
    expect(onKeepalive).not.toHaveBeenCalled();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await t.send(batch(), onKeepalive);
    expect(onKeepalive).toHaveBeenCalledOnce();
  });

  it("sends with keepalive while the document is hidden and the body fits the budget", async () => {
    // A mobile OS can stop a hidden page with no pagehide. A keepalive request continues.
    const fetchMock = answer(204);
    const t = new HttpTransport(config(), diagnostics());

    await t.send(batch());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await t.send(batch());
    await t.send({
      ...batch(1),
      records: [{ ...batch(1).records[0], body: "x".repeat(BEACON_LIMIT_BYTES) }],
    });

    expect(initOf(fetchMock, 0).keepalive).toBe(false);
    expect(initOf(fetchMock, 1).keepalive).toBe(true);
    expect(initOf(fetchMock, 2).keepalive).toBe(false);
  });

  it("measures a gzip body by its bytes for keepalive", async () => {
    const fetchMock = answer(204);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    await new HttpTransport(config({ compression: "gzip" }), diagnostics()).send(bigBatch());

    expect(headersOf(fetchMock).get("content-encoding")).toBe("gzip");
    expect(initOf(fetchMock).keepalive).toBe(true);
  });

  it("sends without keepalive in a realm with no document", async () => {
    const fetchMock = answer(204);
    vi.stubGlobal("document", undefined);

    await new HttpTransport(config(), diagnostics()).send(batch());

    expect(initOf(fetchMock).keepalive).toBe(false);
  });

  it("names third-party cookie blocking on a 401, because a bare 401 explains nothing", async () => {
    const handler = vi.fn();
    answer(401);
    const t = new HttpTransport(config(), new Diagnostics(handler, 0));

    await expect(t.send(batch())).rejects.toMatchObject({ kind: "permanent" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "transport.rejected_credentials" }),
    );
  });

  it("treats a 403 the same way, since it fails for the same reasons", async () => {
    const handler = vi.fn();
    answer(403);
    const t = new HttpTransport(config(), new Diagnostics(handler, 0));

    await expect(t.send(batch())).rejects.toMatchObject({ kind: "permanent", status: 403 });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "transport.rejected_credentials" }),
    );
  });

  it("separates a 503 from a 500: one is throttled, the other transient", async () => {
    answer(503);
    const throttled = new HttpTransport(config(), diagnostics());
    await expect(throttled.send(batch())).rejects.toMatchObject({ kind: "throttled" });
    // No Retry-After, so the backoff base is what holds the live path off.
    expect(throttled.throttledForMs()).toBeGreaterThan(0);

    answer(500);
    await expect(new HttpTransport(config(), diagnostics()).send(batch())).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("treats a 408 as transient, the same as a server error", async () => {
    answer(408);

    await expect(new HttpTransport(config(), diagnostics()).send(batch())).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("classifies a dropped connection as offline only when the browser says so", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    vi.stubGlobal("navigator", { onLine: false });
    await expect(new HttpTransport(config(), diagnostics()).send(batch())).rejects.toMatchObject({
      kind: "offline",
    });

    vi.stubGlobal("navigator", { onLine: true });
    await expect(new HttpTransport(config(), diagnostics()).send(batch())).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("drops a batch its serializer cannot encode, rather than retrying it forever", async () => {
    const handler = vi.fn();
    const fetchMock = answer(204);
    const broken = {
      name: "broken",
      serialize: () => {
        throw new Error("nope");
      },
    };
    const t = new HttpTransport(config({ serializer: broken }), new Diagnostics(handler, 0));

    // The send resolves. The same records fail in the same way each time. The caller cannot do
    // anything about it. A stored copy of the batch has no value.
    await expect(t.send(batch())).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "transport.serialize_failed" }),
    );
  });

  it("awaits an async headers(), and still sends when one throws", async () => {
    const fetchMock = answer(204);

    const asyncHeaders = () => Promise.resolve({ "X-Tenant": "eq" });
    await new HttpTransport(config({ headers: asyncHeaders }), diagnostics()).send(batch());
    expect(headersOf(fetchMock).get("X-Tenant")).toBe("eq");

    const handler = vi.fn();
    const brokenHeaders = () => {
      throw new Error("token refresh failed");
    };
    await new HttpTransport(config({ headers: brokenHeaders }), new Diagnostics(handler, 0)).send(
      batch(),
    );

    // A failed header resolver must not become a lost batch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalled();
  });

  it("does nothing when there is nothing to send", async () => {
    const fetchMock = answer(204);

    await new HttpTransport(config(), diagnostics()).send(batch(0));
    await new HttpTransport(config({ endpoint: "" }), diagnostics()).send(batch());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gzips a body over the threshold and labels it", async () => {
    const fetchMock = answer(204);
    const t = new HttpTransport(config({ compression: "gzip" }), diagnostics());

    await t.send(bigBatch());

    expect(headersOf(fetchMock).get("Content-Encoding")).toBe("gzip");
    expect(initOf(fetchMock).body).toBeInstanceOf(Uint8Array);
  });

  it("leaves a body under the threshold alone", async () => {
    const fetchMock = answer(204);
    const t = new HttpTransport(config({ compression: "gzip" }), diagnostics());

    await t.send(batch(1));

    expect(headersOf(fetchMock).get("Content-Encoding")).toBeNull();
    expect(typeof initOf(fetchMock).body).toBe("string");
  });

  it("sends the plain body, unlabelled, when the runtime cannot gzip", async () => {
    // The header is the dangerous part. A Content-Encoding header of gzip on a body that is not
    // gzip gives a 400. The server cannot tell the cause.
    const fetchMock = answer(204);
    vi.stubGlobal("CompressionStream", undefined);
    const t = new HttpTransport(config({ compression: "gzip" }), diagnostics());

    await t.send(bigBatch());

    expect(headersOf(fetchMock).get("Content-Encoding")).toBeNull();
    expect(typeof initOf(fetchMock).body).toBe("string");
  });

  it("sends the plain body when compressing throws, and reports it", async () => {
    const handler = vi.fn();
    const fetchMock = answer(204);
    vi.stubGlobal("CompressionStream", function Exploding() {
      throw new Error("compression is broken here");
    });
    const t = new HttpTransport(config({ compression: "gzip" }), new Diagnostics(handler, 0));

    await t.send(bigBatch());

    expect(headersOf(fetchMock).get("Content-Encoding")).toBeNull();
    expect(typeof initOf(fetchMock).body).toBe("string");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "transport.http_error" }));
  });
});

describe("gzip", () => {
  it("produces a real gzip stream", async () => {
    const out = await gzip("x".repeat(4096));

    expect(out).toBeInstanceOf(Uint8Array);
    expect(out!.length).toBeLessThan(4096);
    // gzip magic number.
    expect([out![0], out![1]]).toEqual([0x1f, 0x8b]);
  });

  it("returns null rather than a broken body when CompressionStream is missing", async () => {
    vi.stubGlobal("CompressionStream", undefined);

    expect(await gzip("hello")).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("accepts delta seconds", () => {
    expect(parseRetryAfter("7")).toBe(7000);
  });

  it("accepts an HTTP date, which is equally legal and easy to forget", () => {
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  });

  it("never returns a negative delay for a date already in the past", () => {
    expect(parseRetryAfter(new Date(Date.now() - 5000).toUTCString())).toBe(0);
  });

  it("is undefined for a missing or unparseable header", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

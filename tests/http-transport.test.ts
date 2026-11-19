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
import type { LossReporter } from "../src/models/drop";
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
 * The tests below use a `count` of 0. An empty batch must do nothing and send no request.
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

/** The body defaults to null. 204 is a null-body status, and a Response with both throws. */
const answer = (status: number, body: string | null = null, headers: Record<string, string> = {}) =>
  stubFetch(() => Promise.resolve(new Response(body, { status, headers })));

/** The request init of one call, which is where the headers and the body live. */
const initOf = (fetchMock: any, index = 0): RequestInit => fetchMock.mock.calls[index][1];

const headersOf = (fetchMock: any, index = 0): Headers =>
  initOf(fetchMock, index).headers as Headers;

describe("HttpTransport", () => {
  it("returns the clock offset from a 2xx answer with a valid Date header", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T10:00:00.000Z"));
    const onClock = vi.fn();
    const send = (date?: string) => {
      answer(204, null, date === undefined ? {} : { Date: date });
      return new HttpTransport(config(), diagnostics(), undefined, undefined, onClock).send(
        batch(),
      );
    };

    await send("Sun, 01 Nov 2026 10:00:05 GMT");
    await send();
    await send("not a date");

    // The header has whole seconds, so the offset adds half a second.
    expect(onClock.mock.calls).toEqual([[5500]]);
  });

  it("accepts a batch with a Date header when it has no clock callback", async () => {
    answer(204, null, { Date: "Sun, 01 Nov 2026 10:00:05 GMT" });

    await expect(new HttpTransport(config(), diagnostics()).send(batch())).resolves.toBe(0);
  });

  it("passes the sampling header from a 2xx answer to the sampling callback", async () => {
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

    await expect(t.send(batch())).resolves.toBe(0);
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
    expect(t.throttledForMs(batch())).toBeGreaterThan(6000);
  });

  it("caps Retry-After at RETRY_MAX_DELAY_MS", async () => {
    answer(429, null, { "Retry-After": "86400" });
    const t = new HttpTransport(config(), diagnostics());

    await expect(t.send(batch())).rejects.toMatchObject({
      kind: "throttled",
      retryAfterMs: RETRY_MAX_DELAY_MS,
    });
    expect(t.throttledForMs(batch())).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  it("throttles only the endpoint that answered 429", async () => {
    // A 429 from metricsEndpoint must not hold back the log batches.
    const t = new HttpTransport(config({ metricsEndpoint: "https://x/v1/metrics" }), diagnostics());
    const metrics = batch(1);
    metrics.records[0].attributes = { "log.type": "metric", "metric.value": 1 };

    answer(429, null, { "Retry-After": "7" });
    await expect(t.send(metrics)).rejects.toMatchObject({ kind: "throttled" });
    expect(t.throttledForMs(batch())).toBe(0);

    // An accepted log batch must not end the throttle on metricsEndpoint.
    answer(204);
    await t.send(batch());
    expect(t.throttledForMs(metrics)).toBeGreaterThan(6000);
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

  it("splits on a 413 with no body and reports the missing limit", async () => {
    answer(413);
    const handler = vi.fn();
    const t = new HttpTransport(config(), new Diagnostics(handler, 0));

    await expect(t.send(batch(4))).rejects.toMatchObject({
      kind: "too_large",
      maxBytes: undefined,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "transport.http_error",
        message: "The library could not read the body of the 413 response.",
      }),
    );
  });

  it.each(['{"maxBytes":0}', '{"maxBytes":-1}', '{"maxBytes":1.5}', '{"maxBytes":1e999}', "null"])(
    "ignores a 413 maxBytes that isn't a positive whole number: %s",
    async (body) => {
      answer(413, body);
      const t = new HttpTransport(config(), diagnostics());

      await expect(t.send(batch(4))).rejects.toMatchObject({
        kind: "too_large",
        maxBytes: undefined,
      });
    },
  );

  describe("a response body that doesn't arrive in time or breaks", () => {
    /** Resolves with "pending" when the send hasn't settled within a few event loop turns. */
    const outcomeOf = (send: Promise<number>): Promise<unknown> =>
      Promise.race([
        send.then(
          () => "sent",
          (error: unknown) => error,
        ),
        new Promise((resolve) => {
          setTimeout(() => {
            resolve("pending");
          }, 50);
        }),
      ]);

    /** An answer whose headers arrive and whose body then never sends a byte. */
    const stalled = (status = 413) =>
      new Response(new ReadableStream<Uint8Array>(), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    /** An answer whose body stream fails after the headers. */
    const broken = (status: number) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError("connection reset"));
          },
        }),
        { status, headers: { "Content-Type": "application/json" } },
      );

    /** Sends one batch with fake timers and returns how it settled after the deadline. */
    const settleAfterDeadline = async (t: HttpTransport): Promise<unknown> => {
      vi.useFakeTimers();
      let outcome: unknown = "pending";
      t.send(batch()).then(
        () => {
          outcome = "sent";
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 20);
      vi.useRealTimers();
      return outcome;
    };

    const bodyFailure = expect.objectContaining({
      code: "transport.http_error",
      message: "The library could not read the response body. It uses the status code alone.",
    });

    it("splits on a 413 whose body stalls past the deadline, without the size hint", async () => {
      stubFetch(() => Promise.resolve(stalled()));
      const handler = vi.fn();
      const t = new HttpTransport(config(), new Diagnostics(handler, 0));

      expect(await settleAfterDeadline(t)).toMatchObject({
        kind: "too_large",
        maxBytes: undefined,
      });
      expect(handler).toHaveBeenCalledWith(bodyFailure);
    });

    it("accepts a 2xx whose OTLP body stalls past the deadline, so it isn't sent again", async () => {
      stubFetch(() => Promise.resolve(stalled(200)));
      const onLoss = vi.fn<LossReporter>();
      const handler = vi.fn();
      const t = new HttpTransport(config(), new Diagnostics(handler, 0), undefined, onLoss);

      expect(await settleAfterDeadline(t)).toBe("sent");
      expect(t.lastSendAt()).not.toBeNull();
      expect(onLoss).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(bodyFailure);
    });

    it.each([
      [200, "sent"],
      [413, expect.objectContaining({ kind: "too_large", maxBytes: undefined })],
    ])("keeps the %s status when the body stream fails", async (status, expected) => {
      stubFetch(() => Promise.resolve(broken(status)));
      const handler = vi.fn();
      const t = new HttpTransport(config(), new Diagnostics(handler, 0));

      expect(await outcomeOf(t.send(batch()))).toEqual(expected);
      expect(handler).toHaveBeenCalledWith(bodyFailure);
    });

    it("splits on a 413 that a fetch ignoring its signal gives after the deadline", async () => {
      stubFetch(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(stalled());
            }, REQUEST_TIMEOUT_MS + 10);
          }),
      );
      const t = new HttpTransport(config(), diagnostics());

      expect(await settleAfterDeadline(t)).toMatchObject({ kind: "too_large" });
    });

    it("retires the send when the transport stops during the body read", async () => {
      const fetchMock = stubFetch(() => Promise.resolve(stalled()));
      const t = new HttpTransport(config(), diagnostics());

      const send = t.send(batch());
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      t.stop();

      expect(await outcomeOf(send)).toMatchObject({ kind: "permanent" });
    });

    it("stops reading after 16 KiB and cancels the rest of the body", async () => {
      const cancel = vi.fn();
      const json = new TextEncoder().encode(
        JSON.stringify({ maxBytes: 100, pad: "x".repeat(64 * 1024) }),
      );
      let at = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= json.length) {
            controller.close();
            return;
          }
          controller.enqueue(json.slice(at, at + 1024));
          at += 1024;
        },
        cancel,
      });
      stubFetch(() => Promise.resolve(new Response(body, { status: 413 })));
      const t = new HttpTransport(config(), diagnostics());

      expect(await outcomeOf(t.send(batch()))).toMatchObject({
        kind: "too_large",
        maxBytes: undefined,
      });
      expect(cancel).toHaveBeenCalled();
      expect(at).toBeLessThan(json.length);
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
    // Header names ignore case. With a plain object, BOTH keys stay, and fetch joins them into
    // "spoofed, batch-1". That id matches no batch on the server, so deduplication silently fails.
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

  it("sends once more with new headers after a 401, when headers is a function", async () => {
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

  it("returns the last headers it sent, for the exit flush", async () => {
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

  it("sends a batch of metric records to metricsEndpoint in the OTLP metrics format", async () => {
    const fetchMock = answer(204);
    const live = config({ metricsEndpoint: "https://x/v1/metrics" });
    const sent = batch(1);
    sent.records[0].attributes = { "log.type": "metric", "metric.value": 1 };

    await new HttpTransport(live, diagnostics()).send(sent);
    await new HttpTransport(live, diagnostics()).send(batch(1));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://x/v1/metrics",
      "https://x/v1/logs",
    ]);
    // compression: "none" keeps the body as text.
    const body = initOf(fetchMock).body as string;
    expect(Object.keys(JSON.parse(body))).toEqual(["resourceMetrics"]);
  });

  it("keeps the cached headers after a send to metricsEndpoint", async () => {
    // The headers apply to both endpoints, and the exit flush must not lose them.
    answer(204);
    const live = config({
      metricsEndpoint: "https://x/v1/metrics",
      headers: () => ({ authorization: "Bearer t1" }),
    });
    const t = new HttpTransport(live, diagnostics());
    const sent = batch(1);
    sent.records[0].attributes = { "log.type": "metric", "metric.value": 1 };

    await t.send(sent);

    expect(t.lastHeaders()).toEqual({ authorization: "Bearer t1" });
  });

  it("returns no cached headers after a send to metricsEndpoint and a new endpoint", async () => {
    // The exit flush must not send tenant A's token to tenant B's endpoint.
    answer(204);
    const live = config({
      metricsEndpoint: "https://x/v1/metrics",
      headers: () => ({ authorization: "Bearer tenant-a" }),
    });
    const t = new HttpTransport(live, diagnostics());
    const sent = batch(1);
    sent.records[0].attributes = { "log.type": "metric", "metric.value": 1 };

    await t.send(sent);
    live.endpoint = "https://tenant-b/v1/logs";

    expect(t.lastHeaders()).toBeUndefined();
  });

  it("returns no cached headers after a log send and a new metricsEndpoint", async () => {
    answer(204);
    const live = config({
      metricsEndpoint: "https://x/v1/metrics",
      headers: () => ({ authorization: "Bearer tenant-a" }),
    });
    const t = new HttpTransport(live, diagnostics());

    await t.send(batch());
    live.metricsEndpoint = "https://tenant-b/v1/metrics";

    expect(t.lastHeaders()).toBeUndefined();
  });

  it("sends a batch of span records to tracesEndpoint, and nowhere without it", async () => {
    const fetchMock = answer(204);
    const live = config({
      tracesEndpoint: "https://x/v1/traces",
      headers: () => ({ authorization: "Bearer tenant-a" }),
    });
    const reporter = diagnostics();
    const t = new HttpTransport(live, reporter);
    const sent = batch(1);
    sent.records[0].attributes = { "log.type": "span" };

    await t.send(sent);
    expect(t.lastHeaders()).toEqual({ authorization: "Bearer tenant-a" });

    live.tracesEndpoint = "https://tenant-b/v1/traces";
    expect(t.lastHeaders()).toBeUndefined();

    live.tracesEndpoint = "";
    await t.send(sent);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://x/v1/traces"]);
    expect(Object.keys(JSON.parse(initOf(fetchMock).body as string))).toEqual(["resourceSpans"]);
    expect(reporter.snapshot()["record.dropped_no_destination"]).toBe(1);
  });

  it("returns no cached headers when configure() changes the endpoint during headers()", async () => {
    // headers() can return the old tenant's token after the switch.
    answer(204);
    const live = config({});
    live.headers = () => {
      live.endpoint = "https://tenant-b/v1/logs";
      return { authorization: "Bearer tenant-a" };
    };
    const t = new HttpTransport(live, diagnostics());

    await t.send(batch());

    expect(t.lastHeaders()).toBeUndefined();
  });

  it("returns no cached headers after configure() replaces the headers function", async () => {
    // At a tenant switch, the old Authorization value must not go to the new endpoint.
    answer(204);
    const live = config({ headers: () => ({ authorization: "Bearer tenant-a" }) });
    const t = new HttpTransport(live, diagnostics());

    await t.send(batch());
    live.headers = () => ({ authorization: "Bearer tenant-b" });

    expect(t.lastHeaders()).toBeUndefined();
  });

  it("returns no cached headers after configure() changes the endpoint", async () => {
    // One headers function can return every tenant's token. The old token is for the old endpoint.
    answer(204);
    const live = config({ headers: () => ({ authorization: "Bearer tenant-a" }) });
    const t = new HttpTransport(live, diagnostics());

    await t.send(batch());
    live.endpoint = "https://tenant-b/v1/logs";

    expect(t.lastHeaders()).toBeUndefined();
  });

  it("calls onKeepalive only for a send that uses keepalive", async () => {
    // A keepalive send continues after unload, so the pipeline must not hand it to the exit flush.
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
    // A mobile OS can stop a hidden page with no pagehide, but a keepalive request continues.
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

  it("sends with the configured fetch priority, and a hidden keepalive send with auto", async () => {
    const fetchMock = answer(204);

    await new HttpTransport(config(), diagnostics()).send(batch());
    await new HttpTransport(config({ delivery: { priority: "high" } }), diagnostics()).send(
      batch(),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await new HttpTransport(config(), diagnostics()).send(batch());

    expect(initOf(fetchMock, 0).priority).toBe("low");
    expect(initOf(fetchMock, 1).priority).toBe("high");
    expect(initOf(fetchMock, 2).priority).toBe("auto");
  });

  it("measures a gzip body by its bytes for keepalive", async () => {
    const fetchMock = answer(204);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    await new HttpTransport(config({ compression: "gzip" }), diagnostics()).send(bigBatch());

    expect(headersOf(fetchMock).get("content-encoding")).toBe("gzip");
    expect(initOf(fetchMock).keepalive).toBe(true);
  });

  it("counts the bytes of its keepalive requests until each one settles", async () => {
    // The exit flush sends against the same browser budget, so it reads the bytes in flight.
    const settle: ((response: Response) => void)[] = [];
    const fetchMock = stubFetch(() => new Promise<Response>((resolve) => settle.push(resolve)));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const t = new HttpTransport(config(), diagnostics());
    expect(t.keepaliveInFlight()).toBe(0);

    const sends = [t.send(batch()), t.send(batch())];
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const bytes = (initOf(fetchMock).body as string).length;
    expect(t.keepaliveInFlight()).toBe(2 * bytes);

    settle[0](new Response(null, { status: 204 }));
    await sends[0];
    expect(t.keepaliveInFlight()).toBe(bytes);

    settle[1](new Response(null, { status: 204 }));
    await sends[1];
    expect(t.keepaliveInFlight()).toBe(0);
  });

  it("frees the bytes of a keepalive request that fails", async () => {
    // A count that only a 2xx lowers would grow with every failure and park every exit batch.
    let fail: (error: Error) => void = () => undefined;
    const fetchMock = stubFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const t = new HttpTransport(config(), diagnostics());

    const send = t.send(batch());
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(t.keepaliveInFlight()).toBeGreaterThan(0);

    fail(new TypeError("Failed to fetch"));
    await expect(send).rejects.toBeInstanceOf(TransportError);
    expect(t.keepaliveInFlight()).toBe(0);
  });

  it("counts no bytes for a request without keepalive", async () => {
    // The browser cancels a plain fetch at page close, so it never uses the keepalive budget.
    let settle: (response: Response) => void = () => undefined;
    const fetchMock = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    const t = new HttpTransport(config(), diagnostics());

    const send = t.send(batch());
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(t.keepaliveInFlight()).toBe(0);

    settle(new Response(null, { status: 204 }));
    await send;
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

  it("names metricsEndpoint in the report of a refused metrics batch", async () => {
    const handler = vi.fn();
    answer(401);
    const live = config({ metricsEndpoint: "https://x/v1/metrics" });
    const t = new HttpTransport(live, new Diagnostics(handler, 0));
    const sent = batch(1);
    sent.records[0].attributes = { "log.type": "metric", "metric.value": 1 };

    await expect(t.send(sent)).rejects.toMatchObject({ kind: "permanent" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "transport.rejected_credentials",
        detail: expect.objectContaining({ endpoint: "https://x/v1/metrics" }),
      }),
    );
  });

  it("names metricsEndpoint in the timeout report of a metrics batch", async () => {
    vi.useFakeTimers();
    answer(204);
    const handler = vi.fn();
    const stalled = () => new Promise<Record<string, string>>(() => undefined);
    const live = config({ metricsEndpoint: "https://x/v1/metrics", headers: stalled });
    const t = new HttpTransport(live, new Diagnostics(handler, 0));
    const sent = batch(1);
    sent.records[0].attributes = { "log.type": "metric", "metric.value": 1 };

    const pending = t.send(sent).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

    expect(await pending).toMatchObject({ kind: "timeout" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "transport.timeout",
        detail: { endpoint: "https://x/v1/metrics" },
      }),
    );
    vi.useRealTimers();
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
    expect(throttled.throttledForMs(batch())).toBeGreaterThan(0);

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

    // The send resolves with both records lost. The same records would fail the same way every
    // time, the caller can't do anything about it, and a stored copy of the batch has no value.
    await expect(t.send(batch())).resolves.toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "transport.serialize_failed" }),
    );
  });

  it("passes a batch its serializer cannot encode to onLoss", async () => {
    answer(204);
    const onLoss = vi.fn<LossReporter>();
    const broken = {
      name: "broken",
      serialize: () => {
        throw new Error("nope");
      },
    };
    const t = new HttpTransport(config({ serializer: broken }), diagnostics(), undefined, onLoss);

    await t.send(batch(1));

    expect(onLoss).toHaveBeenCalledWith(
      "unserializable",
      [expect.objectContaining({ body: "r0" })],
      ["batch-1"],
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
    // The header is the dangerous part. Content-Encoding: gzip on a body that is not gzip gives a
    // 400, and the server can't tell the cause.
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

describe("HttpTransport with an OTLP partialSuccess answer", () => {
  const JSON_TYPE = { "Content-Type": "application/json" };

  /** Four records of one log.type, so the batch goes to that signal's endpoint. */
  const batchOf = (type: string): LogBatch => {
    const plain = batch(4);
    return {
      ...plain,
      records: plain.records.map((record) => ({ ...record, attributes: { "log.type": type } })),
    };
  };

  /** A transport that collects its losses and its diagnostic events. */
  const setupPartial = (over: Partial<ObservabilityConfig> = {}) => {
    const onLoss = vi.fn<LossReporter>();
    const handler = vi.fn();
    const transport = new HttpTransport(
      config(over),
      new Diagnostics(handler, 0),
      undefined,
      onLoss,
    );
    const codes = (): string[] => handler.mock.calls.map(([event]) => event.code as string);
    return { transport, onLoss, handler, codes };
  };

  it.each([
    ["log records", "rejectedLogRecords", "log", {}],
    ["data points", "rejectedDataPoints", "metric", { metricsEndpoint: "https://x/v1/metrics" }],
    ["spans", "rejectedSpans", "span", { tracesEndpoint: "https://x/v1/traces" }],
  ] as const)(
    "reports the %s the server rejected and doesn't send the batch again",
    async (_signal, field, type, over) => {
      answer(
        200,
        JSON.stringify({ partialSuccess: { [field]: "2", errorMessage: "attribute too long" } }),
        JSON_TYPE,
      );
      const { transport, onLoss, handler } = setupPartial(over);

      await transport.send(batchOf(type));

      expect(onLoss).toHaveBeenCalledExactlyOnceWith("partially_rejected", [], ["batch-1"], 2);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "transport.partial_success",
          message:
            "The server rejected 2 of 4 records in the batch. The library does not send them again.",
          detail: expect.objectContaining({ rejected: 2, serverMessage: "attribute too long" }),
        }),
      );
      expect(transport.lastSendAt()).not.toBeNull();
    },
  );

  it("reads a rejected count that JSON gives as a number", async () => {
    answer(200, JSON.stringify({ partialSuccess: { rejectedLogRecords: 1 } }), JSON_TYPE);
    const { transport, onLoss } = setupPartial();

    await transport.send(batchOf("log"));

    expect(onLoss).toHaveBeenCalledExactlyOnceWith("partially_rejected", [], ["batch-1"], 1);
  });

  it("caps the rejected count at the number of records in the batch", async () => {
    answer(200, JSON.stringify({ partialSuccess: { rejectedLogRecords: "999" } }), JSON_TYPE);
    const { transport, onLoss } = setupPartial();

    await transport.send(batchOf("log"));

    expect(onLoss).toHaveBeenCalledExactlyOnceWith("partially_rejected", [], ["batch-1"], 4);
  });

  it("reports a warning and no loss when the server rejected nothing", async () => {
    answer(
      200,
      JSON.stringify({ partialSuccess: { rejectedLogRecords: "0", errorMessage: "deprecated" } }),
      JSON_TYPE,
    );
    const { transport, onLoss, handler } = setupPartial();

    await transport.send(batchOf("log"));

    expect(onLoss).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "transport.partial_success",
        message: "The server accepted the batch with a warning.",
        detail: expect.objectContaining({ serverMessage: "deprecated" }),
      }),
    );
  });

  it("cuts a long server message, because the server controls its text", async () => {
    answer(
      200,
      JSON.stringify({
        partialSuccess: { rejectedLogRecords: "1", errorMessage: "x".repeat(10_000) },
      }),
      JSON_TYPE,
    );
    const { transport, handler } = setupPartial();

    await transport.send(batchOf("log"));

    const event = handler.mock.calls.find(([e]) => e.code === "transport.partial_success")?.[0];
    expect(String(event.detail.serverMessage).length).toBeLessThan(300);
  });

  it.each([
    ["an empty JSON body", 200, "", JSON_TYPE],
    ["a text body", 200, "OK", { "Content-Type": "text/plain" }],
    ["no body", 204, null, {}],
    ["a JSON null", 200, "null", JSON_TYPE],
    ["no partialSuccess", 200, "{}", JSON_TYPE],
    ["an empty partialSuccess", 200, '{"partialSuccess":{}}', JSON_TYPE],
    ["a negative count", 200, '{"partialSuccess":{"rejectedLogRecords":"-3"}}', JSON_TYPE],
    ["a fractional count", 200, '{"partialSuccess":{"rejectedLogRecords":1.5}}', JSON_TYPE],
  ] as const)("keeps %s as a plain success", async (_name, status, body, headers) => {
    answer(status, body, headers);
    const { transport, onLoss, codes } = setupPartial();

    await transport.send(batchOf("log"));

    expect(onLoss).not.toHaveBeenCalled();
    expect(codes()).toEqual([]);
  });

  it("doesn't read the answer of an ECS batch, which isn't OTLP", async () => {
    answer(200, '{"partialSuccess":{"rejectedLogRecords":"2"}}', JSON_TYPE);
    const { transport, onLoss, codes } = setupPartial({ serializer: "ecs" });

    await transport.send(batchOf("log"));

    expect(onLoss).not.toHaveBeenCalled();
    expect(codes()).toEqual([]);
  });

  it("reports a JSON answer that doesn't parse and keeps the batch accepted", async () => {
    answer(200, "{bad", JSON_TYPE);
    const { transport, onLoss, handler } = setupPartial();

    await transport.send(batchOf("log"));

    expect(onLoss).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "transport.http_error",
        message: "The library could not read the body of the 2xx response.",
      }),
    );
  });
});

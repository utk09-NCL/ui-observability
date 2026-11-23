import { afterEach, describe, expect, it, vi } from "vitest";
import { EMERGENCY_STORAGE_KEY_PREFIX } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { ExitTransport, ObservabilityConfig } from "../src/models/config";
import type { LossReporter } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { ExitFlush } from "../src/transport/exit-flush";
import { isLibraryRequest } from "../src/utils/library-request";

const ENDPOINT = "https://x/v1/logs";
const METRICS_ENDPOINT = "https://x/v1/metrics";

const record = (body: string): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes: {},
  resource: { "service.name": "svc" },
});

/** A span record. */
const spanRecord = (): LogRecord => ({
  ...record("ui.start"),
  attributes: { "log.type": "span", "span.kind": "internal", "span.parent_id": "" },
});

/** An aggregated counter point record. */
const pointRecord = (): LogRecord => ({
  ...record("orders"),
  attributes: { "log.type": "metric", "metric.type": "counter", "metric.value": 1 },
});

/**
 * Listeners outlive a test, because happy-dom gives the whole file one window. Without this, a
 * failed assertion leaves an instance that flushes on the next test's pagehide. `uninstall` is
 * idempotent, so a test can still call it.
 */
const built: ExitFlush[] = [];

afterEach(() => {
  for (const flush of built.splice(0)) {
    flush.uninstall();
  }
});

interface Options {
  records?: LogRecord[];
  config?: Partial<ObservabilityConfig>;
  /** Replaces the default drain, for the shapes a real pipeline cannot produce. */
  drain?: () => LogBatch | null;
  /** Replaces the drain with one that returns several batches, one per kind. */
  batches?: () => LogBatch[];
  /** The headers the HTTP transport resolved last. */
  headers?: Record<string, string>;
  /** The bytes of the HTTP transport's keepalive sends that are still in flight. */
  inFlight?: () => number;
  /** Replaces the pipeline's normal flush. */
  alive?: () => void | Promise<void>;
  /** Receives the records the exit flush loses. */
  onLoss?: LossReporter;
  /** Sends the points of the open metric interval. */
  beforeExit?: () => void;
}

/**
 * The default drain empties a real array, the way the pipeline does. A drain that returns null on
 * the second call would also pass the "sends once" test without testing the code that stops the
 * double send.
 */
function setup({
  records = [],
  config = {},
  drain,
  batches,
  headers,
  inFlight,
  alive,
  onLoss,
  beforeExit,
}: Options = {}) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);

  const resolved = resolveConfig(
    { endpoint: ENDPOINT, serviceName: "svc", ...config },
    diagnostics,
  );
  const pending = [...records];
  let drains = 0;

  const take = (): LogBatch | null =>
    pending.length === 0
      ? null
      : {
          id: `b${String(++drains)}`,
          createdAt: Date.now(),
          attempts: 0,
          records: pending.splice(0),
        };

  // The exit flush takes one batch per kind. These tests give one batch or none.
  const drainForExit = vi.fn<() => LogBatch[]>(
    batches ??
      (() => {
        const batch = (drain ?? take)();
        return batch ? [batch] : [];
      }),
  );
  const flushAlive = vi.fn<() => void | Promise<void>>(alive ?? (() => undefined));

  const flush = new ExitFlush({
    config: resolved,
    diagnostics,
    drainForExit,
    flushAlive,
    exitHeaders: () => headers,
    keepaliveInFlight: () => inFlight?.(),
    onLoss,
    beforeExit,
  });

  built.push(flush);
  return {
    flush,
    pending,
    events,
    diagnostics,
    drainForExit,
    flushAlive,
    config: resolved,
    codes: () => events.map((event) => event.code),
  };
}

const stubBeacon = (impl: (url: string, data: Blob) => boolean = () => true) => {
  const beacon = vi.fn(impl);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  return beacon;
};

/** The body defaults to null. 204 is a null-body status, and a Response with both throws. */
const stubFetch = (
  impl: (url: string, init: RequestInit) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 204 })),
) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/** An OpenFin runtime with only the listener API this module touches. */
const stubFin = (me: unknown) => {
  vi.stubGlobal("fin", { me });
};

/**
 * Reads the items by index, because happy-dom's Storage is a Proxy that doesn't enumerate them.
 */
const emergencyKeys = () => {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(EMERGENCY_STORAGE_KEY_PREFIX)) {
      keys.push(key);
    }
  }
  return keys;
};

describe("ExitFlush install", () => {
  it("runs a normal flush, not an exit send, when the document becomes hidden", () => {
    // The document keeps running, so a normal flush keeps the headers, gzip and the retry.
    const fetchMock = stubFetch();
    const { flush, flushAlive, drainForExit } = setup({ records: [record("bye")] });
    flush.install();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushAlive).toHaveBeenCalledOnce();
    expect(drainForExit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    flush.uninstall();
  });

  it("ignores a visibilitychange back to visible", () => {
    const fetchMock = stubFetch();
    const { flush } = setup({ records: [record("stay")] });
    flush.install();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(fetchMock).not.toHaveBeenCalled();
    flush.uninstall();
  });

  it("flushes on pagehide, which fires at the window", () => {
    const fetchMock = stubFetch();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();

    dispatchEvent(new Event("pagehide"));

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("pagehide");
    flush.uninstall();
  });

  it("flushes on freeze, which fires at the document and does not bubble", () => {
    const fetchMock = stubFetch();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();

    document.dispatchEvent(new Event("freeze"));

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("freeze");
    flush.uninstall();
  });

  it("binds once, however often install is called", () => {
    const add = vi.spyOn(globalThis, "addEventListener");
    const { flush } = setup();

    flush.install();
    flush.install();

    // pageshow tells the exit flush that a page back from the cache has come back.
    expect(add.mock.calls.map(([type]) => type)).toEqual(["pagehide", "pageshow"]);
    flush.uninstall();
  });

  it("binds nothing in a host without addEventListener", () => {
    vi.stubGlobal("addEventListener", undefined);
    const remove = vi.spyOn(globalThis, "removeEventListener");
    const { flush } = setup();

    flush.install();
    flush.uninstall();

    expect(remove).not.toHaveBeenCalled();
  });

  it("binds only the window listener in a host without a document", () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("document", undefined);
    const { flush } = setup({ records: [record("bye")] });

    flush.install();
    dispatchEvent(new Event("pagehide"));
    flush.uninstall();

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("ExitFlush uninstall", () => {
  it("stops flushing on every signal", () => {
    const fetchMock = stubFetch();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();
    flush.uninstall();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("freeze"));
    dispatchEvent(new Event("pagehide"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when it was never installed", () => {
    const remove = vi.spyOn(globalThis, "removeEventListener");
    const { flush } = setup();

    flush.uninstall();

    expect(remove).not.toHaveBeenCalled();
  });
});

describe("ExitFlush on OpenFin", () => {
  it("flushes when the runtime asks to close a window", () => {
    const fetchMock = stubFetch();
    const listeners = new Map<string, () => void>();
    stubFin({
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: () => undefined,
    });

    const { flush } = setup({ records: [record("bye")] });
    flush.install();
    listeners.get("close-requested")?.();

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe(
      "openfin-close",
    );
    flush.uninstall();
  });

  it("releases the close-requested listener on uninstall", () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    stubFin({ on, removeListener });

    const { flush } = setup();
    flush.install();
    flush.uninstall();

    expect(removeListener).toHaveBeenCalledWith("close-requested", on.mock.calls[0][1]);
  });

  it("tolerates a runtime that exposes no listener API", () => {
    const { flush, codes } = setup();
    stubFin({});

    flush.install();
    flush.uninstall();

    expect(codes()).not.toContain("openfin.unavailable");
  });

  it("reports a runtime whose subscription throws, and installs anyway", () => {
    const fetchMock = stubFetch();
    stubFin({
      on: () => {
        throw new Error("runtime is gone");
      },
    });

    const { flush, codes } = setup({ records: [record("bye")] });
    flush.install();
    dispatchEvent(new Event("pagehide"));

    expect(codes()).toContain("openfin.unavailable");
    expect(fetchMock).toHaveBeenCalledOnce();
    flush.uninstall();
  });
});

describe("ExitFlush flush", () => {
  it("leaves the in-flight batches alone when the tab is only hidden", () => {
    stubFetch();
    const { flush, drainForExit, flushAlive } = setup({ records: [record("bye")] });

    // hidden fires on every tab switch and every minimize. The document keeps running and its
    // in-flight sends still complete. Taking them here would send the same records twice, and
    // the server can't find the copy because the id is new.
    flush.flush("hidden");

    expect(flushAlive).toHaveBeenCalledOnce();
    expect(drainForExit).not.toHaveBeenCalled();
  });

  it("reports a normal flush that rejects or throws", async () => {
    const rejected = setup({ alive: () => Promise.reject(new Error("store failed")) });
    const thrown = setup({
      alive: () => {
        throw new Error("pipeline gone");
      },
    });

    rejected.flush.flush("hidden");
    thrown.flush.flush("hidden");

    expect(thrown.codes()).toEqual(["pipeline.crashed"]);
    await vi.waitFor(() => {
      expect(rejected.codes()).toEqual(["pipeline.crashed"]);
    });
  });

  it("takes the in-flight batches when the document is closing", () => {
    stubFetch();
    const { flush, drainForExit, flushAlive } = setup({ records: [record("bye")] });

    flush.flush("pagehide");

    expect(drainForExit).toHaveBeenCalledOnce();
    expect(flushAlive).not.toHaveBeenCalled();
  });

  it("sends nothing when there is no endpoint to send to", () => {
    const fetchMock = stubFetch();

    setup({ records: [record("bye")], config: { endpoint: "" } }).flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an endpoint that is not a URL, and keeps the buffer", () => {
    const fetchMock = stubFetch();
    const { flush, pending, events, config } = setup({ records: [record("bye")] });
    // resolveConfig() refuses such a value, so set it on the resolved config the way a bug would.
    config.endpoint = "http://[::1";

    flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    expect(events.some((event) => event.message.includes("The exit flush cannot use"))).toBe(true);
  });

  it("sends nothing when the drain hands back an empty batch", () => {
    const fetchMock = stubFetch();
    const { flush } = setup({
      drain: () => ({ id: "b1", createdAt: Date.now(), attempts: 0, records: [] }),
    });

    flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a serializer that throws, and drops the batch", () => {
    const fetchMock = stubFetch();
    const { flush, codes } = setup({
      records: [record("bye")],
      config: {
        serializer: {
          name: "broken",
          serialize: () => {
            throw new Error("cannot encode");
          },
        },
      },
    });

    flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(codes()).toContain("transport.serialize_failed");
  });

  it("passes the batch its serializer cannot encode to onLoss", () => {
    stubFetch();
    const onLoss = vi.fn<LossReporter>();
    const { flush } = setup({
      records: [record("bye")],
      onLoss,
      config: {
        serializer: {
          name: "broken",
          serialize: () => {
            throw new Error("cannot encode");
          },
        },
      },
    });

    flush.flush("pagehide");

    expect(onLoss).toHaveBeenCalledWith(
      "unserializable",
      [expect.objectContaining({ body: "bye" })],
      ["b1"],
    );
  });

  it("sends a batch of metric records to metricsEndpoint and the other batch to endpoint", () => {
    const fetchMock = stubFetch();
    const { flush } = setup({
      config: { metricsEndpoint: METRICS_ENDPOINT },
      batches: () => [
        { id: "m1", createdAt: Date.now(), attempts: 0, records: [pointRecord()] },
        { id: "l1", createdAt: Date.now(), attempts: 0, records: [record("bye")] },
      ],
    });

    flush.flush("pagehide");

    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.pathname)).toEqual(["/v1/metrics", "/v1/logs"]);
    expect(urls.map((url) => url.searchParams.get("uiobs_batch_id"))).toEqual(["m1", "l1"]);
  });

  it("sends a batch of span records to tracesEndpoint, and drops it without tracesEndpoint", () => {
    const fetchMock = stubFetch();
    const batches = () => [
      { id: "t1", createdAt: Date.now(), attempts: 0, records: [spanRecord()] },
      { id: "l1", createdAt: Date.now(), attempts: 0, records: [record("bye")] },
    ];
    const withTraces = setup({ config: { tracesEndpoint: "https://x/v1/traces" }, batches });
    const without = setup({ batches });

    withTraces.flush.flush("pagehide");
    without.flush.flush("pagehide");

    const paths = fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
    expect(paths).toEqual(["/v1/traces", "/v1/logs", "/v1/logs"]);
    expect(without.diagnostics.snapshot()["record.dropped_no_destination"]).toBe(1);
  });

  it("sends the points of the open metric interval before the drain", () => {
    stubFetch();
    const beforeExit = vi.fn();
    const { flush, drainForExit } = setup({ records: [record("bye")], beforeExit });

    flush.flush("pagehide");

    expect(beforeExit).toHaveBeenCalledOnce();
    expect(beforeExit.mock.invocationCallOrder[0]).toBeLessThan(
      drainForExit.mock.invocationCallOrder[0],
    );
  });

  it("reports a metric collection that throws, and still sends the batch", () => {
    const fetchMock = stubFetch();
    const { flush, codes } = setup({
      records: [record("bye")],
      beforeExit: () => {
        throw new Error("collect failed");
      },
    });

    flush.flush("pagehide");

    expect(codes()).toContain("pipeline.crashed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("writes nothing to the device with storage memory, and reports the loss", () => {
    const fetchMock = stubFetch();
    const onLoss = vi.fn<LossReporter>();
    const huge = Array.from({ length: 400 }, (_unused, i) => record("x".repeat(300) + String(i)));

    setup({ records: huge, config: { storage: { backend: "memory" } }, onLoss }).flush.flush(
      "pagehide",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(0);
    expect(onLoss).toHaveBeenCalledWith("not_stored", expect.any(Array), ["b1"]);
  });

  it("diverts an oversized batch to the synchronous emergency queue", () => {
    const fetchMock = stubFetch();
    const huge = Array.from({ length: 400 }, (_unused, i) => record("x".repeat(300) + String(i)));

    setup({ records: huge }).flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });
});

describe("ExitFlush to another origin", () => {
  /** A batch below the exit budget. Two of them together are above it. */
  const large = (id: string): LogBatch => ({
    id,
    createdAt: Date.now(),
    attempts: 0,
    records: Array.from({ length: 40 }, (_unused, i) => record("x".repeat(900) + String(i))),
  });

  /** Lists every header of an exit fetch. happy-dom keeps a name's casing, so lower-case it. */
  const headerEntries = (init: RequestInit): string[][] =>
    [...(init.headers as Headers)].map(([name, value]) => [name.toLowerCase(), value]);

  it("sends a text/plain keepalive fetch without cookies, not a beacon, by default", () => {
    // sendBeacon always sends the cookies, so a session cookie on a parent domain would reach
    // the ingest server although credentials is "omit".
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
    // Any other header would need a preflight, which a closing page can't wait for.
    expect(headerEntries(init)).toEqual([["content-type", "text/plain;charset=UTF-8"]]);
    expect(new URL(url).searchParams.get("uiobs_batch_id")).toBe("b1");
    expect(new URL(url).searchParams.get("uiobs_exit")).toBe("pagehide");
  });

  it("sends the same keepalive fetch, not a beacon, with credentials same-origin", () => {
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      config: { credentials: "same-origin" },
    }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("same-origin");
    expect(headerEntries(init)).toEqual([["content-type", "text/plain;charset=UTF-8"]]);
    expect(new URL(url).searchParams.get("uiobs_batch_id")).toBe("b1");
    expect(new URL(url).searchParams.get("uiobs_exit")).toBe("pagehide");
  });

  it("keeps the beacon when the app asks for cookies with credentials include", () => {
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      config: { credentials: "include" },
    }).flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledOnce();
    const url = new URL(beacon.mock.calls[0][0]);
    expect(url.searchParams.get("uiobs_batch_id")).toBe("b1");
    expect(url.searchParams.get("uiobs_exit")).toBe("pagehide");
    expect(beacon.mock.calls[0][1].type).toBe("text/plain;charset=utf-8");
  });

  it("parks a batch that doesn't fit in the budget that the batches before it used", () => {
    // The browser rejects the second fetch after the document closes, when nothing can park it.
    const fetchMock = stubFetch();

    setup({ batches: () => [large("b1"), large("b2")] }).flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("parks a batch that doesn't fit next to the hidden flush's sends still in flight", () => {
    const fetchMock = stubFetch();

    setup({
      records: [record("x".repeat(20_000))],
      inFlight: () => 50_000,
    }).flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("reports a keepalive fetch that never arrives, and parks the batch", async () => {
    stubFetch(() => Promise.reject(new Error("network is down")));

    const { flush, events } = setup({ records: [record("bye")] });
    flush.flush("shutdown");

    await vi.waitFor(() => {
      expect(events.some((event) => event.message.includes("exit flush failed"))).toBe(true);
    });
    expect(emergencyKeys()).toHaveLength(1);
  });
});

describe("ExitFlush keepalive fallback", () => {
  it("falls back to a text/plain keepalive fetch when the host has no sendBeacon", () => {
    // A navigator without the method, which is what a worker has. The tests
    // below drop the navigator outright, which is the other half of the guard.
    vi.stubGlobal("navigator", {});
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      config: { credentials: "include" },
    }).flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const headers = init.headers as Headers;
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("include");
    expect(headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });

  it("sends a keepalive fetch with the last headers, not a beacon, when headers is set", () => {
    // sendBeacon can't set a header, and without the authorization header the server drops it.
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      headers: { authorization: "Bearer t1" },
    }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(init.keepalive).toBe(true);
    expect(headers.get("authorization")).toBe("Bearer t1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-uiobs-batch-id")).toBe("b1");
    expect(new URL(url).searchParams.get("uiobs_exit")).toBe("pagehide");
  });

  it("starts the keepalive fetch inside the library request scope, and closes the scope", () => {
    // Network capture skips a request that starts in the scope. Without it, capture.fetch logs
    // the library's own exit request when the endpoint isn't written in its canonical form.
    const scopes: boolean[] = [];
    stubFetch(() => {
      scopes.push(isLibraryRequest());
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    setup({
      records: [record("bye")],
      headers: { authorization: "Bearer t1" },
    }).flush.flush("pagehide");

    expect(scopes).toEqual([true]);
    expect(isLibraryRequest()).toBe(false);
  });

  it("parks a batch that does not fit in the keepalive budget that the batches before it used", () => {
    // Each batch is below the budget, but the two together are above it. The browser rejects
    // the second fetch after the document closes, and park() does not run.
    const fetchMock = stubFetch();
    const large = (id: string): LogBatch => ({
      id,
      createdAt: Date.now(),
      attempts: 0,
      records: Array.from({ length: 40 }, (_unused, i) => record("x".repeat(900) + String(i))),
    });

    setup({
      batches: () => [large("b1"), large("b2")],
      headers: { authorization: "Bearer t1" },
    }).flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("parks a batch that doesn't fit next to the hidden flush's sends still in flight", () => {
    // On a navigation, hidden fires just before pagehide, and the transport's keepalive sends
    // use the same browser budget. The browser rejects a fetch over it after the document closes.
    const fetchMock = stubFetch();

    setup({
      records: [record("x".repeat(20_000))],
      headers: { authorization: "Bearer t1" },
      inFlight: () => 50_000,
    }).flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("sends a batch that fits next to the hidden flush's sends still in flight", () => {
    const fetchMock = stubFetch();

    setup({
      records: [record("x".repeat(20_000))],
      headers: { authorization: "Bearer t1" },
      inFlight: () => 30_000,
    }).flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emergencyKeys()).toHaveLength(0);
  });

  it("reads the transport's sends in flight again at every exit flush", () => {
    // A page from the back-forward cache can flush again, and by then the transport's requests
    // have settled.
    const fetchMock = stubFetch();
    let inFlight = 50_000;
    const { flush, pending } = setup({
      records: [record("x".repeat(20_000))],
      headers: { authorization: "Bearer t1" },
      inFlight: () => inFlight,
    });

    flush.flush("pagehide");
    expect(fetchMock).not.toHaveBeenCalled();

    inFlight = 0;
    pending.push(record("x".repeat(20_000)));
    flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("doesn't count an earlier exit flush's sends against the next exit flush", () => {
    // A beacon never reports its completion, so an exit flush can't know what an earlier one
    // still has in flight. A page from the back-forward cache can flush again.
    const fetchMock = stubFetch();
    const large = (): LogBatch => ({
      id: "b1",
      createdAt: Date.now(),
      attempts: 0,
      records: Array.from({ length: 40 }, (_unused, i) => record("x".repeat(900) + String(i))),
    });
    const { flush } = setup({ batches: () => [large()], headers: { authorization: "Bearer t1" } });

    flush.flush("pagehide");
    flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(emergencyKeys()).toHaveLength(0);
  });

  it("parks the batch, and sends no beacon, while a headers function has no result", () => {
    // Before the first send and after a 401, the library has no headers.
    // The server refuses a beacon without them.
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      config: { headers: () => ({ authorization: "Bearer t1" }) },
    }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("reports headers that the browser cannot build, parks the batch and does not throw", () => {
    // A header value outside ISO-8859-1, for example "张三", makes the Headers constructor throw.
    vi.stubGlobal("Headers", function BrokenHeaders() {
      throw new TypeError("Invalid header value");
    });
    const fetchMock = stubFetch();
    const { flush, codes } = setup({ records: [record("bye")], headers: { "x-user": "张三" } });

    expect(() => {
      flush.flush("shutdown");
    }).not.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(codes()).toContain("transport.http_error");
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("parks the batch when the browser refuses the beacon", () => {
    // A refusal is a full in-flight budget. A keepalive fetch draws on the same
    // budget, so trying one here loses the batch as the document goes.
    stubBeacon(() => false);
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      config: { credentials: "include" },
    }).flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("falls back when sendBeacon itself throws, and reports it", () => {
    stubBeacon(() => {
      throw new Error("beacon is unavailable");
    });
    const fetchMock = stubFetch();

    const { flush, codes } = setup({
      records: [record("bye")],
      config: { credentials: "include" },
    });
    flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(codes()).toContain("transport.http_error");
  });

  it("reports a fallback fetch that never arrives in a host without a navigator", async () => {
    vi.stubGlobal("navigator", undefined);
    stubFetch(() => Promise.reject(new Error("network is down")));

    const { flush, events } = setup({
      records: [record("bye")],
      config: { credentials: "include" },
    });
    flush.flush("shutdown");

    await vi.waitFor(() => {
      expect(events.some((event) => event.message.includes("exit flush failed"))).toBe(true);
    });
    // After shutdown(), the document is still alive, and the next page load sends the batch.
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("reports a fetch that throws before it returns a promise, and parks the batch", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch is not usable here");
    });

    const { flush, codes } = setup({
      records: [record("bye")],
      config: { credentials: "include" },
    });
    flush.flush("pagehide");

    expect(codes()).toContain("transport.http_error");
    expect(emergencyKeys()).toHaveLength(1);
  });
});

describe("ExitFlush to a same-origin endpoint", () => {
  const ENDPOINT_ORIGIN = new URL(ENDPOINT).origin;

  /**
   * Puts the page on an origin. happy-dom has no globalThis.origin, and a real page shows its
   * origin in location too.
   */
  const onOrigin = (origin: string): void => {
    vi.stubGlobal("origin", origin);
    vi.stubGlobal("location", { origin });
  };

  const onEndpointOrigin = (): void => {
    onOrigin(ENDPOINT_ORIGIN);
  };

  /** A batch below the exit budget. Two of them together are above it. */
  const large = (id: string, build: (i: number) => LogRecord): LogBatch => ({
    id,
    createdAt: Date.now(),
    attempts: 0,
    records: Array.from({ length: 40 }, (_unused, i) => build(i)),
  });

  /** Returns the content type of each exit fetch. Only a same-origin one has the serializer's. */
  const contentTypes = (fetchMock: ReturnType<typeof stubFetch>): (string | null)[] =>
    fetchMock.mock.calls.map(([, init]) => (init.headers as Headers).get("content-type"));

  it("sends a keepalive fetch with the serializer's content type, not a beacon", () => {
    // A stock OpenTelemetry Collector answers 415 to a text/plain batch. A same-origin
    // request needs no preflight, so it can say application/json.
    onEndpointOrigin();
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-uiobs-batch-id")).toBe("b1");
    expect(new URL(url).searchParams.get("uiobs_batch_id")).toBe("b1");
    expect(new URL(url).searchParams.get("uiobs_exit")).toBe("pagehide");
  });

  it("keeps text/plain for an endpoint on another origin", () => {
    // application/json to another origin needs a preflight, which a closing page can't wait for.
    onOrigin("https://app.example");
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(contentTypes(fetchMock)).toEqual(["text/plain;charset=UTF-8"]);
  });

  it("keeps text/plain when a page script has overwritten the origin global", () => {
    // origin is a replaceable window attribute, so a classic script's `var origin = "..."`
    // changes it. location still shows the real origin, and the endpoint isn't on it.
    vi.stubGlobal("location", { origin: "https://app.example" });
    vi.stubGlobal("origin", ENDPOINT_ORIGIN);
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(contentTypes(fetchMock)).toEqual(["text/plain;charset=UTF-8"]);
  });

  it("keeps text/plain when the endpoint and the page both have an opaque origin", () => {
    // Firefox gives a file: page the origin "null" on both sides, and a file: URL has it too.
    // Two opaque origins are never the same origin, although their strings are equal.
    vi.stubGlobal("location", { origin: "null" });
    vi.stubGlobal("origin", "null");
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      config: { endpoint: "file:///ingest/v1/logs" },
    }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(contentTypes(fetchMock)).toEqual(["text/plain;charset=UTF-8"]);
  });

  it("keeps text/plain in a host without a location", () => {
    vi.stubGlobal("location", undefined);
    vi.stubGlobal("origin", ENDPOINT_ORIGIN);
    const beacon = stubBeacon();
    const fetchMock = stubFetch();
    const { flush } = setup({ records: [record("bye")] });

    expect(() => {
      flush.flush("pagehide");
    }).not.toThrow();

    expect(beacon).not.toHaveBeenCalled();
    expect(contentTypes(fetchMock)).toEqual(["text/plain;charset=UTF-8"]);
  });

  it("keeps text/plain in a host without an origin", () => {
    vi.stubGlobal("location", { origin: ENDPOINT_ORIGIN });
    vi.stubGlobal("origin", undefined);
    const beacon = stubBeacon();
    const fetchMock = stubFetch();
    const { flush } = setup({ records: [record("bye")] });

    expect(() => {
      flush.flush("pagehide");
    }).not.toThrow();

    expect(beacon).not.toHaveBeenCalled();
    expect(contentTypes(fetchMock)).toEqual(["text/plain;charset=UTF-8"]);
  });

  it("keeps text/plain in a sandboxed frame, whose own origin is opaque", () => {
    // A frame sandboxed without allow-same-origin still shows its URL in location, but it sends
    // as origin "null", so application/json to the endpoint would need a preflight.
    vi.stubGlobal("location", { origin: ENDPOINT_ORIGIN });
    vi.stubGlobal("origin", "null");
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(contentTypes(fetchMock)).toEqual(["text/plain;charset=UTF-8"]);
  });

  it("decides for each batch by the origin of its own endpoint", () => {
    onEndpointOrigin();
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      config: { metricsEndpoint: "https://metrics.example/v1/metrics" },
      batches: () => [
        { id: "m1", createdAt: Date.now(), attempts: 0, records: [pointRecord()] },
        { id: "l1", createdAt: Date.now(), attempts: 0, records: [record("bye")] },
      ],
    }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v1/metrics",
      "/v1/logs",
    ]);
    expect(contentTypes(fetchMock)).toEqual(["text/plain;charset=UTF-8", "application/json"]);
  });

  it("parks the batch while a headers function has no result", () => {
    // The server needs the headers on the same origin too, so the next page load sends the batch.
    onEndpointOrigin();
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      records: [record("bye")],
      config: { headers: () => ({ authorization: "Bearer t1" }) },
    }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("parks a batch that doesn't fit in the budget that the batches before it used", () => {
    onEndpointOrigin();
    const beacon = stubBeacon();
    const fetchMock = stubFetch();
    const logs = (i: number): LogRecord => record("x".repeat(900) + String(i));

    setup({ batches: () => [large("b1", logs), large("b2", logs)] }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("parks a batch that doesn't fit next to the hidden flush's sends still in flight", () => {
    // Without headers a same-origin batch also goes out as a keepalive fetch, so the hidden
    // flush's sends count against it too.
    onEndpointOrigin();
    const beacon = stubBeacon();
    const fetchMock = stubFetch();

    setup({
      records: [record("x".repeat(20_000))],
      inFlight: () => 50_000,
    }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("counts a beacon that the browser took against the budget of a later keepalive fetch", () => {
    // The browser has one in-flight budget for both. It rejects a fetch over the budget after
    // the document closes, when nothing can park the batch any more.
    onEndpointOrigin();
    const beacon = stubBeacon();
    const fetchMock = stubFetch();
    // A point's body is its metric name, and the name is what makes the payload large here.
    const points = (i: number): LogRecord => ({
      ...pointRecord(),
      body: "x".repeat(900) + String(i),
    });
    const logs = (i: number): LogRecord => record("x".repeat(900) + String(i));

    setup({
      config: { metricsEndpoint: "https://metrics.example/v1/metrics", credentials: "include" },
      batches: () => [large("m1", points), large("l1", logs)],
    }).flush.flush("pagehide");

    expect(beacon).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("parks a later same-origin batch after the browser refuses a beacon", () => {
    // A refusal means the in-flight budget is full. The browser would reject the fetch after
    // the document closes, when nothing can park the batch or report the loss any more.
    onEndpointOrigin();
    const beacon = stubBeacon(() => false);
    const fetchMock = stubFetch();

    setup({
      config: { metricsEndpoint: "https://metrics.example/v1/metrics", credentials: "include" },
      batches: () => [
        { id: "m1", createdAt: Date.now(), attempts: 0, records: [pointRecord()] },
        { id: "l1", createdAt: Date.now(), attempts: 0, records: [record("bye")] },
      ],
    }).flush.flush("pagehide");

    expect(beacon.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/v1/metrics"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(2);
  });

  it("reports a same-origin fetch that never arrives, and parks the batch", async () => {
    onEndpointOrigin();
    stubBeacon();
    stubFetch(() => Promise.reject(new Error("network is down")));

    const { flush, events } = setup({ records: [record("bye")] });
    flush.flush("shutdown");

    await vi.waitFor(() => {
      expect(events.some((event) => event.message.includes("exit flush failed"))).toBe(true);
    });
    expect(emergencyKeys()).toHaveLength(1);
  });
});

describe("ExitFlush after a pagehide", () => {
  /** A pageshow event. The page cache restores the page when `persisted` is true. */
  const pageshow = (): Event => Object.assign(new Event("pageshow"), { persisted: true });

  it.each([
    ["a pageshow", () => dispatchEvent(pageshow())],
    ["an uninstall", (flush: ExitFlush) => flush.uninstall()],
  ])("sends no late record when %s comes in the same task", async (_name, undo) => {
    // The page stays, or the sender stopped, so the batch timer or nobody else owns the record.
    const fetchMock = stubFetch();
    const { flush, pending, drainForExit } = setup();
    flush.install();
    dispatchEvent(new Event("pagehide"));
    pending.push(record("late record"));

    flush.flushLate();
    undo(flush);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(drainForExit).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(1);
  });

  it("parks a late batch that doesn't fit next to the bytes the pagehide flush sent", async () => {
    // Nothing tracks an exit send's end. The browser rejects an over-budget keepalive fetch
    // after the page is gone, when nothing can park the batch.
    const fetchMock = stubFetch();
    const { flush, pending } = setup({ records: [record("x".repeat(40_000))] });
    flush.install();

    dispatchEvent(new Event("pagehide"));
    pending.push(record("y".repeat(40_000)));
    flush.flushLate();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("counts the bytes of an earlier late send in the same leave", async () => {
    const fetchMock = stubFetch();
    const { flush, pending } = setup({ records: [record("x".repeat(25_000))] });
    flush.install();

    dispatchEvent(new Event("pagehide"));
    for (const filler of ["y", "z"]) {
      pending.push(record(filler.repeat(25_000)));
      flush.flushLate();
      await Promise.resolve();
    }

    // 3 x 25 KB is over the 60,000 bytes. The third send is the one that doesn't fit.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("starts the byte count again at the next leave after a pageshow", async () => {
    const fetchMock = stubFetch();
    const { flush, pending } = setup({ records: [record("x".repeat(40_000))] });
    flush.install();

    dispatchEvent(new Event("pagehide"));
    dispatchEvent(pageshow());
    pending.push(record("y".repeat(40_000)));
    dispatchEvent(new Event("pagehide"));
    await Promise.resolve();

    // The first leave's 40 KB is not in the budget of the second leave.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(emergencyKeys()).toHaveLength(0);
  });
});

describe("ExitFlush with a custom transport", () => {
  /** A transport the exit path must never call, because a closing page can't await it. */
  const transport = () => Promise.resolve({ status: 200 });

  it("hands the batch to transportOnExit and sends no beacon", () => {
    const beacon = stubBeacon();
    const onExit = vi.fn<ExitTransport>(() => true);
    const { flush } = setup({
      records: [record("bye")],
      config: { endpoint: null, transport, transportOnExit: onExit },
    });

    flush.flush("pagehide");

    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit.mock.calls[0][0]).toMatchObject({ batchId: "b1", attempt: 0 });
    expect(beacon).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(0);
  });

  it("tells transportOnExit the kind of each batch", () => {
    const onExit = vi.fn<ExitTransport>(() => true);
    const { flush } = setup({
      config: {
        endpoint: null,
        transport,
        transportOnExit: onExit,
        metricsEndpoint: METRICS_ENDPOINT,
      },
      batches: () => [
        { id: "m1", createdAt: Date.now(), attempts: 0, records: [pointRecord()] },
        { id: "l1", createdAt: Date.now(), attempts: 0, records: [record("bye")] },
      ],
    });

    flush.flush("pagehide");

    expect(onExit.mock.calls.map(([request]) => request.kind)).toEqual(["metrics", "logs"]);
  });

  it("parks the batch in the emergency queue when transportOnExit refuses it", () => {
    const { flush } = setup({
      records: [record("bye")],
      config: { endpoint: null, transport, transportOnExit: () => false },
    });

    flush.flush("pagehide");

    expect(emergencyKeys()).toHaveLength(1);
  });

  it("parks the batch and reports when transportOnExit throws", () => {
    const { flush, codes } = setup({
      records: [record("bye")],
      config: {
        endpoint: null,
        transport,
        transportOnExit: () => {
          throw new Error("channel closed");
        },
      },
    });

    flush.flush("pagehide");

    expect(emergencyKeys()).toHaveLength(1);
    expect(codes()).toContain("transport.http_error");
  });

  it("parks the batch on pagehide when there is no transportOnExit", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")], config: { endpoint: null, transport } });

    flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("runs a normal flush on hidden, also with transportOnExit", () => {
    // The page keeps running after a tab switch, so the async transport can still send.
    const onExit = vi.fn<ExitTransport>(() => true);
    const { flush, flushAlive } = setup({
      records: [record("bye")],
      config: { endpoint: null, transport, transportOnExit: onExit },
    });

    flush.flush("hidden");

    expect(flushAlive).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(0);
  });

  it("drops a batch that the serializer cannot encode", () => {
    const onExit = vi.fn<ExitTransport>(() => true);
    const { flush, codes } = setup({
      records: [record("bye")],
      config: {
        endpoint: null,
        transport,
        transportOnExit: onExit,
        serializer: {
          name: "broken",
          serialize: () => {
            throw new Error("cannot encode");
          },
        },
      },
    });

    flush.flush("pagehide");

    expect(onExit).not.toHaveBeenCalled();
    expect(codes()).toContain("transport.serialize_failed");
  });

  it("does nothing when nothing is pending", () => {
    const onExit = vi.fn<ExitTransport>(() => true);
    const { flush } = setup({ config: { endpoint: null, transport, transportOnExit: onExit } });

    flush.flush("pagehide");

    expect(onExit).not.toHaveBeenCalled();
  });
});

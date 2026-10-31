import { afterEach, describe, expect, it, vi } from "vitest";
import { EMERGENCY_STORAGE_KEY_PREFIX } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { ExitTransport, ObservabilityConfig } from "../src/models/config";
import type { LossReporter } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { ExitFlush } from "../src/transport/exit-flush";

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

/** A record of a span. */
const spanRecord = (): LogRecord => ({
  ...record("ui.start"),
  attributes: { "log.type": "span", "span.kind": "internal", "span.parent_id": "" },
});

/** A record of an aggregated counter point. */
const pointRecord = (): LogRecord => ({
  ...record("orders"),
  attributes: { "log.type": "metric", "metric.type": "counter", "metric.value": 1 },
});

/**
 * Listeners stay after a test. happy-dom gives one window to the whole file. Without this, a failed
 * assertion leaves an instance that flushes on the pagehide of the next test. `uninstall` is
 * idempotent. A test can still call it.
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
  /** Replaces the drain with one that gives several batches, one for each kind. */
  batches?: () => LogBatch[];
  /** Headers that the HTTP transport resolved last. */
  headers?: Record<string, string>;
  /** Replaces the normal flush of the pipeline. */
  alive?: () => void | Promise<void>;
  /** Receives the records that the exit flush loses. */
  onLoss?: LossReporter;
  /** Sends the points of the open metric interval. */
  beforeExit?: () => void;
}

/**
 * The default drain empties a real array, as the pipeline does. A drain that gives null on the
 * second call also passes the "sends once" test. That drain does not test the code that stops the
 * double send.
 */
function setup({
  records = [],
  config = {},
  drain,
  batches,
  headers,
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

  // The exit flush takes one batch for each kind. These tests give one batch or none.
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
    onLoss,
    beforeExit,
  });

  built.push(flush);
  return {
    flush,
    pending,
    events,
    drainForExit,
    flushAlive,
    codes: () => events.map((event) => event.code),
  };
}

const stubBeacon = (impl: (url: string, data: Blob) => boolean = () => true) => {
  const beacon = vi.fn(impl);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  return beacon;
};

/** The body is null by default. 204 is a null-body status. A Response with both throws. */
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
 * Read the items by index. The Storage of happy-dom is a Proxy that does not enumerate its items.
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
  it("runs a normal flush, not a beacon, when the document becomes hidden", () => {
    // The document keeps running. A normal flush keeps the headers, gzip and the retry.
    const beacon = stubBeacon();
    const { flush, flushAlive, drainForExit } = setup({ records: [record("bye")] });
    flush.install();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushAlive).toHaveBeenCalledOnce();
    expect(drainForExit).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    flush.uninstall();
  });

  it("ignores a visibilitychange back to visible", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("stay")] });
    flush.install();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(beacon).not.toHaveBeenCalled();
    flush.uninstall();
  });

  it("flushes on pagehide, which fires at the window", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();

    dispatchEvent(new Event("pagehide"));

    expect(new URL(beacon.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("pagehide");
    flush.uninstall();
  });

  it("flushes on freeze, which fires at the document and does not bubble", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();

    document.dispatchEvent(new Event("freeze"));

    expect(new URL(beacon.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("freeze");
    flush.uninstall();
  });

  it("binds once, however often install is called", () => {
    const add = vi.spyOn(globalThis, "addEventListener");
    const { flush } = setup();

    flush.install();
    flush.install();

    expect(add).toHaveBeenCalledOnce();
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
    const beacon = stubBeacon();
    vi.stubGlobal("document", undefined);
    const { flush } = setup({ records: [record("bye")] });

    flush.install();
    dispatchEvent(new Event("pagehide"));
    flush.uninstall();

    expect(beacon).toHaveBeenCalledOnce();
  });
});

describe("ExitFlush uninstall", () => {
  it("stops flushing on every signal", () => {
    const beacon = stubBeacon();
    const { flush } = setup({ records: [record("bye")] });
    flush.install();
    flush.uninstall();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("freeze"));
    dispatchEvent(new Event("pagehide"));

    expect(beacon).not.toHaveBeenCalled();
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
    const beacon = stubBeacon();
    const listeners = new Map<string, () => void>();
    stubFin({
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: () => undefined,
    });

    const { flush } = setup({ records: [record("bye")] });
    flush.install();
    listeners.get("close-requested")?.();

    expect(new URL(beacon.mock.calls[0][0]).searchParams.get("uiobs_exit")).toBe("openfin-close");
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
    const beacon = stubBeacon();
    stubFin({
      on: () => {
        throw new Error("runtime is gone");
      },
    });

    const { flush, codes } = setup({ records: [record("bye")] });
    flush.install();
    dispatchEvent(new Event("pagehide"));

    expect(codes()).toContain("openfin.unavailable");
    expect(beacon).toHaveBeenCalledOnce();
    flush.uninstall();
  });
});

describe("ExitFlush flush", () => {
  it("beacons the pending batch with the id in the query string", () => {
    const beacon = stubBeacon();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(beacon).toHaveBeenCalledOnce();
    const url = new URL(beacon.mock.calls[0][0]);
    expect(url.searchParams.get("uiobs_batch_id")).toBe("b1");
    expect(beacon.mock.calls[0][1].type).toBe("text/plain;charset=utf-8");
  });

  it("leaves the in-flight batches alone when the tab is only hidden", () => {
    stubBeacon();
    const { flush, drainForExit, flushAlive } = setup({ records: [record("bye")] });

    // hidden fires at each tab switch and each minimize. The document continues to run. Its sends
    // in flight still complete. A take of them here sends the same records two times. The server
    // cannot find the copy, because the id is new.
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
    stubBeacon();
    const { flush, drainForExit, flushAlive } = setup({ records: [record("bye")] });

    flush.flush("pagehide");

    expect(drainForExit).toHaveBeenCalledOnce();
    expect(flushAlive).not.toHaveBeenCalled();
  });

  it("sends nothing when there is no endpoint to send to", () => {
    const beacon = stubBeacon();

    setup({ records: [record("bye")], config: { endpoint: "" } }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
  });

  it("reports an endpoint that is not a URL, and keeps the buffer", () => {
    const beacon = stubBeacon();
    const { flush, pending, events } = setup({
      records: [record("bye")],
      config: { endpoint: "not-a-url" },
    });

    flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    expect(events.some((event) => event.message.includes("The exit flush cannot use"))).toBe(true);
  });

  it("sends nothing when the drain hands back an empty batch", () => {
    const beacon = stubBeacon();
    const { flush } = setup({
      drain: () => ({ id: "b1", createdAt: Date.now(), attempts: 0, records: [] }),
    });

    flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
  });

  it("reports a serializer that throws, and drops the batch", () => {
    const beacon = stubBeacon();
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

    expect(beacon).not.toHaveBeenCalled();
    expect(codes()).toContain("transport.serialize_failed");
  });

  it("gives onLoss the batch that its serializer cannot encode", () => {
    stubBeacon();
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

  it("beacons a batch of metric records to metricsEndpoint and the other batch to endpoint", () => {
    const beacon = stubBeacon();
    const { flush } = setup({
      config: { metricsEndpoint: METRICS_ENDPOINT },
      batches: () => [
        { id: "m1", createdAt: Date.now(), attempts: 0, records: [pointRecord()] },
        { id: "l1", createdAt: Date.now(), attempts: 0, records: [record("bye")] },
      ],
    });

    flush.flush("pagehide");

    const urls = beacon.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.pathname)).toEqual(["/v1/metrics", "/v1/logs"]);
    expect(urls.map((url) => url.searchParams.get("uiobs_batch_id"))).toEqual(["m1", "l1"]);
  });

  it("beacons a batch of span records to tracesEndpoint, and drops it without tracesEndpoint", () => {
    const beacon = stubBeacon();
    const batches = () => [
      { id: "t1", createdAt: Date.now(), attempts: 0, records: [spanRecord()] },
      { id: "l1", createdAt: Date.now(), attempts: 0, records: [record("bye")] },
    ];
    const withTraces = setup({ config: { tracesEndpoint: "https://x/v1/traces" }, batches });
    const without = setup({ batches });

    withTraces.flush.flush("pagehide");
    without.flush.flush("pagehide");

    const paths = beacon.mock.calls.map(([url]) => new URL(url).pathname);
    expect(paths).toEqual(["/v1/traces", "/v1/logs", "/v1/logs"]);
  });

  it("sends the points of the open metric interval before the drain", () => {
    stubBeacon();
    const beforeExit = vi.fn();
    const { flush, drainForExit } = setup({ records: [record("bye")], beforeExit });

    flush.flush("pagehide");

    expect(beforeExit).toHaveBeenCalledOnce();
    expect(beforeExit.mock.invocationCallOrder[0]).toBeLessThan(
      drainForExit.mock.invocationCallOrder[0],
    );
  });

  it("reports a metric collection that throws, and still sends the batch", () => {
    const beacon = stubBeacon();
    const { flush, codes } = setup({
      records: [record("bye")],
      beforeExit: () => {
        throw new Error("collect failed");
      },
    });

    flush.flush("pagehide");

    expect(codes()).toContain("pipeline.crashed");
    expect(beacon).toHaveBeenCalledOnce();
  });

  it("diverts an oversized batch to the synchronous emergency queue", () => {
    const beacon = stubBeacon();
    const huge = Array.from({ length: 400 }, (_unused, i) => record("x".repeat(300) + String(i)));

    setup({ records: huge }).flush.flush("pagehide");

    expect(beacon).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });
});

describe("ExitFlush keepalive fallback", () => {
  it("falls back when the host has no sendBeacon", () => {
    // A navigator without the method, which is what a worker has. The tests
    // below drop the navigator outright, which is the other half of the guard.
    vi.stubGlobal("navigator", {});
    const fetchMock = stubFetch();

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const headers = init.headers as Headers;
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
    expect(headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });

  it("sends a keepalive fetch with the last headers, not a beacon, when headers is set", () => {
    // sendBeacon cannot set a header. Without the authorization header, the server drops it.
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

  it("gives the full keepalive budget to each exit flush", () => {
    // The requests of an earlier flush are complete. A page from the back-forward cache can
    // flush again.
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

    setup({ records: [record("bye")] }).flush.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("falls back when sendBeacon itself throws, and reports it", () => {
    stubBeacon(() => {
      throw new Error("beacon is unavailable");
    });
    const fetchMock = stubFetch();

    const { flush, codes } = setup({ records: [record("bye")] });
    flush.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(codes()).toContain("transport.http_error");
  });

  it("reports a keepalive fetch that never arrives, and parks the batch", async () => {
    vi.stubGlobal("navigator", undefined);
    stubFetch(() => Promise.reject(new Error("network is down")));

    const { flush, events } = setup({ records: [record("bye")] });
    flush.flush("shutdown");

    await vi.waitFor(() => {
      expect(events.some((event) => event.message.includes("exit flush failed"))).toBe(true);
    });
    // After shutdown(), the document is still alive. The next page load sends the batch.
    expect(emergencyKeys()).toHaveLength(1);
  });

  it("reports a fetch that throws before it returns a promise, and parks the batch", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch is not usable here");
    });

    const { flush, codes } = setup({ records: [record("bye")] });
    flush.flush("pagehide");

    expect(codes()).toContain("transport.http_error");
    expect(emergencyKeys()).toHaveLength(1);
  });
});

describe("ExitFlush with a custom transport", () => {
  /** A transport that the exit path must never call. A page that closes cannot await it. */
  const transport = () => Promise.resolve({ status: 200 });

  it("gives the batch to transportOnExit and sends no beacon", () => {
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

  it("gives transportOnExit the kind of each batch", () => {
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
    // The page keeps running after a tab switch. The async transport can still send.
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

import { expect, it, vi } from "vitest";
import {
  configure,
  createMemoryTransport,
  flush,
  getHealth,
  getLogger,
  counter,
  histogram,
  rotateSecurityContext,
  clearPersistedLogs,
  shutdown,
} from "../src/index";
import { ObservabilityRuntime } from "../src/core/runtime";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { IdbDriver } from "../src/storage/idb-driver";
import { recordedUrl } from "../src/utils/platform";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig } from "../src/models/config";

const base = {
  endpoint: null,
  serviceName: "ops",
  storage: "memory",
  identity: "memory",
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
} as const;
const rt = () => ObservabilityRuntime.current()!;
const diagnostics = () => new Diagnostics(vi.fn(), 0);

it.each([
  "delivery",
  "buffering",
  "metrics",
  "correlation",
  "diagnostics",
  "capturePolicy",
] as const)("validates %s numeric budgets and preserves previous settings", (section) => {
  const d = diagnostics();
  const before = resolveConfig(base, d);
  const key = Object.keys(before[section]).find(
    (k) => typeof Reflect.get(before[section], k) === "number",
  )!;
  const next = resolveConfig({ [section]: { [key]: -1 } }, d, before);
  expect(next[section]).toEqual(before[section]);
  expect(d.snapshot()["config.invalid"]).toBeGreaterThan(0);
});

it("validates choices, strings, booleans, backoff relationships and URL hooks", () => {
  const d = diagnostics();
  const c = resolveConfig(
    {
      ...base,
      delivery: { retryBaseDelayMs: 100, retryMaxDelayMs: 1 },
      buffering: { overflow: "bad" },
      persistence: { namespace: 1 },
      metadata: { userAgent: "yes" },
      capture: { urlTransform: 1 },
    } as never,
    d,
  );
  expect(c.delivery.retryBaseDelayMs).toBe(2000);
  expect(c.buffering.overflow).toBe("drop-oldest");
  expect(c.persistence.namespace).toBe("");
  expect(c.metadata.userAgent).toBe(true);
  expect(c.capture.urlTransform).toBeUndefined();
});

it.each(["drop-oldest", "drop-newest", "persist"] as const)(
  "bounds partial and queued records using %s",
  async (overflow) => {
    const memory = createMemoryTransport();
    configure({
      ...base,
      transport: memory.transport,
      buffering: { maxPendingRecords: 2, overflow },
    });
    await flush();
    getLogger("ops").info("one");
    getLogger("ops").info("two");
    getLogger("ops").info("three");
    expect((await getHealth()).pending).toBeLessThanOrEqual(2);
    await flush();
    const messages = memory.records().map((r) => r.body);
    expect(messages).toContain(overflow === "drop-oldest" ? "three" : "one");
  },
);

it("bounds bytes, reports losses, and permits deliberately unbounded buffering", async () => {
  const m = createMemoryTransport();
  const onDrop = vi.fn();
  configure({ ...base, transport: m.transport, buffering: { maxPendingBytes: 1 }, onDrop });
  await flush();
  getLogger("ops").info("too large");
  await flush();
  expect(m.records()).toEqual([]);
  expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ reason: "buffer_full" }));
  configure({ buffering: { maxPendingRecords: 0, maxPendingBytes: 0 } });
  getLogger("ops").info("allowed");
  await flush();
  expect(m.records()[0].body).toBe("allowed");
});

it("limits metric instruments and series while preserving an overflow series", async () => {
  const m = createMemoryTransport();
  configure({ ...base, transport: m.transport, metrics: { maxInstruments: 1, maxSeries: 1 } });
  counter("one").add(1, { group: "a" });
  counter("one").add(2, { group: "b" });
  counter("two").add(1);
  await flush();
  expect(m.records().some((r) => r.attributes["metric.name"] === "two")).toBe(false);
  expect(m.records().some((r) => r.attributes["otel.metric.overflow"] === true)).toBe(true);
});

it("disables and resizes breadcrumbs at runtime and excludes selected resource metadata", async () => {
  const m = createMemoryTransport();
  configure({
    ...base,
    transport: m.transport,
    capturePolicy: { breadcrumbs: 0 },
    metadata: { pageUrl: false, userAgent: false, openfin: false },
  });
  getLogger("ops").info("one");
  expect(rt().breadcrumbs.snapshot()).toEqual([]);
  configure({ capturePolicy: { breadcrumbs: 1 } });
  getLogger("ops").info("two");
  getLogger("ops").info("three");
  expect(
    rt()
      .breadcrumbs.snapshot()
      .map((c) => c.message),
  ).toEqual(["three"]);
  await flush();
  expect(m.records()[0].attributes["page.url"]).toBe("");
  expect(m.records()[0].resource).not.toHaveProperty("browser.user_agent");
});

it("keeps diagnostic exceptions out of the console by default and out of opted-in fallback text", () => {
  const write = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const d = new Diagnostics(() => {
    throw new Error("SECRET");
  }, 0);
  d.report("config.invalid", "x");
  expect(write).not.toHaveBeenCalled();
  d.setPolicy(0, true);
  d.report("config.invalid", "x");
  expect(write).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(write.mock.calls)).not.toContain("SECRET");
});

it("supports original-URL transformations, omission and fail-closed callback errors", () => {
  const raw = "https://user:pass@example.com/account?id=123#secret";
  expect(recordedUrl(raw, false, (url) => url)).toBe(raw);
  expect(recordedUrl(raw, true, () => null)).toBe("");
  expect(
    recordedUrl(raw, true, () => {
      throw new Error("failed");
    }),
  ).toBe("");
  const diagnostics = new Diagnostics(vi.fn(), 0);
  expect(
    recordedUrl(
      raw,
      false,
      () => {
        throw new Error("failed");
      },
      diagnostics,
    ),
  ).toBe("");
  expect(diagnostics.snapshot()["capture.record_failed"]).toBe(1);
});

it("queries indexed context partitions in FIFO order without returning legacy or foreign batches", async () => {
  const db = new IdbDriver("operational-context-index");
  const batch = (id: string, routingContextId?: string, createdAt = 1): LogBatch => ({
    id,
    routingContextId,
    createdAt,
    records: [],
    attempts: 0,
  });
  await db.put(batch("legacy"));
  await db.put(batch("b", "B"));
  await db.put(batch("a2", "A", 2));
  await db.put(batch("a1", "A"));
  expect((await db.takeContext("A", 1)).map((b) => b.id)).toEqual(["a1"]);
  expect(await db.countContext("A")).toBe(2);
  await db.clear();
  await db.close();
});

it("isolates persistence namespaces and supports explicit deletion", async () => {
  const m = createMemoryTransport();
  m.respondWith(503);
  const config: Partial<ObservabilityConfig> = {
    ...base,
    storage: "localstorage",
    transport: m.transport,
    securityContext: { id: "shared-login" },
  };
  configure({ ...config, persistence: { namespace: "A" } });
  getLogger("ops").info("A");
  await flush();
  await shutdown();
  configure({ ...config, persistence: { namespace: "B" } });
  await flush();
  expect((await getHealth()).stored).toBe(0);
  getLogger("ops").info("B");
  await flush();
  await clearPersistedLogs();
  expect((await getHealth()).stored).toBe(0);
  await shutdown();
  configure({ ...config, persistence: { namespace: "A" } });
  await flush();
  expect((await getHealth()).stored).toBe(1);
  await clearPersistedLogs("namespace");
  expect((await getHealth()).stored).toBe(0);
  await expect(clearPersistedLogs("invalid" as never)).rejects.toThrow();
});

it.each([true, false])(
  "ties WebSocket capture to its opening context when isolation=%s",
  async (isolation) => {
    class Socket extends EventTarget {
      static OPEN = 1;
      static CLOSED = 3;
      static CONNECTING = 0;
      static CLOSING = 2;
      constructor(readonly url: string) {
        super();
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", Socket);
    const m = createMemoryTransport();
    configure({
      ...base,
      transport: m.transport,
      securityContext: { id: "A", isolation },
      capture: { errors: false, rejections: false, webSocket: true },
    });
    await vi.waitFor(() => {
      expect(globalThis.WebSocket).not.toBe(Socket);
    });
    const socket = new WebSocket("wss://example.com/account/A");
    await rotateSecurityContext({ id: "B", delivery: { transport: m.transport } });
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new Event("message"));
    socket.send("data");
    await flush();
    expect(m.records().some((r) => r.body === "websocket.open")).toBe(!isolation);
  },
);

it("uses indexed storage partition queries and keeps another context parked", async () => {
  const m = createMemoryTransport();
  m.respondWith(503);
  configure({
    ...base,
    storage: "indexeddb",
    transport: m.transport,
    securityContext: { id: "A" },
    persistence: { namespace: "indexed-ops" },
  });
  getLogger("ops").info("offline A");
  await flush();
  expect((await getHealth()).stored).toBe(1);
  await rotateSecurityContext(
    { id: "B", delivery: { transport: m.transport } },
    { pending: "retain" },
  );
  expect((await getHealth()).stored).toBe(0);
  await clearPersistedLogs("namespace");
  await rotateSecurityContext({ id: "A", delivery: { transport: m.transport } });
  expect((await getHealth()).stored).toBe(0);
});

it("clears storage without enabling delivery, including a retained memory partition", async () => {
  configure({ ...base, storage: "localstorage", persistence: { namespace: "offline-purge" } });
  await clearPersistedLogs();
  await clearPersistedLogs("namespace");
  await shutdown();
  configure(base);
  await clearPersistedLogs();
  await shutdown();
  const m = createMemoryTransport();
  m.respondWith(503);
  configure({ ...base, transport: m.transport, securityContext: { id: "A" } });
  getLogger("ops").info("park");
  await flush();
  await rotateSecurityContext({ id: "B", delivery: {} }, { pending: "retain" });
  await clearPersistedLogs("namespace");
  await clearPersistedLogs();
});

it("keeps startup policies stable and reinstalls capture for URL callback changes", async () => {
  configure({
    ...base,
    correlation: { sessionIdleMs: 0, traceMaxAgeMs: 0, sessionTouchMs: 0 },
    capture: { urlTransform: (url) => url },
  });
  await flush();
  configure({ correlation: { sessionIdleMs: 10 }, persistence: { namespace: "different" } });
  expect(rt().config.correlation.sessionIdleMs).toBe(0);
  expect(rt().config.persistence.namespace).toBe("");
  configure({ capture: { urlTransform: () => null } });
  getLogger("ops").info("no URL");
});

it("retains the breadcrumb tail when resizing an existing trail", async () => {
  configure(base);
  getLogger("ops").info("one");
  getLogger("ops").info("two");
  configure({ capturePolicy: { breadcrumbs: 1 } });
  expect(
    rt()
      .breadcrumbs.snapshot()
      .map((c) => c.message),
  ).toEqual(["two"]);
  configure({ capturePolicy: { breadcrumbs: 0 } });
  expect(rt().breadcrumbs.snapshot()).toEqual([]);
  await flush();
});

it("handles IndexedDB partition query failures through diagnostics", async () => {
  const { IndexedDbStorage } = await import("../src/storage/indexeddb-storage");
  const store = new IndexedDbStorage(
    "failed-query",
    { maxBatches: 5, maxAgeMs: 60000, maxAttempts: 5 },
    diagnostics(),
  );
  vi.spyOn(store["db"], "takeContext").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(store["db"], "countContext").mockRejectedValue(new Error("unavailable"));
  expect(await store.takeContext("A", 10)).toEqual([]);
  expect(await store.countContext("A")).toBe(0);
  await store.close();
});

it("upgrades databases that already contain the context index", async () => {
  const { INDEXEDDB_STORE_NAME, INDEXEDDB_CREATED_AT_INDEX } = await import("../src/constants");
  const name = "existing-context-index";
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 11);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(INDEXEDDB_STORE_NAME, { keyPath: "id" });
      store.createIndex(INDEXEDDB_CREATED_AT_INDEX, "createdAt");
      store.createIndex("routingContext", ["routingContextId", "createdAt"]);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
  const driver = new IdbDriver(name);
  expect(await driver.countContext("A")).toBe(0);
  await driver.close();
});

it("evicts complete queued batches without evicting requests already dispatched", async () => {
  const m = createMemoryTransport();
  configure({
    ...base,
    transport: m.transport,
    batching: { logBatchSize: 1 },
    buffering: { maxPendingRecords: 2, overflow: "drop-oldest" },
  });
  await flush();
  getLogger("ops").info("first");
  getLogger("ops").info("second");
  getLogger("ops").info("third");
  await flush();
  expect(m.records().map((r) => r.body)).toEqual(["second", "third"]);
});

it("reports an unserializable record without throwing into the pipeline caller", async () => {
  const m = createMemoryTransport();
  const onDrop = vi.fn();
  configure({ ...base, transport: m.transport, onDrop });
  await flush();
  const resource: Record<string, unknown> = {};
  resource.self = resource;
  const record = {
    timeUnixNano: "123",
    severityText: "INFO" as const,
    severityNumber: 9,
    traceId: "",
    spanId: "",
    traceFlags: 1,
    body: "circular",
    attributes: {},
    resource,
  };
  expect(() => {
    rt()["sender"]!["pipeline"].push(record);
  }).not.toThrow();
  await flush();
  expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ reason: "unserializable" }));
});

it("allows explicitly unbounded histogram boundary counts", async () => {
  const m = createMemoryTransport();
  configure({ ...base, transport: m.transport, metrics: { maxHistogramBoundaries: 0 } });
  histogram("many-buckets", { boundaries: Array.from({ length: 60 }, (_, i) => i) }).record(12);
  await flush();
  expect(m.records()[0].attributes["metric.name"]).toBe("many-buckets");
});

it("allows pipeline overflow handling without an optional loss callback", async () => {
  const { LogPipeline } = await import("../src/core/pipeline");
  const m = createMemoryTransport();
  configure({ ...base, transport: m.transport, buffering: { maxPendingBytes: 1 } });
  await flush();
  const sender = rt()["sender"]!;
  const stream = { batchSize: 10, flushIntervalMs: 1000 };
  const pipeline = new LogPipeline(
    sender["transport"],
    sender["storage"],
    sender["retry"],
    diagnostics(),
    { logs: stream, metrics: stream, traces: stream },
    undefined,
    rt().config,
  );
  expect(() => {
    pipeline.push({
      timeUnixNano: "1",
      severityText: "INFO",
      severityNumber: 9,
      body: "large",
      attributes: {},
      resource: {},
      traceId: "",
      spanId: "",
      traceFlags: 0,
    });
  }).not.toThrow();
  pipeline.destroy();
});

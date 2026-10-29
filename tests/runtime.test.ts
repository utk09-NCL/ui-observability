import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bus } from "../src/bus/bus";
import { ErrorCapture } from "../src/capture/errors";
import {
  BUS_MAX_BOOT_BUFFER_ACTIONS,
  BUS_MAX_BOOT_BUFFER_RECORDS,
  CONSOLE_DEFAULT_STYLES as STYLES,
  TELEMETRY_SDK_VERSION,
} from "../src/constants";
import type { WorkerLike } from "../src/bus/links";
import { JourneyEngine } from "../src/core/journey";
import { ObservabilityRuntime } from "../src/core/runtime";
import { applyRemote } from "../src/core/remote-rules";
import { Sender } from "../src/core/sender";
import type { LogBatch } from "../src/models/batch";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { TransportError } from "../src/transport/errors";
import { ExitFlush } from "../src/transport/exit-flush";
import { RetryEngine } from "../src/transport/retry-engine";
import {
  adoptJourney,
  configure,
  currentJourney,
  debug,
  endJourney,
  error,
  flush,
  getDiagnosticCounters,
  getJourneyToken,
  getLogger,
  getQueueDepth,
  getTraceHeaders,
  info,
  logAction,
  logEvent,
  logMetric,
  registerWorker,
  removeContext,
  setContext,
  setContextMap,
  shutdown,
  startJourney,
  startTrace,
  timeAsync,
  timeSync,
  trace,
  warn,
} from "../src/index";

const base = {
  endpoint: "https://x/v1/logs",
  serviceName: "svc",
  minLevel: "TRACE" as const,
};

/**
 * The runtime pinned to this realm, which every test has configured first.
 * @returns The runtime.
 */
function runtime(): ObservabilityRuntime {
  const current = ObservabilityRuntime.current();
  if (!current) {
    throw new Error("no runtime configured");
  }
  return current;
}

/**
 * The bus of the pinned runtime, which startup has loaded.
 * @returns The bus.
 */
function bus(): Bus {
  const loaded = runtime()["bus"];
  if (!loaded) {
    throw new Error("no bus loaded");
  }
  return loaded;
}

/** Lets queued microtasks and one timer turn run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Waits for startup to finish. */
async function ready(): Promise<void> {
  await vi.waitFor(() => {
    expect(runtime()["ready"]).toBe(true);
  });
}

/**
 * A forwarded record that passes `isLogRecord`.
 * @param body The message.
 * @returns The record.
 */
function forwardedRecord(body: string): Record<string, unknown> {
  return {
    body,
    severityText: "INFO",
    timeUnixNano: `${String(Date.now())}000000`,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
    severityNumber: 9,
    attributes: {},
    resource: {},
  };
}

beforeEach(() => {
  vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("", { status: 204 }))),
  );
});

afterEach(async () => {
  await shutdown().catch(() => undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runtime lifecycle", () => {
  it("does nothing at import time, so importing the package is free", async () => {
    expect(ObservabilityRuntime.current()).toBeNull();

    const module = await import("../src/index");

    expect(module).toBeTruthy();
    expect(ObservabilityRuntime.current()).toBeNull();
  });

  it("is idempotent: configure twice keeps one runtime", () => {
    configure(base);
    const first = ObservabilityRuntime.current();

    configure({ ...base, minLevel: "WARN" });

    expect(ObservabilityRuntime.current()).toBe(first);
    expect(runtime().config.minLevel).toBe("WARN");
    expect(runtime().diagnostics.snapshot()["config.reconfigured"]).toBe(1);
  });

  it("refuses a storage change once the adapter is built, rather than doing nothing", async () => {
    configure({ ...base, storage: "memory" });
    await ready();

    configure({ storage: "indexeddb" });

    // The runtime selects the adapter one time. After a swap, the runtime cannot get to the batches
    // in the old adapter.
    expect(runtime().config.storage).toBe("memory");
    expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
  });

  it("keeps batching, retention, limits and journey.maxAgeMs from startup", async () => {
    configure({ ...base, batching: { logBatchSize: 10 } });
    // The delivery stack reads batching and retention when it loads.
    await ready();

    configure({
      batching: { logBatchSize: 20 },
      retention: { maxBatches: 50 },
      limits: { maxBodyChars: 300 },
      journey: { maxAgeMs: 120_000, scope: "context" },
    });

    // journey.scope stays live. Only the age is fixed at startup.
    const { config } = runtime();
    expect(config.batching.logBatchSize).toBe(10);
    expect(config.retention.maxBatches).toBe(500);
    expect(config.limits.maxBodyChars).toBe(4096);
    expect(config.journey).toEqual({ scope: "context", maxAgeMs: 1_800_000 });
    expect(getDiagnosticCounters()["config.invalid"]).toBe(4);
  });

  it("does not report a later configure() that repeats the startup tunables", () => {
    // React StrictMode calls configure() two times with the same config.
    configure({ ...base, limits: { maxBodyChars: 300 }, journey: { maxAgeMs: 60_000 } });
    configure({ ...base, limits: { maxBodyChars: 300 }, journey: { maxAgeMs: 60_000 } });

    expect(getDiagnosticCounters()["config.invalid"] ?? 0).toBe(0);
  });

  it("passes the limits and the journey age to the builder, console and journey", () => {
    configure({ ...base, limits: { maxBodyChars: 300 }, journey: { maxAgeMs: 60_000 } });

    expect(runtime().builder["deps"].limits.maxBodyChars).toBe(300);
    expect(runtime().console["limits"]).toBe(runtime().builder["deps"].limits);
    expect(runtime().journey["options"].maxAgeMs).toBe(60_000);
  });

  it("passes batching and retention to the pipeline and the storage", async () => {
    configure({
      ...base,
      storage: "memory",
      batching: { logBatchSize: 7, metricFlushIntervalMs: 5000 },
      retention: { mode: "until-delivered", maxBatches: 40 },
    });
    await ready();

    const sender = runtime()["sender"];
    if (!sender) {
      throw new Error("sender was not built");
    }
    const streams = sender["pipeline"]["streams"];
    expect(streams.logs.options).toEqual({ flushIntervalMs: 2000, batchSize: 7 });
    expect(streams.metrics.options).toEqual({ flushIntervalMs: 5000, batchSize: 500 });
    expect((sender["storage"] as unknown as { limits: unknown }).limits).toEqual({
      maxBatches: 40,
      maxAgeMs: Infinity,
      maxAttempts: Infinity,
    });
  });

  it('writes no identity or journey key with identity: "memory"', async () => {
    configure({ ...base, identity: "memory" });
    await ready();

    info("hello");
    startJourney("checkout");
    runtime()["regenerateTabId"]();

    expect(localStorage.getItem("ui-observability.session")).toBeNull();
    expect(sessionStorage.getItem("ui-observability.tab")).toBeNull();
    expect(sessionStorage.getItem("ui-observability.journey")).toBeNull();
  });

  it("refuses an identity change after startup", () => {
    configure({ ...base, identity: "memory" });

    configure({ identity: "storage" });

    // The ids exist from startup. A later change cannot move them.
    expect(runtime().config.identity).toBe("memory");
    expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
  });

  it("takes a storage change made before the adapter is built", () => {
    configure({ ...base, storage: "memory" });
    configure({ storage: "localstorage" });

    expect(runtime().config.storage).toBe("localstorage");
  });

  it("keeps the rest of the config when a later call only turns logging off", () => {
    configure(base);
    configure({ enabled: false });

    const { config } = runtime();
    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBe(base.endpoint);
    expect(config.serviceName).toBe("svc");
  });

  it("installs a capture module that a later configure() call enabled", async () => {
    const stubbed = globalThis.fetch;
    configure(base);
    await ready();
    expect(globalThis.fetch).toBe(stubbed);

    configure({ capture: { fetch: true } });

    await vi.waitFor(() => {
      expect(globalThis.fetch).not.toBe(stubbed);
    });
  });

  it("keeps the installed captures until the new set has loaded", async () => {
    configure(base);
    await ready();

    configure({ capture: { fetch: true } });

    // Errors stay captured while the network chunk downloads.
    expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toEqual([
      "errors",
    ]);
    await vi.waitFor(() => {
      expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toEqual([
        "errors",
        "network",
      ]);
    });
  });

  it("applies a capture change made during startup", async () => {
    configure(base);
    configure({ capture: { errors: false, rejections: false } });
    await ready();
    await settle();

    expect(runtime()["captures"]).toEqual([]);
  });

  it("installs only the captures of the last configure() when two loads overlap", async () => {
    const stubbed = globalThis.fetch;
    configure(base);
    await ready();

    configure({ capture: { fetch: true } });
    configure({ capture: { fetch: false } });
    await settle();

    // The first load is stale. It must not install a capture that the second configure removed.
    expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toEqual([
      "errors",
    ]);
    expect(globalThis.fetch).toBe(stubbed);
  });

  it("reports a capture module that fails to load, and installs the others", async () => {
    vi.doMock("../src/capture/network", () => {
      throw new Error("chunk failed");
    });
    configure({ ...base, capture: { fetch: true } });
    await ready();
    vi.doUnmock("../src/capture/network");

    expect(getDiagnosticCounters()["capture.install_failed"]).toBe(1);
    expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toEqual([
      "errors",
    ]);
  });

  it("builds a fresh runtime after the previous one was destroyed", async () => {
    configure(base);
    const first = runtime();
    await shutdown();

    configure(base);

    expect(ObservabilityRuntime.current()).not.toBe(first);
  });

  it("skips sender-only startup when bus mode is forwarder", async () => {
    configure({ ...base, bus: { mode: "forwarder" } });
    await ready();

    expect(runtime()["sender"]).toBeUndefined();
    expect(runtime().diagnostics.snapshot()["bus.no_owner"]).toBe(1);
  });

  it("continues in a degraded state when the journey bootstrap rejects", async () => {
    vi.spyOn(JourneyEngine.prototype, "bootstrap").mockRejectedValue(new Error("no journey"));
    configure(base);

    await ready();

    expect(runtime().diagnostics.snapshot()["pipeline.crashed"]).toBe(1);
  });

  it("continues in a degraded state when startup throws", async () => {
    vi.spyOn(Bus.prototype, "start").mockRejectedValue(new Error("bus refused"));
    configure(base);

    await ready();

    expect(runtime().diagnostics.snapshot()["pipeline.crashed"]).toBe(1);
  });

  it("buffers records emitted before the bus resolves, then stamps the journey on them", async () => {
    configure(base);
    const log = getLogger("test");

    // The bus has no role yet. The runtime keeps this record in the buffer.
    log.info("during boot");
    const journey = startJourney("order-lifecycle");

    await ready();
    const batch = runtime()["sender"]?.["pipeline"]?.drainPending();

    expect(batch?.records[0].body).toBe("during boot");
    expect(batch?.records[0].attributes["journey.id"]).toBe(journey.id);
  });

  it("drops the oldest buffered record once the boot buffer is full", () => {
    configure(base);
    const log = getLogger("test");

    for (let i = 0; i <= BUS_MAX_BOOT_BUFFER_RECORDS; i++) {
      log.info(`record ${String(i)}`);
    }

    const bodies = runtime()["bootBuffer"].records.map((record: LogRecord) => record.body);
    expect(bodies).toHaveLength(BUS_MAX_BOOT_BUFFER_RECORDS);
    // The buffer evicted the first record. The second record is now the oldest.
    expect(bodies[0]).toBe("record 1");
    expect(runtime().diagnostics.snapshot()["record.dropped_boot_buffer_full"]).toBe(1);
  });

  it("keeps an action in the boot buffer when other records fill it", () => {
    configure(base);
    logAction("submit order");
    const log = getLogger("test");

    for (let i = 0; i <= BUS_MAX_BOOT_BUFFER_RECORDS; i++) {
      log.info(`record ${String(i)}`);
    }

    // The 500 limit applies only to records that are not actions.
    const bodies = runtime()["bootBuffer"].records.map((record: LogRecord) => record.body);
    expect(bodies).toHaveLength(BUS_MAX_BOOT_BUFFER_RECORDS + 1);
    expect(bodies[0]).toBe("submit order");
    expect(bodies[1]).toBe("record 1");
  });

  it("drops the oldest action at the action cap and gives it to onDrop", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, onDrop });

    for (let i = 0; i <= BUS_MAX_BOOT_BUFFER_ACTIONS; i++) {
      logAction(`action ${String(i)}`);
    }

    const buffer = runtime()["bootBuffer"].records;
    expect(buffer).toHaveLength(BUS_MAX_BOOT_BUFFER_ACTIONS);
    expect(buffer[0].body).toBe("action 1");
    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "buffer_full", records: 1, actions: ["action 0"] }),
      );
    });
  });

  it("gives onDrop the batches that storage evicts", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, onDrop });
    const evicted: LogBatch = {
      id: "old",
      createdAt: 0,
      attempts: 0,
      records: [forwardedRecord("lost") as unknown as LogRecord],
    };

    runtime()["reportGap"]({ batches: 1, records: 1, reason: "expired" }, [evicted]);

    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith({
        reason: "expired",
        records: 1,
        batchIds: ["old"],
        journeyIds: [],
        actions: [],
      });
    });
  });

  it("gives onDrop a batch that the serializer cannot encode", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const broken = {
      name: "broken",
      serialize: () => {
        throw new Error("nope");
      },
    };
    configure({ ...base, storage: "memory", onDrop, serializer: broken });
    await ready();

    info("lost");
    await flush();

    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "unserializable", records: 1 }),
      );
    });
  });

  it("caches loggers per namespace instead of allocating per call", () => {
    configure(base);

    expect(getLogger("trading.blotter")).toBe(getLogger("trading.blotter"));
    expect(getLogger("trading.blotter")).not.toBe(getLogger("trading.tickets"));
    expect(getLogger("trading.blotter", { scopedContext: { desk: "eq" } })).not.toBe(
      getLogger("trading.blotter"),
    );
  });

  it("does not cache a scoped logger, so a per-call context cannot leak", () => {
    configure(base);
    const options = { scopedContext: { orderId: "o-1" } };

    expect(getLogger("trading.blotter", options)).not.toBe(getLogger("trading.blotter", options));
  });

  it("makes no runtime when getLogger runs before configure", () => {
    // A module-level getLogger runs before the app calls configure. ES imports evaluate first.
    getLogger("early");
    getLogger("early.scoped", { scopedContext: { a: 1 } });

    expect(ObservabilityRuntime.current()).toBeNull();
  });

  it("writes a logger taken before configure to the runtime that configure makes", async () => {
    const early = getLogger("early");
    // Lets a default runtime, if one exists, finish startup and build its storage.
    await new Promise((resolve) => setTimeout(resolve, 50));

    configure({ ...base, storage: "memory" });
    const emit = vi.spyOn(runtime(), "emit");
    early.info("hello");

    // The app's own settings apply. No default runtime refuses the storage option.
    expect(runtime().config.storage).toBe("memory");
    expect(getDiagnosticCounters()["config.invalid"]).toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("configures implicitly when something logs before configure() was called", () => {
    expect(ObservabilityRuntime.current()).toBeNull();

    info("nobody configured me");

    expect(ObservabilityRuntime.current()).not.toBeNull();
  });

  it("takes the startup tunables from the first configure() after an early log call", async () => {
    // A module can log at import time. The write starts a runtime with defaults.
    info("module loaded");
    // That runtime reports the missing endpoint and serviceName.
    const before = getDiagnosticCounters()["config.invalid"];
    configure({
      ...base,
      batching: { logBatchSize: 20 },
      retention: { mode: "until-delivered" },
      limits: { maxBodyChars: 300 },
      journey: { maxAgeMs: 120_000 },
    });
    await ready();

    expect(runtime().config.batching.logBatchSize).toBe(20);
    expect(runtime().config.retention.mode).toBe("until-delivered");
    expect(runtime().builder["deps"].limits.maxBodyChars).toBe(300);
    expect(runtime().console["limits"]).toBe(runtime().builder["deps"].limits);
    expect(runtime().journey["options"].maxAgeMs).toBe(120_000);
    expect(getDiagnosticCounters()["config.invalid"]).toBe(before);
  });

  it("keeps the limits from the first configure() after an early log call", async () => {
    info("module loaded");
    const before = getDiagnosticCounters()["config.invalid"] ?? 0;
    configure({ ...base, limits: { maxBodyChars: 300 } });
    configure({ limits: { maxBodyChars: 500 } });
    await ready();

    expect(runtime().builder["deps"].limits.maxBodyChars).toBe(300);
    expect(getDiagnosticCounters()["config.invalid"]).toBe(before + 1);
  });

  it("drops a malformed forwarded record instead of losing the batch it lands in", async () => {
    configure(base);
    await ready();

    getLogger("test").info("a good local one");
    runtime()["ingestForwarded"]([{}, null, "nope", forwardedRecord("a good forwarded one")]);

    const batch = runtime()["sender"]?.["pipeline"]?.drainPending();
    expect(batch?.records.map((record) => record.body)).toEqual([
      "a good local one",
      "a good forwarded one",
    ]);
    expect(runtime().diagnostics.snapshot()["record.dropped_malformed"]).toBe(3);
  });

  it("samples a forwarded record, the first point this context can", async () => {
    configure({ ...base, sampling: { defaultRate: 0 } });
    await ready();

    runtime()["ingestForwarded"]([forwardedRecord("from a frame")]);

    expect(runtime()["sender"]?.["pipeline"]?.drainPending()).toBeNull();
    expect(runtime().diagnostics.snapshot()["record.dropped_by_sampling"]).toBe(1);
  });

  it("drops a forwarded payload that is not an array at all", async () => {
    configure(base);
    await ready();

    runtime()["ingestForwarded"]("not an array");

    expect(runtime().diagnostics.snapshot()["record.dropped_malformed"]).toBe(1);
  });

  it("stamps observedTime on a forwarded record, which is how forwarding lag is measured", async () => {
    configure(base);
    await ready();

    const record = forwardedRecord("from a frame");
    // Emitted a second ago, in another realm.
    record.timeUnixNano = `${String(Date.now() - 1000)}000000`;
    runtime()["ingestForwarded"]([record]);

    const [stored] = runtime()["sender"]?.["pipeline"]?.drainPending()?.records ?? [];
    expect(Number(stored.observedTimeUnixNano)).toBeGreaterThan(Number(stored.timeUnixNano));
  });

  it("accepts a direct message from a child, and ignores one after shutdown", async () => {
    configure(base);
    await ready();
    const accept = vi.spyOn(bus(), "acceptDirect");
    const held = runtime();

    held.busAccept({ t: "journey?", from: "child" }, vi.fn());
    await settle();
    expect(accept).toHaveBeenCalledTimes(1);

    // A message queued before shutdown must not reach the destroyed bus.
    held.busAccept({ t: "journey?", from: "child" }, vi.fn());
    await shutdown();
    held.busAccept({ t: "journey?", from: "child" }, vi.fn());
    await settle();
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("attaches a worker, and ignores a registration after shutdown", async () => {
    configure(base);
    await ready();
    const attach = vi.spyOn(bus(), "attachWorker").mockImplementation(() => undefined);
    const held = runtime();
    const worker: WorkerLike = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    registerWorker(worker);
    await settle();
    expect(attach).toHaveBeenCalledWith(worker);

    held.registerWorker(worker);
    await shutdown();
    held.registerWorker(worker);
    await settle();
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("regenerates the tab id when another context claims it", async () => {
    configure(base);
    await ready();
    const before = runtime().identity.tabId;

    runtime()["regenerateTabId"]();

    expect(runtime().identity.tabId).not.toBe(before);
    expect(sessionStorage.getItem("ui-observability.tab")).toBe(runtime().identity.tabId);
  });

  it("applies a journey update routed from the bus", async () => {
    // In "tab" scope, a sender does not adopt the journey of a child. "origin" adopts each.
    configure({ ...base, journey: { scope: "origin" } });
    await ready();
    const applyRemote = vi.spyOn(runtime().journey, "applyRemote");

    runtime().busAccept({ t: "journey", from: "child", journey: null }, vi.fn());
    await settle();

    expect(applyRemote).toHaveBeenCalledWith(null);
  });

  it("accepts forwarded records through bus routing", async () => {
    configure(base);
    await ready();

    runtime().busAccept(
      {
        t: "records",
        from: "child",
        records: [forwardedRecord("routed through bus") as unknown as LogRecord],
      },
      vi.fn(),
    );
    await settle();

    const batch = runtime()["sender"]?.["pipeline"]?.drainPending();
    expect(batch?.records.map((record) => record.body)).toEqual(["routed through bus"]);
  });

  it("regenerates the tab id when a broadcast tab conflict arrives", async () => {
    configure(base);
    await ready();
    const before = runtime().identity.tabId;
    const receive = (
      bus() as unknown as {
        receive: (
          message: { t: "tab"; from: string; tabId: string },
          source: { link: "broadcast"; origin: string },
        ) => void;
      }
    ).receive;

    receive({ t: "tab", from: "", tabId: before }, { link: "broadcast", origin: "same-origin" });

    expect(runtime().identity.tabId).not.toBe(before);
  });

  it("installs interactions, web-vitals, long-frames and console captures when enabled", async () => {
    const webVitalsModule = {
      onLCP: vi.fn(),
      onCLS: vi.fn(),
      onINP: vi.fn(),
      onFCP: vi.fn(),
      onTTFB: vi.fn(),
    };
    configure({
      ...base,
      capture: {
        navigation: true,
        webVitals: true,
        webVitalsLoader: () => Promise.resolve(webVitalsModule),
        longFrames: true,
        console: ["log"],
      },
    });
    await ready();

    // ready() does not wait for the capture chunks. They load in parallel with startup.
    await vi.waitFor(() => {
      expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toEqual(
        expect.arrayContaining(["interactions", "web-vitals", "long-frames", "console"]),
      );
    });
  });

  it("does not load the console capture for an empty list", async () => {
    configure({ ...base, capture: { console: [] } });
    await ready();

    // Wait for the default error capture. The install is then complete, and the check is real.
    await vi.waitFor(() => {
      expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toContain(
        "errors",
      );
    });

    expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).not.toContain(
      "console",
    );
  });

  it("records an app console.error one time, and does not print the mirror line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configure({ ...base, console: "DEBUG", capture: { console: true } });
    await ready();
    await vi.waitFor(() => {
      expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toContain(
        "console",
      );
    });
    const emit = vi.spyOn(runtime(), "emit");

    console.error("grid failed");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      severityText: "ERROR",
      body: "grid failed",
    });
  });

  it("applies the sampling header of an accepted batch", async () => {
    const header = '{"v":1,"ttlMs":60000,"minLevel":"TRACE","rates":{"grid":1}}';
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(null, { status: 204, headers: { "X-UiObs-Sampling": header } }),
        ),
      ),
    );
    configure({ ...base, minLevel: "INFO", sampling: { remote: true } });
    await ready();

    info("first");
    await flush();

    expect(runtime()["remote"].sampling?.current()).toEqual({
      rates: { grid: 1 },
      minLevel: "TRACE",
    });
  });

  it("ignores a sampling header that is not valid, and reports it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(null, { status: 204, headers: { "X-UiObs-Sampling": '{"v":2}' } }),
        ),
      ),
    );
    configure({ ...base, sampling: { remote: true } });
    await ready();

    info("first");
    await flush();

    expect(runtime()["remote"].sampling).toBeNull();
    expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
  });

  it("gives the bus the slot of the remote rules, and samples forwarded records with them", async () => {
    configure({ ...base, sampling: { remote: true, defaultRate: 0 } });
    await ready();
    const slot = runtime()["remote"];
    const deliver = vi.spyOn(runtime() as unknown as { deliver: () => void }, "deliver");

    expect(bus()["handlers"].remote).toBe(slot);
    runtime()["ingestForwarded"]([forwardedRecord("dropped")]);
    applyRemote(slot, runtime().config, { rules: { rates: {}, defaultRate: 1 }, ttlMs: 60_000 });
    runtime()["ingestForwarded"]([forwardedRecord("kept")]);

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not install ErrorCapture when error signals are all disabled", async () => {
    configure({
      ...base,
      capture: {
        errors: false,
        rejections: false,
        resourceErrors: false,
        fetch: false,
        xhr: false,
        interactions: false,
        navigation: false,
        webVitals: false,
      },
    });
    await ready();

    expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toEqual([]);
  });

  it("reports a storage gap once, then throttles", async () => {
    configure(base);
    await ready();
    const emit = vi.spyOn(runtime(), "emit");

    runtime()["reportGap"]({ batches: 2, records: 30, reason: "over_capacity" }, []);
    runtime()["reportGap"]({ batches: 1, records: 10, reason: "over_capacity" }, []);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]?.attributes["gap.records"]).toBe(30);
  });

  it("ignores an emit once destroyed", async () => {
    configure(base);
    await ready();
    const held = runtime();
    const { record } = held.builder.build({
      level: "INFO",
      type: "event",
      body: "after the end",
      namespace: "test",
    });

    await shutdown();

    expect(() => {
      held.emit(record);
    }).not.toThrow();
  });

  it("drains the buffers only when the document is hidden", async () => {
    configure(base);
    await ready();
    getLogger("test").info("still running");

    const pipeline = runtime()["sender"]?.["pipeline"];
    if (!pipeline) {
      throw new Error("the sender built no pipeline");
    }
    const pending = vi.spyOn(pipeline, "drainPending");
    const forExit = vi.spyOn(pipeline, "drainForExit");

    // A tab switch. The document continues to run. A batch in flight is still on its way. A take of
    // it here sends those records two times.
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    // A second switch, with nothing buffered behind it.
    document.dispatchEvent(new Event("visibilitychange"));

    expect(pending).toHaveBeenCalledTimes(2);
    expect(forExit).not.toHaveBeenCalled();
  });

  it("tears everything down, and a second shutdown is a no-op", async () => {
    configure(base);
    await ready();
    const held = runtime();

    await shutdown();
    expect(ObservabilityRuntime.current()).toBeNull();

    await expect(held.destroy()).resolves.toBeUndefined();
  });

  it("does not clear the singleton key when current() is not this runtime", async () => {
    configure(base);
    await ready();
    const held = runtime();
    vi.spyOn(ObservabilityRuntime, "current").mockReturnValue(null);

    await expect(held.destroy()).resolves.toBeUndefined();
  });
});

describe("delivery stack loading", () => {
  it("loads no delivery stack and sends nothing with endpoint: null", async () => {
    configure({ ...base, endpoint: null });
    await ready();

    info("local only");
    await flush();
    dispatchEvent(new Event("pagehide"));

    expect(runtime()["sender"]).toBeUndefined();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(navigator.sendBeacon)).not.toHaveBeenCalled();
  });

  it("loads the delivery stack when a later configure sets an endpoint", async () => {
    configure({ ...base, endpoint: null });
    await ready();

    configure({ endpoint: base.endpoint });
    info("during load");
    await vi.waitFor(() => {
      expect(runtime()["sender"]).toBeDefined();
    });

    // The runtime holds the record during the load. Then it gives the record to the stack.
    const batch = runtime()["sender"]?.["pipeline"].drainPending();
    expect(batch?.records.map((record) => record.body)).toEqual(["during load"]);
  });

  it("stops the retry loop when the exit flush fails to install", async () => {
    // A retry loop with no owner sends after the runtime reports a failed load.
    vi.spyOn(ExitFlush.prototype, "install").mockImplementation(() => {
      throw new Error("listener refused");
    });
    const stop = vi.spyOn(RetryEngine.prototype, "stop");

    configure(base);
    await ready();

    expect(runtime()["sender"]).toBeUndefined();
    expect(getDiagnosticCounters()["pipeline.crashed"]).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("waits in flush() for startup to release the boot records", async () => {
    const transport = vi.fn(() => Promise.resolve({ status: 202 }));
    configure({ ...base, endpoint: null, transport, bus: { mode: "off" } });

    info("logged during startup");
    await flush();

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("sends through a custom transport with no endpoint", async () => {
    const transport = vi.fn(() => Promise.resolve({ status: 202 }));
    configure({ ...base, endpoint: null, transport });
    await ready();

    info("through the app channel");
    await flush();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("refuses to add or remove a custom transport once the delivery stack exists", async () => {
    const transport = vi.fn(() => Promise.resolve({ status: 202 }));
    configure({ ...base, endpoint: null, transport });
    await ready();

    configure({ transport: undefined });

    // Without the transport, the retry engine removes each stored batch as delivered.
    expect(runtime().config.transport).toBe(transport);

    await shutdown();
    configure(base);
    await ready();

    configure({ transport });

    // The HTTP stack exists. It ignores a new transport with no message.
    expect(runtime().config.transport).toBeUndefined();
    expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
  });

  it("accepts a new transport function in place of the one in force", async () => {
    const first = vi.fn(() => Promise.resolve({ status: 202 }));
    const second = vi.fn(() => Promise.resolve({ status: 202 }));
    configure({ ...base, endpoint: null, transport: first });
    await ready();

    configure({ transport: second });
    info("after the swap");
    await flush();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("allows endpoint: null after the stack loads when a custom transport sends", async () => {
    configure({ ...base, transport: () => Promise.resolve({ status: 202 }) });
    await ready();

    configure({ endpoint: null });

    expect(runtime().config.endpoint).toBeNull();
    expect(getDiagnosticCounters()["config.invalid"]).toBeUndefined();
  });

  it("refuses to remove the endpoint once the delivery stack exists", async () => {
    configure(base);
    await ready();

    configure({ endpoint: null });
    configure({ endpoint: "" });

    // Without an endpoint, the retry engine removes each stored batch as delivered.
    expect(runtime().config.endpoint).toBe(base.endpoint);
    expect(runtime().config.capture.ignoreUrls).toContain(base.endpoint);
    expect(getDiagnosticCounters()["config.invalid"]).toBe(2);
  });

  it("accepts a new endpoint URL once the delivery stack exists", async () => {
    configure(base);
    await ready();

    configure({ endpoint: "https://y/v1/logs" });

    expect(runtime().config.endpoint).toBe("https://y/v1/logs");
    expect(getDiagnosticCounters()["config.invalid"]).toBeUndefined();
  });

  it("loads no delivery stack in a forwarder on a later configure", async () => {
    configure({ ...base, bus: { mode: "forwarder" } });
    await ready();

    configure({ serviceName: "renamed" });
    await Promise.resolve();

    // A forwarder gives its records to another context. It must not send them itself.
    expect(runtime()["sender"]).toBeUndefined();
    expect(runtime()["senderLoad"]).toBeUndefined();
  });

  it("drops the oldest held record when the hold buffer is full", async () => {
    configure({ ...base, endpoint: null });
    await ready();

    configure({ endpoint: base.endpoint });
    const log = getLogger("burst");
    for (let i = 0; i <= BUS_MAX_BOOT_BUFFER_RECORDS; i++) {
      log.info(`record ${String(i)}`);
    }

    expect(runtime()["pendingRecords"]).toHaveLength(BUS_MAX_BOOT_BUFFER_RECORDS);
    expect(getDiagnosticCounters()["record.dropped_boot_buffer_full"]).toBe(1);
  });

  it("gives onDrop the held records of a failed load", async () => {
    vi.spyOn(Sender, "create").mockRejectedValueOnce(new Error("chunk failed"));
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, endpoint: null, onDrop });
    await ready();

    configure({ endpoint: base.endpoint });
    info("held, then lost");

    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "load_failed", records: 1 }),
      );
    });
  });

  it("gives onDrop the startup records and each later record after a failed startup load", async () => {
    vi.spyOn(Sender, "create").mockRejectedValueOnce(new Error("chunk failed"));
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, onDrop });
    info("held at startup");
    await ready();

    info("after the failed load");

    await vi.waitFor(() => {
      const lost = onDrop.mock.calls
        .filter(([summary]) => summary.reason === "load_failed")
        .reduce((total, [summary]) => total + summary.records, 0);
      expect(lost).toBe(2);
    });
  });

  it("gives onDrop the held records when shutdown() comes before the load ends", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, endpoint: null, onDrop });
    await ready();

    configure({ endpoint: base.endpoint });
    info("held, then lost");
    await shutdown();

    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "load_failed", records: 1 }),
    );
  });

  it("accepts batching and retention before the delivery stack loads", async () => {
    configure({ ...base, endpoint: null });
    await ready();

    configure({
      endpoint: base.endpoint,
      batching: { logBatchSize: 20 },
      retention: { maxBatches: 50 },
    });

    expect(runtime().config.batching.logBatchSize).toBe(20);
    expect(runtime().config.retention.maxBatches).toBe(50);
    expect(getDiagnosticCounters()["config.invalid"]).toBeUndefined();
  });

  it("reports a failed load, drops held records and retries on the next configure", async () => {
    const create = vi.spyOn(Sender, "create").mockRejectedValueOnce(new Error("chunk failed"));
    configure({ ...base, endpoint: null });
    await ready();

    configure({ endpoint: base.endpoint });
    info("held, then lost");
    await vi.waitFor(() => {
      expect(getDiagnosticCounters()["pipeline.crashed"]).toBe(1);
    });

    expect(runtime()["sender"]).toBeUndefined();
    expect(runtime()["pendingRecords"]).toHaveLength(0);

    configure({ serviceName: "svc" });
    await vi.waitFor(() => {
      expect(runtime()["sender"]).toBeDefined();
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("installs no capture when shutdown runs during startup", async () => {
    const install = vi.spyOn(ErrorCapture.prototype, "install");

    configure(base);
    await shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A capture on a destroyed runtime keeps its window listeners until the page closes.
    expect(install).not.toHaveBeenCalled();
  });

  it("resolves shutdown after it destroys a delivery stack that was still loading", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realCreate = Sender.create.bind(Sender);
    const create = vi.spyOn(Sender, "create").mockImplementation(async (deps) => {
      await gate;
      return realCreate(deps);
    });
    const destroy = vi.spyOn(Sender.prototype, "destroy");
    configure(base);
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });

    const done = shutdown();
    release();
    await done;

    // A retry loop that outlives shutdown() can send after the app thinks the library stopped.
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("builds no delivery stack when shutdown runs before the load", async () => {
    const create = vi.spyOn(Sender, "create");

    configure(base);
    await shutdown();
    await settle();

    expect(create).not.toHaveBeenCalled();
  });

  it("loads the delivery stack for an endpoint set during startup", async () => {
    // Mode "off" decides the role immediately. The endpoint arrives before startup completes.
    configure({ ...base, endpoint: null, bus: { mode: "off" } });
    configure({ endpoint: base.endpoint });
    await ready();

    await vi.waitFor(() => {
      expect(runtime()["sender"]).toBeDefined();
    });
  });

  it("waits for a loading delivery stack in flush()", async () => {
    configure({ ...base, endpoint: null });
    await ready();

    configure({ endpoint: base.endpoint });
    info("sent by flush");
    await flush();

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("waits for a loading delivery stack in getQueueDepth()", async () => {
    configure({ ...base, endpoint: null });
    await ready();

    configure({ endpoint: base.endpoint });
    const count = vi.spyOn(Sender.prototype, "queueDepth");
    await getQueueDepth();

    expect(count).toHaveBeenCalledTimes(1);
  });

  it("releases the boot records before the capture modules load", async () => {
    // An unload while a capture chunk downloads must still find the boot records.
    vi.spyOn(
      ObservabilityRuntime.prototype as unknown as { loadCapture: () => Promise<undefined> },
      "loadCapture",
    ).mockReturnValue(new Promise(() => undefined));
    configure(base);
    info("during boot");

    await ready();

    const batch = runtime()["sender"]?.["pipeline"].drainPending();
    expect(batch?.records.map((record) => record.body)).toEqual(["during boot"]);
  });
});

describe("bus loading", () => {
  it("loads no bus with bus.mode off", async () => {
    configure({ ...base, bus: { mode: "off" } });
    await ready();

    startJourney("checkout");

    expect(runtime()["bus"]).toBeNull();
    expect(runtime()["busLoad"]).toBeUndefined();
  });

  it("loads the bus with bus.mode off when a same-origin child calls in", async () => {
    // A child frame attaches to this runtime without a handshake. Its records must still arrive.
    configure({ ...base, bus: { mode: "off" } });
    await ready();

    runtime().busAccept(
      {
        t: "records",
        from: "child",
        records: [forwardedRecord("from a child") as unknown as LogRecord],
      },
      vi.fn(),
    );
    await settle();

    expect(runtime()["bus"]).not.toBeNull();
    const batch = runtime()["sender"]?.["pipeline"].drainPending();
    expect(batch?.records.map((record) => record.body)).toEqual(["from a child"]);
  });

  it("attaches a worker before the bus completes its start", async () => {
    // A nested frame can hold start() for the full handshake. The worker's own handshake times out first.
    vi.spyOn(Bus.prototype, "start").mockReturnValue(new Promise(() => undefined));
    const attach = vi.spyOn(Bus.prototype, "attachWorker").mockImplementation(() => undefined);
    const worker: WorkerLike = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    configure(base);
    registerWorker(worker);
    await settle();

    expect(attach).toHaveBeenCalledWith(worker);
  });

  it("sends its own records when the bus chunk does not load", async () => {
    vi.doMock("../src/bus/bus", () => {
      throw new Error("chunk failed");
    });
    configure(base);
    await ready();
    vi.doUnmock("../src/bus/bus");

    expect(getDiagnosticCounters()["pipeline.crashed"]).toBe(1);
    expect(runtime()["bus"]).toBeNull();
    await vi.waitFor(() => {
      expect(runtime()["sender"]).toBeDefined();
    });
  });

  it("drops a child message when the bus did not start", async () => {
    vi.spyOn(Bus.prototype, "start").mockRejectedValue(new Error("bus refused"));
    const accept = vi.spyOn(Bus.prototype, "acceptDirect");
    configure(base);
    await ready();

    runtime().busAccept({ t: "journey?", from: "child" }, vi.fn());
    await settle();

    expect(accept).not.toHaveBeenCalled();
  });
});

describe("runtime routing as a forwarder", () => {
  it("sends one message per task rather than one per record", async () => {
    configure(base);
    await ready();
    vi.spyOn(bus(), "getRole").mockReturnValue("forwarder");
    const send = vi.spyOn(bus(), "sendRecords").mockImplementation(() => undefined);

    const log = getLogger("test");
    log.info("one");
    log.info("two");
    log.info("three");

    expect(send).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toHaveLength(3);
  });

  it("hands the forward buffer to the bus before shutdown() stops the bus", async () => {
    configure(base);
    await ready();
    vi.spyOn(bus(), "getRole").mockReturnValue("forwarder");
    const send = vi.spyOn(bus(), "sendRecords").mockImplementation(() => undefined);

    getLogger("test").info("bye");
    await shutdown();

    expect(send).toHaveBeenCalledWith([expect.objectContaining({ body: "bye" })]);
  });

  it("hands the buffer over on flush without waiting for the microtask", async () => {
    configure(base);
    await ready();
    vi.spyOn(bus(), "getRole").mockReturnValue("forwarder");
    const send = vi.spyOn(bus(), "sendRecords").mockImplementation(() => undefined);

    getLogger("test").info("buffered");
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("flushes nothing when a forwarder has nothing buffered", async () => {
    configure(base);
    await ready();
    vi.spyOn(bus(), "getRole").mockReturnValue("forwarder");
    const send = vi.spyOn(bus(), "sendRecords").mockImplementation(() => undefined);

    await flush();

    expect(send).not.toHaveBeenCalled();
  });
});

describe("runtime flush as a sender", () => {
  it("sends the pending batch", async () => {
    configure(base);
    await ready();
    getLogger("test").info("pending");

    await flush();

    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("stores the batch and nudges retry when the send fails", async () => {
    configure(base);
    await ready();
    const transport = runtime()["sender"]?.["pipeline"]["transport"];
    const storage = runtime()["sender"]?.["storage"];
    if (!transport || !storage) {
      throw new Error("sender was not built");
    }
    vi.spyOn(transport, "send").mockRejectedValue(new Error("offline"));
    const save = vi.spyOn(storage, "save");
    getLogger("test").info("pending");

    await flush();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 }));
    expect(getDiagnosticCounters()["transport.http_error"]).toBe(1);
  });

  it("reports a full store rather than rejecting the caller", async () => {
    configure(base);
    await ready();
    const transport = runtime()["sender"]?.["pipeline"]["transport"];
    const storage = runtime()["sender"]?.["storage"];
    if (!transport || !storage) {
      throw new Error("sender was not built");
    }
    vi.spyOn(transport, "send").mockRejectedValue(new Error("offline"));
    vi.spyOn(storage, "save").mockRejectedValue(new Error("quota exceeded"));
    getLogger("test").info("pending");

    await expect(flush()).resolves.toBeUndefined();

    expect(getDiagnosticCounters()["storage.degraded"]).toBe(1);
  });

  it("splits the batch the server refused as too large", async () => {
    configure(base);
    await ready();
    const transport = runtime()["sender"]?.["pipeline"]["transport"];
    const storage = runtime()["sender"]?.["storage"];
    if (!transport || !storage) {
      throw new Error("sender was not built");
    }
    // fake-indexeddb outlives the test that filled it, so earlier batches count here.
    for (const stale of await storage.take(100)) {
      await storage.remove(stale.id);
    }
    vi.spyOn(transport, "send").mockRejectedValue(new TransportError("too_large", "413", 413));
    getLogger("test").info("one");
    getLogger("test").info("two");

    await flush();

    const stored = await storage.take(10);
    expect(stored.map((one) => one.records.length)).toEqual([1, 1]);
  });

  it("does nothing when there is nothing pending", async () => {
    configure(base);
    await ready();
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;

    await flush();

    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  });
});

describe("queue depth", () => {
  it("counts the batches waiting in storage", async () => {
    configure(base);
    await ready();
    const storage = runtime()["sender"]?.["storage"];
    if (!storage) {
      throw new Error("sender was not built");
    }
    vi.spyOn(storage, "count").mockResolvedValue(3);

    await expect(getQueueDepth()).resolves.toBe(3);
  });

  it("reports 0 for a forwarder, which persists nothing", async () => {
    configure({ ...base, bus: { mode: "forwarder" } });
    await ready();

    await expect(getQueueDepth()).resolves.toBe(0);
  });

  it("reports a broken store as 0 rather than rejecting the caller", async () => {
    configure(base);
    await ready();
    const storage = runtime()["sender"]?.["storage"];
    if (!storage) {
      throw new Error("sender was not built");
    }
    vi.spyOn(storage, "count").mockRejectedValue(new Error("store is closed"));

    await expect(getQueueDepth()).resolves.toBe(0);
    expect(getDiagnosticCounters()["storage.degraded"]).toBe(1);
  });
});

describe("OneLogger", () => {
  it("mirrors a record below minLevel to the console and does not send it", () => {
    // minLevel limits what the library sends. The console level limits what it prints.
    configure({ ...base, minLevel: "INFO", console: "DEBUG" });
    const emit = vi.spyOn(runtime(), "emit");
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    getLogger("board.hop").debug("moved", { from: 1 });

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[DEBUG]%c",
      STYLES.namespace,
      "board.hop",
      STYLES.DEBUG,
      "",
      "moved",
      {
        from: 1,
      },
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("prints the redacted attributes when a redact hook is set", () => {
    configure({
      ...base,
      console: "DEBUG",
      redact: (record) => {
        delete record.attributes.card;
        return record;
      },
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    getLogger("pay").info("charged", { card: "4111", orderId: "ORD-1" });

    // The console must not show what redact removed. A host can record console arguments.
    const printed = spy.mock.calls[0][6] as Record<string, unknown>;
    expect(printed.orderId).toBe("ORD-1");
    expect(printed).not.toHaveProperty("card");
  });

  it("prints no line when redact drops the record", () => {
    // The message did not pass redact. A host can record console arguments.
    configure({ ...base, console: "DEBUG", redact: () => null });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    getLogger("pay").info("charged 4111", { card: "4111" });

    expect(spy).not.toHaveBeenCalled();
  });

  it("prints no line for an error when redact throws", () => {
    const redact = (): never => {
      throw new Error("hook");
    };
    configure({ ...base, console: "DEBUG", redact });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    getLogger("pay").error("failed 4111", Object.assign(new Error("boom"), { card: "4111" }));

    expect(spy).not.toHaveBeenCalled();
  });

  it("prints no line when redact changes the record to a broken shape", () => {
    configure({
      ...base,
      console: "DEBUG",
      redact: (record) => {
        (record as unknown as Record<string, unknown>).attributes = null;
        return record;
      },
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    getLogger("pay").info("charged 4111");

    expect(spy).not.toHaveBeenCalled();
  });

  it("prints the message only below minLevel when a redact hook is set", () => {
    // redact runs only on a built record. A record below minLevel is not built.
    configure({ ...base, minLevel: "INFO", console: "DEBUG", redact: (record) => record });
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    getLogger("pay").debug("charged", { card: "4111" });

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[DEBUG]%c",
      STYLES.namespace,
      "pay",
      STYLES.DEBUG,
      "",
      "charged",
    );
  });

  it("prints the message and the error only for an error below minLevel with redact set", () => {
    configure({ ...base, minLevel: "FATAL", console: "DEBUG", redact: (record) => record });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("boom");

    getLogger("pay").error("failed", failure, { card: "4111" });

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[ERROR]%c",
      STYLES.namespace,
      "pay",
      STYLES.ERROR,
      "",
      "failed",
      failure,
    );
  });

  it("uses the console styles from configure()", () => {
    configure({ ...base, console: { level: "INFO", styles: { INFO: "color:red" } } });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    getLogger("app").info("hello");

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[INFO]%c",
      STYLES.namespace,
      "app",
      "color:red",
      "",
      "hello",
    );
  });

  it("prints nothing to the console when enabled is false", () => {
    configure({ ...base, enabled: false, console: "DEBUG" });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    getLogger("app").info("hello");

    expect(spy).not.toHaveBeenCalled();
  });

  it("prints the error and the payload of an error call", () => {
    configure({ ...base, console: "DEBUG" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("boom");

    getLogger("app").error("failed", failure, { orderId: "ORD-1" });

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[ERROR]%c",
      STYLES.namespace,
      "app",
      STYLES.ERROR,
      "",
      "failed",
      failure,
      {
        orderId: "ORD-1",
      },
    );
  });

  it("prints an error below minLevel to the console with its error and payload", () => {
    configure({ ...base, minLevel: "FATAL", console: "DEBUG" });
    const emit = vi.spyOn(runtime(), "emit");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("boom");

    getLogger("app").error("failed", failure, { orderId: "ORD-1" });

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[ERROR]%c",
      STYLES.namespace,
      "app",
      STYLES.ERROR,
      "",
      "failed",
      failure,
      {
        orderId: "ORD-1",
      },
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("namespaces a child and merges its scoped context onto the parent's", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    const parent = getLogger("trading", { scopedContext: { desk: "eq-flow" } });
    const child = parent.child("blotter", {
      scopedContext: { grid: "orders" },
    });

    expect(child.namespace).toBe("trading.blotter");
    child.info("hello");

    expect(emit.mock.calls[0][0]?.attributes).toMatchObject({
      desk: "eq-flow",
      grid: "orders",
      "app.namespace": "trading.blotter",
    });
  });

  it("inherits the parent's scoped context when the child adds none", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");

    getLogger("trading", { scopedContext: { desk: "eq-flow" } })
      .child("blotter")
      .info("hello");

    expect(emit.mock.calls[0][0]?.attributes).toMatchObject({
      desk: "eq-flow",
    });
  });

  it("records every level it offers", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    const log = getLogger("trading");

    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");

    expect(emit.mock.calls.map((call) => call[0]?.severityText)).toEqual([
      "TRACE",
      "DEBUG",
      "INFO",
      "WARN",
    ]);
  });

  it("keeps metrics out of the breadcrumb trail", () => {
    // Breadcrumbs are what a human reads after an error. A tick counter is not.
    configure(base);
    const log = getLogger("trading");

    log.logAction("ORDER_SUBMIT");
    log.logEvent("GRID_READY");
    log.info("plain");
    log.logMetric("grid.render", 12, "ms");

    expect(
      runtime()
        .breadcrumbs.snapshot()
        .map((crumb) => crumb.category),
    ).toEqual(["action", "event", "log"]);
  });

  it("marks an action as an action and an event as an event", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    const log = getLogger("trading");

    log.logAction("ORDER_SUBMIT");
    log.logEvent("GRID_READY");

    expect(emit.mock.calls[0][0]?.attributes["log.type"]).toBe("action");
    expect(emit.mock.calls[1][0]?.attributes["log.type"]).toBe("event");
  });

  it("defaults a metric's unit and type", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");

    getLogger("trading").logMetric("grid.rows", 42);

    expect(emit.mock.calls[0][0]?.attributes).toMatchObject({
      "metric.unit": "count",
      "metric.type": "gauge",
    });
  });

  it("flattens an error and attaches the breadcrumb trail", () => {
    configure(base);
    const log = getLogger("trading");
    log.logEvent("GRID_READY");
    const emit = vi.spyOn(runtime(), "emit");

    log.error("submit failed", new Error("boom"));

    const record = emit.mock.calls[0][0];
    expect(record?.severityText).toBe("ERROR");
    expect(record?.attributes["error.type"]).toBe("Error");
    expect(record?.attributes["error.message"]).toBe("boom");
    const breadcrumbs = (record?.attributes.breadcrumbs as unknown[] | undefined) ?? [];
    expect(breadcrumbs.length).toBeGreaterThan(0);
  });

  it("accepts a non-Error reason, and no reason at all", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    const log = getLogger("trading");

    log.error("string reason", "just a string");
    log.fatal("no reason at all");

    expect(emit.mock.calls[0][0]?.attributes["error.message"]).toBe("just a string");
    expect(emit.mock.calls[1][0]?.severityText).toBe("FATAL");
    expect(emit.mock.calls[1][0]?.attributes["error.type"]).toBeUndefined();
  });

  it("keeps the breadcrumb trail of records that sampling dropped", () => {
    // Breadcrumbs are memory-only and never billed. A noisy namespace on a low
    // sampling rate is exactly where pre-error context matters most.
    configure({ ...base, sampling: { defaultRate: 0 } });
    const log = getLogger("trading");
    log.logAction("ORDER_SUBMIT");
    log.info("priced");

    const trail = runtime().breadcrumbs.snapshot();

    expect(trail.map((crumb) => crumb.message)).toEqual(["ORDER_SUBMIT", "priced"]);
  });

  it("keeps no breadcrumb for a record the redact hook dropped", () => {
    // The hook asked for the record gone. Its body must not travel inside the
    // next error record's breadcrumb list either.
    configure({ ...base, redact: () => null });
    getLogger("trading").info("card 4111111111111111");

    expect(runtime().breadcrumbs.snapshot()).toEqual([]);
  });

  it("reads a plain object in the error slot as the payload, like every sibling method", () => {
    // log.error("order failed", { orderId }) is the natural call. Stringified
    // into error.message it becomes "[object Object]" and the fields are gone.
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    const log = getLogger("trading");

    log.error("order failed", { orderId: "o-1", reason: "rejected" });
    log.fatal("order lost", Object.create(null) as Record<string, unknown>);

    const record = emit.mock.calls[0][0];
    expect(record?.attributes).toMatchObject({ orderId: "o-1", reason: "rejected" });
    expect(record?.attributes["error.message"]).toBeUndefined();
    expect(emit.mock.calls[1][0]?.attributes["error.message"]).toBeUndefined();
  });

  it("keeps the error slot an error when a payload is also given", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");

    getLogger("trading").error("order failed", { code: 500 }, { orderId: "o-1" });

    const record = emit.mock.calls[0][0];
    expect(record?.attributes["error.message"]).toBe("[object Object]");
    expect(record?.attributes.orderId).toBe("o-1");
  });

  it("treats an array and a non-Error class instance in the error slot as a reason", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    class Rejection {
      toString(): string {
        return "rejected";
      }
    }

    getLogger("trading").error("bad shape", ["a", "b"]);
    getLogger("trading").error("bad class", new Rejection());
    getLogger("trading").error("nothing thrown", null);

    expect(emit.mock.calls[0][0]?.attributes["error.message"]).toBe("a,b");
    expect(emit.mock.calls[1][0]?.attributes["error.message"]).toBe("rejected");
    expect(emit.mock.calls[2][0]?.attributes["error.message"]).toBe("null");
  });

  it("names the type rather than throwing when the reason cannot be described", () => {
    // log.error() runs inside a consumer catch block. A reason whose toString
    // throws must not throw back out of it.
    const onDiagnostic = vi.fn();
    configure({ ...base, onDiagnostic });
    const emit = vi.spyOn(runtime(), "emit");
    class Unprintable {
      toString(): string {
        throw new Error("nope");
      }
    }

    expect(() => {
      getLogger("trading").error("bad reason", new Unprintable());
    }).not.toThrow();

    expect(emit.mock.calls[0][0]?.attributes["error.message"]).toBe("object");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "record.sanitize_failed" }),
    );
  });

  it("costs one integer compare below minLevel, and builds nothing", () => {
    configure({ ...base, minLevel: "WARN" });
    const emit = vi.spyOn(runtime(), "emit");

    getLogger("trading").debug("in a render loop");
    getLogger("trading").error("still built", new Error("boom"));

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("does not build an error record below minLevel either", () => {
    configure({ ...base, minLevel: "FATAL" });
    const emit = vi.spyOn(runtime(), "emit");

    getLogger("trading").error("below the gate", new Error("boom"));

    expect(emit).not.toHaveBeenCalled();
  });

  it("times a synchronous and an asynchronous call", async () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    const log = getLogger("trading");

    expect(log.timeSync("CALC", () => 42)).toBe(42);
    await expect(log.timeAsync("FETCH", () => Promise.resolve("ok"))).resolves.toBe("ok");

    const names = emit.mock.calls.map((call) => call[0]?.attributes["metric.name"]);
    expect(names).toContain("CALC.duration");
    expect(names).toContain("FETCH.duration");
  });
});

describe("public API", () => {
  it("routes every free logging function through the app logger", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");

    trace("t");
    debug("d");
    info("i");
    warn("w");
    error("e", new Error("boom"));
    logAction("ACTION");
    logEvent("EVENT");
    logMetric("metric", 1);

    expect(emit).toHaveBeenCalledTimes(8);
    expect(emit.mock.calls[0][0]?.attributes["app.namespace"]).toBe("app");
  });

  it("times through the free functions", async () => {
    configure(base);

    expect(timeSync("CALC", () => 7)).toBe(7);
    await expect(timeAsync("FETCH", () => Promise.resolve(9))).resolves.toBe(9);
  });

  it("adds and removes context pairs", () => {
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");

    setContext("tenant", "acme");
    setContextMap({ region: "emea", tier: "gold" });
    removeContext("tier");
    info("with context");

    expect(emit.mock.calls[0][0]?.attributes).toMatchObject({
      tenant: "acme",
      region: "emea",
    });
    expect(emit.mock.calls[0][0]?.attributes.tier).toBeUndefined();
  });

  it("starts, reads, tokenizes, adopts and ends a journey", () => {
    configure(base);

    const started = startJourney("order-lifecycle");
    expect(currentJourney()?.id).toBe(started.id);

    const token = getJourneyToken();
    if (token === undefined) {
      throw new Error("a journey in force always has a token");
    }

    endJourney();
    expect(currentJourney()).toBeNull();

    expect(adoptJourney(token)).toBe(true);
    expect(currentJourney()?.id).toBe(started.id);
  });

  it("rotates the trace and hands out matching headers", () => {
    configure(base);
    const before = getTraceHeaders().traceparent;

    startTrace();

    expect(getTraceHeaders().traceparent).not.toBe(before);
  });

  it("exposes the diagnostic counters", () => {
    configure(base);
    configure(base);

    expect(getDiagnosticCounters()["config.reconfigured"]).toBe(1);
  });

  it("writes a captured error through the capture logger to its own runtime", async () => {
    configure(base);
    await ready();
    const emit = vi.spyOn(runtime(), "emit");

    dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom" }));

    expect(emit.mock.calls[0][0]?.attributes["app.namespace"]).toBe("uiobs.capture");
  });

  it("binds a logger held across shutdown to the next runtime", async () => {
    configure(base);
    const held = getLogger("trading");

    await shutdown();
    configure(base);
    const emit = vi.spyOn(runtime(), "emit");
    held.info("after restart");

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a held logger write after shutdown, until configure runs", async () => {
    configure({ ...base, console: "DEBUG" });
    const held = getLogger("trading");
    await shutdown();
    const print = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const printError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    held.info("after shutdown");
    held.error("failed after shutdown", new Error("late"));
    info("top level after shutdown");

    // A new default runtime has no redact and re-adds the listeners the app removed.
    expect(ObservabilityRuntime.current()).toBeNull();
    expect(print).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  it("starts no runtime for an API call after shutdown", async () => {
    configure(base);
    await shutdown();

    setContext("k", "v");
    const journey = startJourney("checkout");
    await flush();

    expect(journey.name).toBe("checkout");
    expect(ObservabilityRuntime.current()).toBeNull();
  });

  it("shuts down cleanly when nothing was ever configured", async () => {
    await expect(shutdown()).resolves.toBeUndefined();
  });
});

describe("runtime version guard", () => {
  const KEY = Symbol.for("ui-observability.runtime");

  /**
   * Pins a runtime of another copy of the library on the page.
   * @param sdkVersion Version of that copy. Undefined is a copy before 0.9.0.
   * @returns The stand-in for the runtime of the other copy.
   */
  function pinOther(sdkVersion?: string) {
    const other = { sdkVersion, destroyed: false, reconfigure: vi.fn() };
    (globalThis as Record<symbol, unknown>)[KEY] = other;
    return other;
  }

  beforeEach(() => {
    // The stopped local runtime of a previous test takes each log call.
    ObservabilityRuntime["local"] = null;
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, KEY);
  });

  it("runs console-only and installs no capture when another version owns the page", async () => {
    const other = pinOther("0.8.5");
    const fetchBefore = globalThis.fetch;
    const handler = vi.fn();

    configure({ ...base, capture: { fetch: true }, onDiagnostic: handler });
    await ready();

    expect(other.reconfigure).not.toHaveBeenCalled();
    expect(runtime()).not.toBe(other);
    expect(runtime().config.endpoint).toBeNull();
    expect(runtime().config.bus.mode).toBe("off");
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "runtime.version_mismatch",
        detail: { found: "0.8.5", own: TELEMETRY_SDK_VERSION },
      }),
    );
  });

  it("names a copy before 0.9.0 when the runtime on the page has no version", async () => {
    pinOther();
    const handler = vi.fn();

    configure({ ...base, onDiagnostic: handler });
    await ready();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { found: "before 0.9.0", own: TELEMETRY_SDK_VERSION } }),
    );
  });

  it("updates its own runtime on a later configure, and leaves the other runtime alone", () => {
    const other = pinOther("0.8.5");
    configure(base);
    const local = runtime();

    configure({ serviceVersion: "2.0.0" });

    expect(runtime()).toBe(local);
    expect(local.config.serviceVersion).toBe("2.0.0");
    expect(other.reconfigure).not.toHaveBeenCalled();
  });

  it("keeps its own runtime console-only on a later configure", async () => {
    pinOther("0.8.5");
    // React StrictMode calls configure() two times.
    configure(base);
    configure({ ...base, transport: vi.fn(), bus: { mode: "auto" } });
    const local = runtime();
    await ready();

    expect(local.config.endpoint).toBeNull();
    expect(local.config.transport).toBeUndefined();
    expect(local.config.bus.mode).toBe("off");
    expect(local["senderLoad"]).toBeUndefined();
  });

  it("starts a console-only runtime on a first log call, and stops only that", async () => {
    const other = Object.assign(pinOther("0.8.5"), { destroy: vi.fn() });

    expect(() => {
      getLogger("blotter").info("loaded");
    }).not.toThrow();

    const local = ObservabilityRuntime.current();
    expect(local).not.toBe(other);
    expect(local?.sdkVersion).toBe(TELEMETRY_SDK_VERSION);

    await shutdown();

    expect(other.destroy).not.toHaveBeenCalled();
  });

  it("ignores a stopped runtime of another version", () => {
    (globalThis as Record<symbol, unknown>)[Symbol.for("ui-observability.stopped")] = {
      sdkVersion: "0.8.5",
    };

    expect(ObservabilityRuntime.stopped()).toBeNull();
  });

  it("stops only its own runtime on shutdown, and starts a new one on the next configure", async () => {
    pinOther("0.8.5");
    configure(base);
    const local = runtime();

    await shutdown();

    expect(ObservabilityRuntime.current()).toBeNull();
    expect(ObservabilityRuntime.stopped()).toBe(local);
    expect((globalThis as Record<symbol, unknown>)[KEY]).toBeDefined();

    configure(base);
    expect(runtime()).not.toBe(local);
  });
});

describe("runtime reconfigure", () => {
  it("reinstalls the capture modules only when the capture section changed", async () => {
    configure(base);
    await ready();
    const install = vi.spyOn(
      runtime() as unknown as { installCaptures: () => Promise<void> },
      "installCaptures",
    );

    configure({ serviceVersion: "2.0.0" });
    expect(install).not.toHaveBeenCalled();

    configure({ capture: { fetch: true } });
    expect(install).toHaveBeenCalledOnce();
  });

  it("starts a new runtime when configure runs during a shutdown", async () => {
    configure(base);
    await ready();
    const old = runtime();

    // destroy() marks the runtime immediately. It clears the global key after its awaits.
    const closing = shutdown();
    configure(base);
    const fresh = runtime();
    await closing;

    expect(fresh).not.toBe(old);
    expect(runtime()).toBe(fresh);
  });

  it("counts a record that has no destination", async () => {
    configure({ ...base, endpoint: null });
    await ready();

    info("console only");

    expect(getDiagnosticCounters()["record.dropped_no_destination"]).toBe(1);
  });
});

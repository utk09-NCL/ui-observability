import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bus } from "../src/bus/bus";
import type { WorkerLike } from "../src/bus/links";
import { ObservabilityRuntime } from "../src/core/runtime";
import type { LogRecord } from "../src/models/log-record";
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

    expect(globalThis.fetch).not.toBe(stubbed);
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

    expect(runtime()["pipeline"]).toBeUndefined();
    expect(runtime().diagnostics.snapshot()["bus.no_owner"]).toBe(1);
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

    // The bus has not resolved, so this is buffered.
    log.info("during boot");
    const journey = startJourney("order-lifecycle");

    await ready();
    const batch = runtime()["pipeline"]?.drainPending();

    expect(batch?.records[0].body).toBe("during boot");
    expect(batch?.records[0].attributes["journey.id"]).toBe(journey.id);
  });

  it("drops the oldest buffered record once the boot buffer is full", () => {
    configure({ ...base, bus: { maxBootBufferRecords: 2 } });
    const log = getLogger("test");

    log.info("first");
    log.info("second");
    log.info("third");

    expect(runtime()["bootBuffer"].map((record: LogRecord) => record.body)).toEqual([
      "second",
      "third",
    ]);
    expect(runtime().diagnostics.snapshot()["record.dropped_boot_buffer_full"]).toBe(1);
  });

  it("caches loggers per namespace instead of allocating per call", () => {
    configure(base);

    expect(getLogger("trading.blotter")).toBe(getLogger("trading.blotter"));
    expect(getLogger("trading.blotter")).not.toBe(getLogger("trading.tickets"));
    expect(getLogger("trading.blotter", { scopedContext: { desk: "eq" } })).not.toBe(
      getLogger("trading.blotter"),
    );
  });

  it("configures implicitly when something logs before configure() was called", () => {
    expect(ObservabilityRuntime.current()).toBeNull();

    info("nobody configured me");

    expect(ObservabilityRuntime.current()).not.toBeNull();
  });

  it("drops a malformed forwarded record instead of losing the batch it lands in", async () => {
    configure(base);
    await ready();

    getLogger("test").info("a good local one");
    runtime()["ingestForwarded"]([{}, null, "nope", forwardedRecord("a good forwarded one")]);

    const batch = runtime()["pipeline"]?.drainPending();
    expect(batch?.records.map((record) => record.body)).toEqual([
      "a good local one",
      "a good forwarded one",
    ]);
    expect(runtime().diagnostics.snapshot()["record.dropped_malformed"]).toBe(3);
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

    const [stored] = runtime()["pipeline"]?.drainPending()?.records ?? [];
    expect(Number(stored.observedTimeUnixNano)).toBeGreaterThan(Number(stored.timeUnixNano));
  });

  it("accepts a direct message from a child, and ignores one after shutdown", async () => {
    configure(base);
    await ready();
    const accept = vi.spyOn(runtime().bus, "acceptDirect");
    const held = runtime();

    held.busAccept({ t: "journey?", from: "child" }, vi.fn());
    expect(accept).toHaveBeenCalledTimes(1);

    await shutdown();
    held.busAccept({ t: "journey?", from: "child" }, vi.fn());
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("attaches a worker, and ignores a registration after shutdown", async () => {
    configure(base);
    await ready();
    const attach = vi.spyOn(runtime().bus, "attachWorker").mockImplementation(() => undefined);
    const held = runtime();
    const worker: WorkerLike = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    registerWorker(worker);
    expect(attach).toHaveBeenCalledWith(worker);

    await shutdown();
    held.registerWorker(worker);
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
    configure(base);
    await ready();
    const applyRemote = vi.spyOn(runtime().journey, "applyRemote");

    runtime().busAccept({ t: "journey", from: "child", journey: null }, vi.fn());

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

    const batch = runtime()["pipeline"]?.drainPending();
    expect(batch?.records.map((record) => record.body)).toEqual(["routed through bus"]);
  });

  it("regenerates the tab id when a broadcast tab conflict arrives", async () => {
    configure(base);
    await ready();
    const before = runtime().identity.tabId;
    const receive = (
      runtime().bus as unknown as {
        receive: (
          message: { t: "tab"; from: string; tabId: string },
          source: { link: "broadcast"; origin: string },
        ) => void;
      }
    ).receive;

    receive({ t: "tab", from: "", tabId: before }, { link: "broadcast", origin: "same-origin" });

    expect(runtime().identity.tabId).not.toBe(before);
  });

  it("installs interactions and web-vitals captures when enabled", async () => {
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
      },
    });
    await ready();

    expect(runtime()["captures"].map((capture: { name: string }) => capture.name)).toEqual(
      expect.arrayContaining(["interactions", "web-vitals"]),
    );
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

    runtime()["reportGap"]({
      batches: 2,
      records: 30,
      reason: "over_capacity",
    });
    runtime()["reportGap"]({
      batches: 1,
      records: 10,
      reason: "over_capacity",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]?.attributes["gap.records"]).toBe(30);
  });

  it("ignores an emit once destroyed", async () => {
    configure(base);
    await ready();
    const held = runtime();
    const record = held.builder.build({
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

describe("runtime routing as a forwarder", () => {
  it("sends one message per task rather than one per record", async () => {
    configure(base);
    await ready();
    vi.spyOn(runtime().bus, "getRole").mockReturnValue("forwarder");
    const send = vi.spyOn(runtime().bus, "sendRecords").mockImplementation(() => undefined);

    const log = getLogger("test");
    log.info("one");
    log.info("two");
    log.info("three");

    expect(send).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toHaveLength(3);
  });

  it("hands the buffer over on flush without waiting for the microtask", async () => {
    configure(base);
    await ready();
    vi.spyOn(runtime().bus, "getRole").mockReturnValue("forwarder");
    const send = vi.spyOn(runtime().bus, "sendRecords").mockImplementation(() => undefined);

    getLogger("test").info("buffered");
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("flushes nothing when a forwarder has nothing buffered", async () => {
    configure(base);
    await ready();
    vi.spyOn(runtime().bus, "getRole").mockReturnValue("forwarder");
    const send = vi.spyOn(runtime().bus, "sendRecords").mockImplementation(() => undefined);

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
    const transport = runtime()["transport"];
    const storage = runtime()["storage"];
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
    const transport = runtime()["transport"];
    const storage = runtime()["storage"];
    if (!transport || !storage) {
      throw new Error("sender was not built");
    }
    vi.spyOn(transport, "send").mockRejectedValue(new Error("offline"));
    vi.spyOn(storage, "save").mockRejectedValue(new Error("quota exceeded"));
    getLogger("test").info("pending");

    await expect(flush()).resolves.toBeUndefined();

    expect(getDiagnosticCounters()["storage.degraded"]).toBe(1);
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
    const storage = runtime()["storage"];
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
    const storage = runtime()["storage"];
    if (!storage) {
      throw new Error("sender was not built");
    }
    vi.spyOn(storage, "count").mockRejectedValue(new Error("store is closed"));

    await expect(getQueueDepth()).resolves.toBe(0);
    expect(getDiagnosticCounters()["storage.degraded"]).toBe(1);
  });
});

describe("OneLogger", () => {
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

  it("clears cached loggers on shutdown, so none holds the dead runtime", async () => {
    configure(base);
    const first = getLogger("trading");

    await shutdown();
    configure(base);

    expect(getLogger("trading")).not.toBe(first);
  });

  it("shuts down cleanly when nothing was ever configured", async () => {
    await expect(shutdown()).resolves.toBeUndefined();
  });
});

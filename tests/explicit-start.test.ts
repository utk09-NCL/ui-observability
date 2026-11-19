// tests/explicit-start.test.ts
//
// The runtime does nothing that leaves the page before the first configure() call that works.
// A log call before it prints with the default console settings and waits in memory, and
// `enabled: false` pauses the captures and the delivery at any time.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receive } from "../src/bus/links";
import {
  BUS_PROTOCOL,
  JOURNEY_STORAGE_KEY,
  JOURNEY_URL_PARAM,
  PROFILE_METRIC_NAME,
  SESSION_ID_KEY,
  TAB_ID_KEY,
} from "../src/constants";
import { Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import type { BusMessage } from "../src/models/bus";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig } from "../src/models/config";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { truncate } from "../src/utils/sanitize";
import {
  addBreadcrumb,
  configure,
  counter,
  createMemoryTransport,
  currentJourney,
  flush,
  getDiagnosticCounters,
  getHealth,
  getLogger,
  getQueueDepth,
  getTraceHeaders,
  info,
  logAction,
  newSession,
  profiler,
  registerWorker,
  rotateSecurityContext,
  setConfigurationLocked,
  setContext,
  shutdown,
  startJourney,
} from "../src/index";

/** Matches the runtime's global key in src/core/runtime.ts. */
const RUNTIME_KEY = Symbol.for("ui-observability.runtime");

/** Settings that keep a test away from storage, captures and the bus. */
const quiet = {
  serviceName: "start",
  storage: { backend: "memory" as const },
  capture: { errors: false, rejections: false },
  bus: { mode: "off" as const },
};

/**
 * The same, with the default bus mode. Startup then waits for the bus role before it loads the
 * sender, so a pause can come first.
 */
const auto = { ...quiet, bus: { mode: "auto" as const } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The warning text after a failed first configure() call. */
const FAILED_START =
  "configure() could not read its options. The library drops each record and installs no capture until a configure() call sets redact to a function or null.";

/**
 * Returns the runtime on this realm's global key.
 * @returns The runtime.
 */
function runtime(): ObservabilityRuntime {
  const current = ObservabilityRuntime.current();
  if (!current) {
    throw new Error("no runtime");
  }
  return current;
}

/** Waits for every chunk load, the startup and one timer turn. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Returns the bodies of the records a memory transport accepted.
 * @param records The accepted records.
 * @returns The bodies in send order.
 */
const bodies = (records: LogRecord[]): string[] => records.map((record) => record.body);

/**
 * Builds a forwarded action record that passes the record check.
 * @param body The action name.
 * @returns The record.
 */
function forwardedAction(body: string): LogRecord {
  return {
    body,
    severityText: "INFO",
    severityNumber: 9,
    timeUnixNano: `${String(Date.now())}000000`,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
    attributes: { "log.type": "action" },
    resource: {},
  };
}

/**
 * Turns this document into a same-origin frame whose parent runtime welcomes it, so a bus in
 * mode "auto" becomes a forwarder.
 */
function welcomingParent(): void {
  const busAccept = (message: BusMessage, reply: Receive): void => {
    if (message.t === "ui-observability.message.hello") {
      const welcome: BusMessage = {
        t: "ui-observability.message.welcome",
        from: "owner",
        to: message.from,
        tabId: message.tabId,
      };
      reply(welcome, { link: "direct", origin: "same-origin" });
    }
  };
  const host = { busAccept, busCanAccept: () => true, protocol: BUS_PROTOCOL };
  const parent = { [RUNTIME_KEY]: host } as unknown as Window & typeof globalThis;
  vi.spyOn(window, "parent", "get").mockReturnValue(parent);
}

describe("a failed first configure()", () => {
  it("refuses a record logged before it, so a later call sends nothing unredacted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const memory = createMemoryTransport();
    getLogger("pay").info("module loaded", { card: "4111" });

    configure(null as never);
    configure({ ...quiet, transport: memory.transport });
    getLogger("pay").info("card 4111");
    await flush();

    expect(memory.records()).toEqual([]);
    expect((await getHealth()).issues).toEqual(["records.refused"]);

    // The call that sets redact ends the refusal. The early record stays dropped.
    configure({ redact: null });
    getLogger("pay").info("plain");
    await flush();

    expect(memory.records().map((record) => record.body)).toEqual(["plain"]);
  });

  it.each([
    ["with no log call before it", false],
    ["after an early log call", true],
  ])("writes no id to web storage %s", (_name, early) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (early) {
      info("module loaded");
    }

    configure(null as never);
    info("after the failure");
    configure({ ...quiet, identity: "memory", redact: null, endpoint: null });

    expect(localStorage.getItem(SESSION_ID_KEY)).toBeNull();
    expect(sessionStorage.getItem(TAB_ID_KEY)).toBeNull();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe("the bus after an early log call", () => {
  it("starts in the mode of the first configure(), so a frame can be a real sender", async () => {
    welcomingParent();
    const memory = createMemoryTransport();
    info("module loaded");
    // An app's first configure() can come long after its first log call.
    await flush();

    configure({ ...quiet, transport: memory.transport, bus: { mode: "sender" } });
    info("after configure");
    await flush();

    expect((await getHealth()).mode).toBe("sender");
    expect(ObservabilityRuntime.current()?.config.bus.mode).toBe("sender");
    expect(memory.records().map((record) => record.body)).toEqual([
      "module loaded",
      "after configure",
    ]);
  });
});

describe("before the first configure()", () => {
  it("holds an early record in memory and starts nothing", async () => {
    const native = vi.fn();
    vi.stubGlobal("fetch", native);
    const listen = vi.spyOn(window, "addEventListener");

    info("module loaded");
    setContext("tenant", "acme");
    addBreadcrumb("opened the blotter");
    startJourney("checkout");
    await vi.dynamicImportSettled();

    expect(runtime()["bus"]).toBeNull();
    expect(runtime()["senderLoad"]).toBeUndefined();
    expect(runtime()["captures"]).toEqual([]);
    expect(listen).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(native);
    expect(native).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    // Context, breadcrumbs, journeys and traces work in memory.
    expect(runtime().context.getAll()).toEqual({ tenant: "acme" });
    expect(
      runtime()
        .breadcrumbs.snapshot()
        .map((crumb) => crumb.message),
    ).toEqual(["module loaded", "opened the blotter"]);
    expect(currentJourney()?.name).toBe("checkout");
    expect(getTraceHeaders().traceparent).toMatch(/^00-[0-9a-f]{32}-/);
    expect(await getHealth()).toMatchObject({
      status: "unconfigured",
      pending: 1,
      mode: "console-only",
      senderReady: false,
    });
  });

  it("prints with the default console settings, and doesn't print a held record again", () => {
    const print = vi.spyOn(console, "info").mockImplementation(() => undefined);
    info("early");
    // The default consoleOutput level is null, so the console is off.
    expect(print).not.toHaveBeenCalled();

    configure({ ...quiet, endpoint: null, consoleOutput: { level: "INFO" } });
    info("later");

    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0].join(" ")).toContain("later");
  });

  it("sends an early record after configure() with the app's hooks and stored identity", async () => {
    // A session from an earlier page. Only the configured runtime may read it.
    localStorage.setItem(SESSION_ID_KEY, JSON.stringify({ id: "earlier", lastSeenAt: Date.now() }));
    const memory = createMemoryTransport();
    const seen: unknown[] = [];
    info("card 4111", { card: "4111" });
    expect(runtime().identity.sessionId).not.toBe("earlier");

    configure({
      ...quiet,
      serviceName: "checkout",
      transport: memory.transport,
      processors: [(record) => ({ ...record, attributes: { ...record.attributes, region: "eu" } })],
      redact: (record) => {
        seen.push(record.resource["service.name"]);
        const { card: _card, ...attributes } = record.attributes;
        return { ...record, body: record.body.replace(/\d+/g, "#"), attributes };
      },
    });
    await flush();

    const [sent] = memory.records();
    expect(sent.body).toBe("card #");
    expect(sent.attributes).toMatchObject({ region: "eu" });
    expect(sent.attributes).not.toHaveProperty("card");
    expect(sent.resource).toMatchObject({
      "service.name": "checkout",
      "session.id": "earlier",
      "tab.id": sessionStorage.getItem(TAB_ID_KEY),
    });
    // redact saw the resource that left, so it could change that too.
    expect(seen).toEqual(["checkout"]);
  });

  it("keeps the ids in memory when the first configure() after an early log sets identity memory", async () => {
    const memory = createMemoryTransport();
    info("early");

    configure({ ...quiet, identity: "memory", transport: memory.transport });
    await flush();

    expect(bodies(memory.records())).toEqual(["early"]);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("takes correlation and otelLoader from the first configure() after an early log call", () => {
    const otelLoader = vi.fn(() => Promise.resolve({ trace: { getActiveSpan: () => undefined } }));
    info("early");
    const before = getDiagnosticCounters()["config.invalid"] ?? 0;

    configure({
      ...quiet,
      endpoint: null,
      otelLoader: otelLoader as never,
      correlation: { traceMaxAgeMs: 5000, sessionIdleMs: 60_000 },
    });

    expect(otelLoader).toHaveBeenCalledTimes(1);
    expect(getDiagnosticCounters()["config.invalid"] ?? 0).toBe(before);
    expect(runtime().tracing["maxAgeMs"]).toBe(5000);
    expect(runtime()["sessionTouch"]["idleMs"]).toBe(60_000);
  });

  it("connects a worker registered before configure() once the bus starts", async () => {
    const worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    registerWorker(worker);
    await vi.dynamicImportSettled();
    expect(worker.addEventListener).not.toHaveBeenCalled();
    expect(runtime()["bus"]).toBeNull();

    configure({ ...quiet, endpoint: null });

    await vi.waitFor(() => {
      expect(worker.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    });
  });

  it("keeps a journey started before configure() and moves it to the configured store", async () => {
    const earlier = { id: "earlier", name: "old", startedAt: Date.now() };
    sessionStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(earlier));
    const journey = startJourney("checkout");
    expect(sessionStorage.getItem(JOURNEY_STORAGE_KEY)).toBe(JSON.stringify(earlier));

    configure({ ...quiet, endpoint: null });
    await flush();

    expect(currentJourney()?.id).toBe(journey.id);
    expect(JSON.parse(sessionStorage.getItem(JOURNEY_STORAGE_KEY) ?? "{}")).toMatchObject({
      id: journey.id,
    });
  });
});

describe("the report of a failed first configure()", () => {
  it("warns on the console and reports config.invalid with the cause", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = vi.spyOn(Diagnostics.prototype, "report");

    configure(null as never);

    expect(warn).toHaveBeenCalledWith(`[ui-observability] ${FAILED_START}`);
    expect(report).toHaveBeenCalledWith(
      "config.invalid",
      FAILED_START,
      undefined,
      expect.any(TypeError),
    );
  });

  it("drops each held record the way the refusal drops a new one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    info("first");
    info("second");

    configure(null as never);

    expect(getDiagnosticCounters()["record.dropped_by_redact"]).toBe(2);
    expect((await getHealth()).pending).toBe(0);
  });

  it("merges a later call's settings, and starts with them at the call that sets redact", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const memory = createMemoryTransport();
    configure(null as never);
    configure({ ...quiet, serviceName: "merged", identity: "memory", transport: memory.transport });
    expect((await getHealth()).status).toBe("unconfigured");

    configure({ redact: null });
    info("first");
    await flush();

    expect(memory.records()[0].resource["service.name"]).toBe("merged");
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect((await getHealth()).status).toBe("ready");
  });
});

describe("enabled: false", () => {
  it("drops the held records after redact when the first configure() pauses", async () => {
    const drops: DropSummary[] = [];
    logAction("pay card 4111");

    configure({
      ...quiet,
      endpoint: null,
      enabled: false,
      redact: (record) => ({ ...record, body: record.body.replace(/\d+/g, "#") }),
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    await settle();

    expect(drops).toEqual([
      { reason: "disabled", records: 1, batchIds: [], journeyIds: [], actions: ["pay card #"] },
    ]);
    expect(await getHealth()).toMatchObject({ status: "disabled", pending: 0 });
    expect(runtime()["running"]).toBe(false);
  });

  it("runs the skipped startup at enabled: true, with the startup settings of the first call", async () => {
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      enabled: false,
      identity: "memory",
      storage: { backend: "memory", namespace: "first" },
    });
    const before = getDiagnosticCounters()["config.invalid"] ?? 0;

    configure({ identity: "storage", storage: { namespace: "second" } });
    expect(getDiagnosticCounters()["config.invalid"]).toBe(before + 2);

    configure({ enabled: true });
    info("after");
    await flush();

    expect(bodies(memory.records())).toEqual(["after"]);
    expect(runtime().config.storage.namespace).toBe("first");
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect((await getHealth()).status).toBe("ready");
  });

  it("pauses the captures and the sender of a running runtime, and resumes both", async () => {
    const native = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", native);
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      capture: { ...quiet.capture, fetch: true },
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    expect(globalThis.fetch).not.toBe(native);

    info("before the pause");
    configure({ enabled: false });
    await settle();

    // The patch is gone, so the page's fetch gets no trace header.
    expect(globalThis.fetch).toBe(native);
    expect(memory.records()).toEqual([]);
    expect(await getHealth()).toMatchObject({ status: "disabled", senderReady: false, pending: 1 });

    configure({ enabled: true });
    await settle();

    expect(bodies(memory.records())).toEqual(["before the pause"]);
    expect(globalThis.fetch).not.toBe(native);
    expect((await getHealth()).senderReady).toBe(true);
  });

  it("drops a record that a child forwards during a pause, after redact", async () => {
    const drops: DropSummary[] = [];
    configure({
      ...quiet,
      endpoint: null,
      redact: (record) => ({ ...record, body: "[masked]" }),
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    configure({ enabled: false });

    runtime()["ingestForwarded"]([forwardedAction("pay card 4111")]);
    await settle();

    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", actions: ["[masked]"] })]);
  });

  it("reports the sender's records in memory as lost at a pagehide during a pause", async () => {
    const drops: DropSummary[] = [];
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      batching: { logFlushIntervalMs: 60_000 },
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    await settle();
    info("in memory");
    configure({ enabled: false });

    dispatchEvent(new Event("pagehide"));
    await settle();

    expect(memory.records()).toEqual([]);
    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", records: 1 })]);

    // A page that comes back from the back/forward cache still has them.
    configure({ enabled: true });
    await settle();
    expect(bodies(memory.records())).toEqual(["in memory"]);
  });

  it("sends nothing at shutdown during a pause, and reports the records in memory", async () => {
    const drops: DropSummary[] = [];
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      transportOnExit: () => true,
      batching: { logFlushIntervalMs: 60_000 },
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    await settle();
    info("in memory");
    configure({ enabled: false });

    await shutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(memory.batches()).toEqual([]);
    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", records: 1 })]);
  });

  it("holds a sender that finishes its load during a pause", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport });
    info("during the load");
    configure({ enabled: false });
    await settle();

    expect(memory.records()).toEqual([]);
    expect(runtime()["sender"]?.["pipeline"].isHeld()).toBe(true);

    configure({ enabled: true });
    await settle();
    expect(bodies(memory.records())).toEqual(["during the load"]);
  });

  it("sends nothing for a rotation with pending flush during a pause", async () => {
    const before = createMemoryTransport();
    const after = createMemoryTransport();
    configure({
      ...quiet,
      transport: before.transport,
      securityContext: { id: "A" },
      batching: { logFlushIntervalMs: 60_000 },
    });
    await settle();
    info("old context");
    configure({ enabled: false });

    await rotateSecurityContext(
      { id: "B", routing: { transport: after.transport } },
      { pending: "flush" },
    );
    await settle();

    expect(before.batches()).toEqual([]);
    expect(after.batches()).toEqual([]);
    expect(runtime()["sender"]).toBeUndefined();
  });
});

describe("review fixes for a pause", () => {
  it("keeps a record when the pause starts before the bus role is known", async () => {
    const drops: DropSummary[] = [];
    const memory = createMemoryTransport();
    configure({
      ...auto,
      transport: memory.transport,
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    info("before the pause");
    configure({ enabled: false });
    await settle();

    expect(memory.records()).toEqual([]);
    expect(drops).toEqual([]);
    // A pause loads no sender, and that isn't a fault.
    expect((await getHealth()).issues).toEqual([]);

    configure({ enabled: true });
    await settle();

    expect(bodies(memory.records())).toEqual(["before the pause"]);
  });

  it("reports a held record once, however many pagehide events come", async () => {
    const drops: DropSummary[] = [];
    configure({
      ...auto,
      transport: createMemoryTransport().transport,
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    info("before the pause");
    configure({ enabled: false });
    await settle();

    dispatchEvent(new Event("pagehide"));
    dispatchEvent(new Event("pagehide"));
    await settle();

    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", records: 1 })]);
  });

  it("carries the live records and the stored batches of a rotation during a pause", async () => {
    const before = createMemoryTransport();
    const after = createMemoryTransport();
    configure({
      ...auto,
      transport: before.transport,
      securityContext: { id: "A" },
      delivery: { retryBaseDelayMs: 0 },
    });
    await settle();
    // A failed send stores the batch under the context A.
    before.respondWith(500);
    info("stored in A");
    await flush();
    info("live in A");
    configure({ enabled: false });

    await rotateSecurityContext(
      { id: "B", routing: { transport: after.transport } },
      { pending: "carry" },
    );
    configure({ enabled: true });
    await settle();

    await vi.waitFor(() => {
      expect(bodies(after.records()).sort()).toEqual(["live in A", "stored in A"]);
    });
  });

  it("sends the open meter interval at the pause and counts nothing during it", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport, metrics: { intervalMs: 600_000 } });
    await settle();
    const orders = counter("orders");
    orders.add(2);

    configure({ enabled: false });
    orders.add(5);
    configure({ enabled: true });
    await settle();

    const points = memory.records().filter((record) => record.body === "orders");
    expect(points.map((point) => point.attributes["metric.value"])).toEqual([2]);
  });

  it("sends the open profiler interval at the pause and times nothing during it", async () => {
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      metrics: { intervalMs: 600_000 },
      profiler: { enabled: true },
    });
    await settle();
    const render = profiler.probe("render");
    render.record(3);

    configure({ enabled: false });
    render.record(7);
    configure({ enabled: true });
    await settle();

    const points = memory.records().filter((record) => record.body === PROFILE_METRIC_NAME);
    expect(points.map((point) => point.attributes["metric.count"])).toEqual([1]);
    expect(points.map((point) => point.attributes["metric.sum"])).toEqual([3]);
  });
});

describe("review fixes before the start", () => {
  it("keeps a session that newSession() started before configure()", () => {
    localStorage.setItem(SESSION_ID_KEY, JSON.stringify({ id: "earlier", lastSeenAt: Date.now() }));
    newSession();
    const chosen = runtime().identity.sessionId;

    configure({ ...quiet, endpoint: null });

    expect(runtime().identity.sessionId).toBe(chosen);
    expect(JSON.parse(localStorage.getItem(SESSION_ID_KEY) ?? "{}")).toMatchObject({ id: chosen });
  });

  it.each([
    ["before configure()", false],
    ["after a failed first configure()", true],
  ])("rejects rotateSecurityContext() %s", async (_name, failed) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (failed) {
      configure(null as never);
    }

    await expect(rotateSecurityContext({ id: "B", routing: {} })).rejects.toThrow(
      "The runtime is not configured. Call configure() before rotateSecurityContext().",
    );
  });

  it("refuses every configure() after setConfigurationLocked(true) and reports config.locked", () => {
    setConfigurationLocked(true);

    configure({ ...quiet, endpoint: null });

    expect(getDiagnosticCounters()["config.locked"]).toBe(1);
    expect(runtime()["tunablesLocked"]).toBe(false);
  });

  it("removes the crumbs of early log calls at the start, and keeps the app's own crumbs", () => {
    info("card 4111");
    logAction("pay 4111");
    addBreadcrumb("opened the blotter");

    configure({ ...quiet, endpoint: null });

    expect(
      runtime()
        .breadcrumbs.snapshot()
        .map((crumb) => crumb.message),
    ).toEqual(["opened the blotter"]);
  });

  it("removes a journey token from the URL when a journey started before configure()", () => {
    history.replaceState(null, "", `/checkout?${JOURNEY_URL_PARAM}=token&tab=2`);
    startJourney("checkout");

    configure({ ...quiet, endpoint: null });

    expect(location.search).toBe("?tab=2");
    history.replaceState(null, "", "/");
  });
});

describe("review fixes for a held record", () => {
  it("applies the configured minLevel, minLevels and sampling, but keeps an action", async () => {
    const memory = createMemoryTransport();
    info("below minLevel");
    getLogger("pay").warn("below the pay level");
    getLogger("trading").warn("sampled out");
    logAction("ORDER_SUBMIT");

    configure({
      ...quiet,
      transport: memory.transport,
      minLevel: "WARN",
      minLevels: { pay: "ERROR" },
      sampling: { rates: { trading: 0 } },
    });
    await flush();

    expect(bodies(memory.records())).toEqual(["ORDER_SUBMIT"]);
    expect(getDiagnosticCounters()).toMatchObject({
      "record.dropped_by_level": 2,
      "record.dropped_by_sampling": 1,
    });
  });

  it("applies the configured body and record size limits", async () => {
    const memory = createMemoryTransport();
    info("x".repeat(1000), { blob: "y".repeat(3000) });

    configure({
      ...quiet,
      transport: memory.transport,
      limits: { maxBodyChars: 256, maxRecordBytes: 1024 },
    });
    await flush();

    const [sent] = memory.records();
    // The same cut that a log call after configure() gets.
    expect(sent.body).toBe(truncate("x".repeat(1000), 256));
    expect(sent.attributes).not.toHaveProperty("blob");
    expect(sent.attributes["uiobs.attributes_dropped"]).toBe(true);
  });

  it("sets page.url again from the configured rules, and never brings the query back", async () => {
    history.replaceState(null, "", "/orders/7?token=abc");
    const memory = createMemoryTransport();
    info("first");

    configure({
      ...quiet,
      transport: memory.transport,
      capture: {
        ...quiet.capture,
        fullUrls: true,
        urlTransform: (url) => url.replace(/\/\d+/, "/:id"),
      },
    });
    await flush();
    history.replaceState(null, "", "/");

    expect(memory.records()[0].attributes["page.url"]).toBe(`${location.origin}/orders/:id`);
  });

  it("empties page.url when the configured metadata.pageUrl is false", async () => {
    const memory = createMemoryTransport();
    info("first");

    configure({ ...quiet, transport: memory.transport, metadata: { pageUrl: false } });
    await flush();

    expect(memory.records()[0].attributes["page.url"]).toBe("");
  });
});

describe("review fixes for the debug buffer and a paused forwarder", () => {
  it("keeps a held record below the configured level for the next error", async () => {
    const memory = createMemoryTransport();
    info("context for the error");

    configure({
      ...quiet,
      transport: memory.transport,
      minLevel: "WARN",
      debugBuffer: { enabled: true },
    });
    getLogger("app").error("failed");
    await flush();

    expect(bodies(memory.records())).toEqual(["context for the error", "failed"]);
    expect(memory.records()[0].attributes["uiobs.debug_buffer"]).toBe(true);
  });

  it.each([
    ["a hook drops it", { redact: () => null }],
    ["the first call pauses", { enabled: false }],
  ])("keeps nothing in the debug buffer when %s", (_name, over) => {
    info("context for the error");

    configure({
      ...quiet,
      endpoint: null,
      minLevel: "WARN",
      debugBuffer: { enabled: true },
      ...over,
    });

    expect(runtime()["debugBuffer"].snapshot()).toEqual([]);
    expect(getDiagnosticCounters()["record.dropped_by_level"]).toBe(1);
  });

  it("drops a child's records after redact when a paused forwarder gets them", async () => {
    const drops: DropSummary[] = [];
    configure({
      ...quiet,
      endpoint: null,
      bus: { mode: "forwarder", sourcePolicy: "trusted-origin" },
      redact: (record) => ({ ...record, body: "[masked]" }),
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    await settle();
    configure({ enabled: false });

    const bus = runtime()["bus"] as unknown as {
      receive: (message: BusMessage, source: { link: string; origin: string }) => void;
    };
    bus.receive(
      {
        t: "ui-observability.message.records",
        from: "child",
        records: [forwardedAction("pay card 4111")],
        routingContextId: runtime().config.securityContext.id,
      },
      { link: "children", origin: location.origin },
    );
    await settle();

    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", actions: ["[masked]"] })]);
  });
});

/**
 * Reads every batch in the runtime's memory store.
 * @returns The stored batches.
 */
async function storedBatches(): Promise<LogBatch[]> {
  return (await runtime()["memoryStorage"]?.take(100)) ?? [];
}

/**
 * Stores one batch under the context A through a failed send, then pauses the runtime.
 * @param over More settings for the first configure() call.
 * @returns The transport of the context A.
 */
async function storedInA(over: Partial<ObservabilityConfig> = {}) {
  const first = createMemoryTransport();
  configure({ ...quiet, transport: first.transport, securityContext: { id: "A" }, ...over });
  await settle();
  first.respondWith(500);
  info("stored in A");
  await flush();
  first.respondWith(200);
  return first;
}

describe("round 2: storage during a pause", () => {
  it("removes the carried batches when a later rotation in the pause discards", async () => {
    await storedInA();
    expect((await storedBatches()).map((batch) => batch.routingContextId)).toEqual(["A"]);
    configure({ enabled: false });

    const routing = { transport: createMemoryTransport().transport };
    await rotateSecurityContext({ id: "B", routing }, { pending: "carry" });
    await rotateSecurityContext({ id: "C", routing }, { pending: "discard" });

    expect(await storedBatches()).toEqual([]);
  });

  it("removes the stored batches of the old context at a logout discard in a first-call pause", async () => {
    const storage = { backend: "localstorage" as const };
    await storedInA({ storage, securityContext: { id: "A", isolation: false } });
    await shutdown();

    // A consent flow: the next page starts paused, and the user logs out before consent.
    const next = createMemoryTransport();
    configure({
      ...quiet,
      storage,
      transport: next.transport,
      enabled: false,
      securityContext: { id: "A", isolation: false },
    });
    await rotateSecurityContext(
      { id: "B", routing: { transport: next.transport } },
      { pending: "discard" },
    );
    configure({ enabled: true });
    await settle();

    expect(await getQueueDepth()).toBe(0);
  });

  it("stores the carried records under the previous context at a later retain in the pause", async () => {
    const drops: DropSummary[] = [];
    configure({
      ...quiet,
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
      batching: { logFlushIntervalMs: 60_000 },
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    await settle();
    info("live in A");
    configure({ enabled: false });

    const routing = { transport: createMemoryTransport().transport };
    await rotateSecurityContext({ id: "B", routing }, { pending: "carry" });
    await rotateSecurityContext({ id: "C", routing }, { pending: "retain" });
    await settle();

    const kept = await storedBatches();
    expect(kept.map((batch) => batch.routingContextId)).toEqual(["B"]);
    expect(kept[0].records.map((record) => record.body)).toEqual(["live in A"]);
    expect(drops).toEqual([]);
  });

  it("moves the carried batches under the previous context at a later retain in the pause", async () => {
    await storedInA();
    configure({ enabled: false });

    const routing = { transport: createMemoryTransport().transport };
    await rotateSecurityContext({ id: "B", routing }, { pending: "carry" });
    await rotateSecurityContext({ id: "C", routing }, { pending: "retain" });

    const kept = await storedBatches();
    expect(kept.map((batch) => batch.routingContextId)).toEqual(["B"]);
    expect(kept[0].records.map((record) => record.body)).toEqual(["stored in A"]);
  });

  it("reports a record once when a discard follows a pagehide in the pause", async () => {
    const drops: DropSummary[] = [];
    configure({
      ...quiet,
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
      batching: { logFlushIntervalMs: 60_000 },
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    await settle();
    info("in memory");
    configure({ enabled: false });
    dispatchEvent(new Event("pagehide"));
    await settle();

    await rotateSecurityContext(
      { id: "B", routing: { transport: createMemoryTransport().transport } },
      { pending: "discard" },
    );
    await settle();

    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", records: 1 })]);
  });

  it("reports a held record once when a failed rotation follows a pagehide in the pause", async () => {
    const drops: DropSummary[] = [];
    configure({
      ...auto,
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
      onDrop: (summary) => {
        drops.push(summary);
      },
    });
    info("held");
    configure({ enabled: false });
    await settle();
    dispatchEvent(new Event("pagehide"));
    await settle();

    // An invalid routing value rejects the rotation, and the rejection closes the delivery.
    await expect(
      rotateSecurityContext({ id: "B", routing: { credentials: "all" as never } }),
    ).rejects.toThrow();
    await settle();

    expect(drops).toEqual([expect.objectContaining({ reason: "disabled", records: 1 })]);
  });
});

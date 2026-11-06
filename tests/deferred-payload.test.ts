import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservabilityRuntime } from "../src/core/runtime";
import {
  configure,
  createMemoryTransport,
  flush,
  getLogger,
  newSession,
  rotateSecurityContext,
  setContext,
  shutdown,
  startJourney,
  startTrace,
} from "../src/index";
import type { LogRecord } from "../src/models/log-record";
import type { ObservabilityConfig } from "../src/models/config";

let idle: IdleRequestCallback;

async function setup(options: ObservabilityConfig = {}) {
  vi.stubGlobal(
    "requestIdleCallback",
    vi.fn((callback: IdleRequestCallback) => {
      idle = callback;
      return 7;
    }),
  );
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const memory = createMemoryTransport();
  configure({
    endpoint: null,
    serviceName: "svc",
    transport: memory.transport,
    storage: "none",
    identity: "memory",
    bus: { mode: "off" },
    payloadMode: "defer",
    capture: { errors: false, rejections: false },
    ...options,
  });
  await flush();
  return { memory, runtime: ObservabilityRuntime.current()!, log: getLogger("app") };
}

afterEach(async () => {
  await shutdown();
  vi.useRealTimers();
});

describe("Deferred logger payloads", () => {
  it("reads payload values and runs privacy hooks in idle time", async () => {
    const redact = vi.fn((record: LogRecord) => {
      record.attributes.token = "[masked]";
      return record;
    });
    const { runtime, log, memory } = await setup({ redact });
    const read = vi.fn(() => "private");
    const payload = {
      get token() {
        return read();
      },
    };
    log.info("before idle", payload);
    expect(read).not.toHaveBeenCalled();
    expect(redact).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledOnce();
    const build = vi.spyOn(runtime.builder, "build");

    idle({ didTimeout: false, timeRemaining: () => 10 });
    expect(build).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    await flush();
    expect(memory.records()[0].attributes.token).toBe("[masked]");
  });

  it("sees payload changes before the build and keeps call metadata", async () => {
    const { log, memory, runtime } = await setup();
    setContext("account", "first");
    startJourney("first journey", { id: "first" });
    const trace = runtime.tracing.resolve();
    const payload = { value: 1 };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    log.info("pending", payload);
    setContext("account", "second");
    startJourney("second journey", { id: "second" });
    startTrace();
    payload.value = 2;
    clock.mockReturnValue(5000);
    await flush();
    expect(memory.records()).toHaveLength(1);
    expect(memory.records()[0]).toMatchObject({
      timeUnixNano: "1000000000",
      traceId: trace.traceId,
      spanId: trace.spanId,
      attributes: { account: "first", "journey.id": "first", value: 2 },
    });
  });

  it("builds error data, breadcrumbs, actions and metric attributes later", async () => {
    const { log, memory } = await setup();
    const attributes = { id: 1 };
    log.logAction("submit", attributes);
    log.logEvent("ready", attributes);
    log.logMetric("count", 2, "1", "gauge", attributes);
    log.error("failed", new Error("failure"), attributes);
    log.fatal("fatal", attributes);
    attributes.id = 2;
    await flush();
    expect(memory.records().map((record) => record.attributes.id)).toEqual([2, 2, 2, 2, 2]);
    expect(memory.records()[3].attributes).toMatchObject({ "error.message": "failure" });
    expect(memory.records()[3].attributes.breadcrumbs).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "submit" })]),
    );
  });

  it("builds debug buffer records at the call even with defer selected", async () => {
    const redact = vi.fn((record: LogRecord) => record);
    const { log, memory } = await setup({ debugBuffer: { enabled: true }, redact });
    const payload = { value: 1 };
    log.debug("before error", payload);
    payload.value = 2;
    expect(redact).toHaveBeenCalledOnce();
    expect(requestIdleCallback).not.toHaveBeenCalled();
    log.error("failed");
    await flush();
    expect(memory.records()[0].attributes).toMatchObject({ value: 1, "uiobs.debug_buffer": true });
  });

  it("drains the old session before newSession changes its resource", async () => {
    const { log, memory, runtime } = await setup();
    const previous = runtime.identity.sessionId;
    log.info("old session");
    newSession();
    log.info("new session");
    await flush();
    expect(memory.records()[0].resource["session.id"]).toBe(previous);
    expect(memory.records()[1].resource["session.id"]).toBe(runtime.identity.sessionId);
  });

  it("keeps old deferred records in the old delivery context", async () => {
    const old = createMemoryTransport();
    const next = createMemoryTransport();
    const { log } = await setup({ transport: old.transport, securityContext: { id: "old" } });
    log.info("old record", { value: 1 });
    await rotateSecurityContext(
      { id: "new", delivery: { transport: next.transport } },
      { pending: "flush" },
    );
    log.info("new record");
    await flush();
    expect(old.records().map((record) => record.body)).toEqual(["old record"]);
    expect(next.records().map((record) => record.body)).toEqual(["new record"]);
  });

  it("drains pending calls during shutdown and cancels the idle callback", async () => {
    const { log, memory } = await setup();
    log.info("last record");
    await shutdown();
    expect(memory.records().map((record) => record.body)).toEqual(["last record"]);
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    log.info("after shutdown");
    idle({ didTimeout: true, timeRemaining: () => 0 });
    expect(memory.records()).toHaveLength(1);
  });

  it("gives deferred records to the synchronous exit transport", async () => {
    const exit = vi.fn(() => true);
    const { log } = await setup({ transportOnExit: exit });
    log.warn("last page record");
    dispatchEvent(new Event("pagehide"));
    expect(exit).toHaveBeenCalledOnce();
    expect(exit.mock.calls[0]).toMatchObject([{ records: [{ body: "last page record" }] }]);
  });

  it("contains a payload that throws when the deferred build reads it", async () => {
    const { log, memory, runtime } = await setup();
    const payload = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("blocked");
        },
      },
    );
    expect(() => log.info("hostile payload", payload)).not.toThrow();
    await flush();
    expect(memory.records()[0].body).toBe("hostile payload");
    expect(runtime.diagnostics.snapshot()["record.sanitize_failed"]).toBeGreaterThan(0);
  });

  it("queues nothing while logging is disabled", async () => {
    const { log, memory } = await setup({ enabled: false });
    const read = vi.fn();
    log.info("disabled", {
      get value() {
        return read();
      },
    });
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await flush();
    expect(memory.records()).toEqual([]);
  });

  it("queues nothing below the level when the console is off", async () => {
    const { log, memory } = await setup({ minLevel: "ERROR" });
    log.debug("below the level");
    expect(requestIdleCallback).not.toHaveBeenCalled();
    await flush();
    expect(memory.records()).toEqual([]);
  });

  it("processes deferred console records below the delivery level", async () => {
    const { log, runtime, memory } = await setup({
      minLevel: "FATAL",
      console: "DEBUG",
      redact: (record) => ({ ...record, body: `screen ${record.body}` }),
    });
    const print = vi.spyOn(runtime.console, "write").mockImplementation(() => undefined);
    const payload = { value: 1 };
    log.debug("debug", payload);
    log.error("error", payload);
    payload.value = 2;
    expect(print).not.toHaveBeenCalled();
    await flush();
    expect(print.mock.calls).toEqual([
      ["app", "DEBUG", "screen debug", expect.objectContaining({ value: 2 })],
      ["app", "ERROR", "screen error", expect.objectContaining({ value: 2 })],
    ]);
    expect(memory.records()).toEqual([]);
  });

  it("keeps copy mode as the default and rejects an invalid mode", async () => {
    const { runtime, log, memory } = await setup({ payloadMode: undefined });
    const payload = { value: 1 };
    log.info("copied", payload);
    payload.value = 2;
    configure({ payloadMode: "later" as never });
    expect(runtime.config.payloadMode).toBe("copy");
    await flush();
    expect(memory.records()[0].attributes.value).toBe(1);
  });
});

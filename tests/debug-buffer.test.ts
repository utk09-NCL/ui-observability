import { describe, expect, it, vi } from "vitest";
import { DebugBuffer } from "../src/core/debug-buffer";
import { ObservabilityRuntime } from "../src/core/runtime";
import { configure, createMemoryTransport, flush, getLogger, newSession } from "../src/index";
import type { DebugBufferPolicy, ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";

const record = (body: string): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 5,
  severityText: "DEBUG",
  body,
  attributes: { "log.type": "log" },
  resource: {},
});

/**
 * Gives a policy getter with three records and no age limit.
 * @param over Settings over the base.
 * @returns The getter.
 */
const policy =
  (over: Partial<DebugBufferPolicy> = {}) =>
  (): DebugBufferPolicy => ({ enabled: true, maxRecords: 3, maxAgeMs: 0, ...over });

describe("DebugBuffer", () => {
  it("keeps the newest records up to maxRecords and marks each one at drain", () => {
    const buffer = new DebugBuffer(policy());

    for (const body of ["1", "2", "3", "4", "5", "6", "7"]) {
      buffer.push(record(body));
    }
    const drained = buffer.drain();

    expect(drained.map((one) => one.body)).toEqual(["5", "6", "7"]);
    expect(drained.map((one) => one.attributes["uiobs.debug_buffer"])).toEqual([true, true, true]);
    expect(buffer.drain()).toEqual([]);
  });

  it("drops a record that is older than maxAgeMs at drain", () => {
    vi.useFakeTimers();
    const buffer = new DebugBuffer(policy({ maxAgeMs: 60_000 }));

    buffer.push(record("old"));
    vi.advanceTimersByTime(60_001);
    buffer.push(record("new"));

    expect(buffer.drain().map((one) => one.body)).toEqual(["new"]);
    vi.useRealTimers();
  });

  it("keeps nothing while it is off, and empties itself when it turns off", () => {
    let enabled = true;
    const buffer = new DebugBuffer(() => ({ enabled, maxRecords: 3, maxAgeMs: 0 }));

    buffer.push(record("kept"));
    enabled = false;
    buffer.push(record("refused"));
    expect(buffer.drain()).toEqual([]);

    enabled = true;
    expect(buffer.drain()).toEqual([]);
  });

  it("gives no snapshot records while it is off or after maxAgeMs", () => {
    vi.useFakeTimers();
    let enabled = true;
    const buffer = new DebugBuffer(() => ({ enabled, maxRecords: 3, maxAgeMs: 1000 }));

    buffer.push(record("old"));
    vi.advanceTimersByTime(1001);
    buffer.push(record("new"));
    expect(buffer.snapshot().map((one) => one.body)).toEqual(["new"]);

    enabled = false;
    expect(buffer.snapshot()).toEqual([]);
    enabled = true;
    expect(buffer.snapshot()).toEqual([]);
    vi.useRealTimers();
  });

  it("keeps a forwarded debug buffer record that sampling would drop", async () => {
    const memory = createMemoryTransport();
    configure({
      endpoint: null,
      serviceName: "svc",
      storage: "memory",
      identity: "memory",
      bus: { mode: "off" },
      transport: memory.transport,
      sampling: { defaultRate: 0 },
    });
    await flush();

    const kept = record("kept");
    kept.attributes["uiobs.debug_buffer"] = true;
    ObservabilityRuntime.current()!["ingestForwarded"]([kept, record("plain")]);
    await flush();

    expect(memory.records().map((one) => one.body)).toEqual(["kept"]);
  });

  it("clears the kept records when the privacy hooks change", async () => {
    const memory = createMemoryTransport();
    configure({
      endpoint: null,
      serviceName: "svc",
      storage: "memory",
      identity: "memory",
      bus: { mode: "off" },
      transport: memory.transport,
      debugBuffer: { enabled: true },
    });
    const log = getLogger("app");

    log.debug("raw");
    configure({ redact: (one) => one });
    log.error("failed", new Error("x"));
    await flush();

    expect(memory.records().map((one) => one.body)).toEqual(["failed"]);
  });

  it("gives the kept records without taking them", () => {
    const buffer = new DebugBuffer(policy());
    buffer.push(record("one"));

    expect(buffer.snapshot().map((one) => one.body)).toEqual(["one"]);
    expect(buffer.drain()).toHaveLength(1);
  });

  it("does not change the record that it kept, and clear removes each record", () => {
    const buffer = new DebugBuffer(policy());
    const kept = record("one");

    buffer.push(kept);
    buffer.drain();
    buffer.push(record("two"));
    buffer.clear();

    expect(kept.attributes).not.toHaveProperty("uiobs.debug_buffer");
    expect(buffer.drain()).toEqual([]);
  });
});

describe("debugBuffer in the runtime", () => {
  /**
   * Configures a runtime that sends to a memory transport.
   * @param over Config values over the base.
   * @returns The memory transport.
   */
  const start = (over: Partial<ObservabilityConfig> = {}) => {
    const memory = createMemoryTransport();
    configure({
      endpoint: null,
      serviceName: "svc",
      storage: "memory",
      identity: "memory",
      bus: { mode: "off" },
      transport: memory.transport,
      debugBuffer: { enabled: true },
      ...over,
    });
    return memory;
  };

  /** Gives the body and the debug marker of each sent record. */
  const sent = (memory: ReturnType<typeof createMemoryTransport>) =>
    memory.records().map((one) => [one.body, one.attributes["uiobs.debug_buffer"]]);

  it("sends the records below minLevel before the next error", async () => {
    const memory = start();
    const log = getLogger("orders");

    log.debug("a");
    log.debug("b");
    log.info("kept");
    log.error("boom");
    await flush();

    expect(sent(memory)).toEqual([
      ["kept", undefined],
      ["a", true],
      ["b", true],
      ["boom", undefined],
    ]);
  });

  it("keeps a sampled-out record after redact, and sends nothing without an error", async () => {
    const memory = start({
      sampling: { defaultRate: 0 },
      redact: (one) => ({ ...one, attributes: { ...one.attributes, token: "[masked]" } }),
    });
    const log = getLogger("orders");

    log.info("sampled out", { token: "abc" });
    await flush();
    expect(memory.records()).toEqual([]);

    log.error("boom");
    await flush();
    expect(sent(memory)).toEqual([
      ["sampled out", true],
      ["boom", undefined],
    ]);
    expect(memory.records()[0].attributes.token).toBe("[masked]");
  });

  it("keeps no record that a processor drops", async () => {
    const memory = start({ processors: [(one) => (one.body === "secret" ? null : one)] });
    const log = getLogger("orders");

    log.debug("secret");
    log.error("boom");
    await flush();

    expect(sent(memory)).toEqual([["boom", undefined]]);
  });

  it("forgets the kept records at a new session", async () => {
    const memory = start();
    const log = getLogger("orders");

    log.debug("old user");
    newSession();
    log.error("boom");
    await flush();

    expect(sent(memory)).toEqual([["boom", undefined]]);
  });

  it("keeps nothing by default", async () => {
    const memory = start({ debugBuffer: undefined });
    const log = getLogger("orders");

    log.debug("a");
    log.error("boom");
    await flush();

    expect(sent(memory)).toEqual([["boom", undefined]]);
  });
});

// tests/hold-buffer.test.ts
//
// The hold buffer's head-keep rule, the buffering.maxHeldRecords key, and the runtime's two
// hold buffers under a startup storm.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUS_MAX_BOOT_BUFFER_ACTIONS,
  BUS_MAX_BOOT_BUFFER_RECORDS,
  HOLD_BUFFER_HEAD_RECORDS,
} from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { HoldBuffer } from "../src/core/hold-buffer";
import { ObservabilityRuntime } from "../src/core/runtime";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { configure, getLogger, logAction, shutdown } from "../src/index";

const HEAD = HOLD_BUFFER_HEAD_RECORDS;
const CAP = BUS_MAX_BOOT_BUFFER_RECORDS;
const ACTION_CAP = BUS_MAX_BOOT_BUFFER_ACTIONS;

const record = (body: string, type: "log" | "action"): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes: { "log.type": type },
  resource: {},
});

const log = (index: number): LogRecord => record(`log ${String(index)}`, "log");

const action = (index: number): LogRecord => record(`action ${String(index)}`, "action");

/**
 * Builds the bodies a run of pushes used, for example `log 3` to `log 6`.
 * @param kind Body prefix.
 * @param from First index.
 * @param to Index after the last one.
 * @returns The bodies in push order.
 */
function bodies(kind: "log" | "action", from: number, to: number): string[] {
  const list: string[] = [];
  for (let index = from; index < to; index++) {
    list.push(`${kind} ${String(index)}`);
  }

  return list;
}

/**
 * Builds a buffer that lists the bodies of its dropped records.
 * @returns The buffer and the dropped bodies, oldest drop first.
 */
function setup(): { buffer: HoldBuffer; dropped: string[] } {
  const dropped: string[] = [];
  const buffer = new HoldBuffer((one) => {
    dropped.push(one.body);
  });
  return { buffer, dropped };
}

const held = (buffer: HoldBuffer): string[] => buffer.records.map((one) => one.body);

describe("HoldBuffer", () => {
  it("keeps every record in arrival order while it is below the cap", () => {
    const { buffer, dropped } = setup();

    buffer.push(log(0), CAP);
    buffer.push(action(0), CAP);
    buffer.push(log(1), CAP);

    expect(held(buffer)).toEqual(["log 0", "action 0", "log 1"]);
    expect(buffer.length).toBe(3);
    expect(dropped).toEqual([]);
  });

  it("drops the oldest record after the head when it is full", () => {
    const { buffer, dropped } = setup();

    for (let index = 0; index <= CAP; index++) {
      buffer.push(log(index), CAP);
    }

    expect(buffer.length).toBe(CAP);
    expect(dropped).toEqual([`log ${String(HEAD)}`]);
    expect(held(buffer).slice(0, HEAD + 1)).toEqual([
      ...bodies("log", 0, HEAD),
      `log ${String(HEAD + 1)}`,
    ]);
  });

  it("keeps the first records and the newest records through a storm", () => {
    const { buffer, dropped } = setup();
    const storm = 2000;

    for (let index = 0; index < storm; index++) {
      buffer.push(log(index), CAP);
    }

    // The head is the first 100, and the rest of the cap is the newest 400.
    expect(held(buffer)).toEqual([
      ...bodies("log", 0, HEAD),
      ...bodies("log", storm - (CAP - HEAD), storm),
    ]);
    // Everything between the head and the newest records went to onDrop, oldest first.
    expect(dropped).toEqual(bodies("log", HEAD, storm - (CAP - HEAD)));
  });

  it("keeps an action through a storm of other records", () => {
    const { buffer, dropped } = setup();

    for (let index = 0; index < HEAD + 5; index++) {
      buffer.push(log(index), CAP);
    }
    buffer.push(action(0), CAP);
    for (let index = HEAD + 5; index < 2000; index++) {
      buffer.push(log(index), CAP);
    }

    expect(held(buffer)).toContain("action 0");
    expect(buffer.length).toBe(CAP + 1);
    expect(dropped.some((body) => body.startsWith("action"))).toBe(false);
  });

  it("gives actions their own cap and their own head", () => {
    const { buffer, dropped } = setup();
    const extra = 5;

    // Logs come first and in between, so the scan for an action has to step over them.
    buffer.push(log(0), CAP);
    for (let index = 0; index < ACTION_CAP + extra; index++) {
      buffer.push(action(index), CAP);
      if (index === 50) {
        buffer.push(log(1), CAP);
      }
    }

    expect(dropped).toEqual(bodies("action", HEAD, HEAD + extra));
    const actions = held(buffer).filter((body) => body.startsWith("action"));
    expect(actions).toEqual([
      ...bodies("action", 0, HEAD),
      ...bodies("action", HEAD + extra, ACTION_CAP + extra),
    ]);
    expect(held(buffer).filter((body) => body.startsWith("log"))).toEqual(["log 0", "log 1"]);
  });

  it("never drops an action to make room for another kind of record", () => {
    const { buffer, dropped } = setup();

    // 150 actions sit in front of the logs, which is more than the head size.
    for (let index = 0; index < HEAD + 50; index++) {
      buffer.push(action(index), CAP);
    }
    for (let index = 0; index <= CAP; index++) {
      buffer.push(log(index), CAP);
    }

    expect(dropped).toEqual([`log ${String(HEAD)}`]);
    expect(buffer.length).toBe(HEAD + 50 + CAP);
  });

  it("reads the cap on each push, so a raised cap holds more", () => {
    const { buffer, dropped } = setup();

    for (let index = 0; index < CAP; index++) {
      buffer.push(log(index), CAP);
    }
    for (let index = CAP; index < CAP + 100; index++) {
      buffer.push(log(index), CAP + 100);
    }

    expect(buffer.length).toBe(CAP + 100);
    expect(dropped).toEqual([]);

    buffer.push(log(CAP + 100), CAP + 100);
    expect(dropped).toEqual([`log ${String(HEAD)}`]);
  });

  it("stops growing when the cap falls below the held count", () => {
    const { buffer, dropped } = setup();

    for (let index = 0; index < CAP; index++) {
      buffer.push(log(index), CAP);
    }
    buffer.push(log(CAP), CAP - 200);
    buffer.push(log(CAP + 1), CAP - 200);

    // One record leaves for each record that comes in. The buffer doesn't shed the rest.
    expect(buffer.length).toBe(CAP);
    expect(dropped).toEqual(bodies("log", HEAD, HEAD + 2));
  });

  it("keeps only the head when the cap leaves no room after it", () => {
    const { buffer, dropped } = setup();

    // The config range forbids a cap this low. The buffer still must not grow or throw.
    for (let index = 0; index < HEAD + 2; index++) {
      buffer.push(log(index), HEAD);
    }

    expect(held(buffer)).toEqual(bodies("log", 0, HEAD));
    expect(dropped).toEqual(bodies("log", HEAD, HEAD + 2));
  });

  it("returns the two kinds in arrival order after each kind dropped records", () => {
    const { buffer } = setup();

    // Alternate the kinds, so only a merge by arrival gives the right order back.
    for (let index = 0; index < HEAD + 3; index++) {
      buffer.push(log(index), HEAD + 2);
      buffer.push(action(index), HEAD + 2);
    }

    const expected: string[] = [];
    for (let index = 0; index < HEAD + 3; index++) {
      // The log cap is 102 here, so the first log after the head is the one that left.
      if (index !== HEAD) {
        expected.push(`log ${String(index)}`);
      }
      expected.push(`action ${String(index)}`);
    }

    expect(held(buffer)).toEqual(expected);
    expect(buffer.take().map((one) => one.body)).toEqual(expected);
  });

  it("starts empty again after take()", () => {
    const { buffer, dropped } = setup();

    for (let index = 0; index < ACTION_CAP; index++) {
      buffer.push(action(index), CAP);
    }
    const taken = buffer.take();

    expect(taken).toHaveLength(ACTION_CAP);
    expect(buffer.length).toBe(0);

    // A stale action count would treat the empty buffer as full and drop on this push.
    buffer.push(action(ACTION_CAP), CAP);
    expect(held(buffer)).toEqual([`action ${String(ACTION_CAP)}`]);
    expect(dropped).toEqual([]);
  });

  it("has an action cap above the head size, so a newer action always has room", () => {
    expect(ACTION_CAP).toBeGreaterThan(HEAD);
  });
});

describe("buffering.maxHeldRecords", () => {
  const input = { endpoint: "https://x/v1/logs", serviceName: "svc" };

  it("defaults to 500 records", () => {
    const config = resolveConfig(input, new Diagnostics(vi.fn(), 0));

    expect(config.buffering.maxHeldRecords).toBe(500);
    expect(config.buffering.maxHeldRecords).toBe(CAP);
  });

  it.each([200, 501, 10_000])("accepts %d", (value) => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const config = resolveConfig({ ...input, buffering: { maxHeldRecords: value } }, diagnostics);

    expect(config.buffering.maxHeldRecords).toBe(value);
    expect(diagnostics.snapshot()["config.invalid"]).toBeUndefined();
  });

  it.each([0, HEAD, 199, 10_001, 600.5, Number.NaN, "600", null])(
    "refuses %s, reports config.invalid and keeps the current value",
    (value) => {
      const diagnostics = new Diagnostics(vi.fn(), 0);
      const before = resolveConfig({ ...input, buffering: { maxHeldRecords: 800 } }, diagnostics);
      const after = resolveConfig(
        { buffering: { maxHeldRecords: value } } as never,
        diagnostics,
        before,
      );

      expect(after.buffering.maxHeldRecords).toBe(800);
      expect(diagnostics.snapshot()["config.invalid"]).toBe(1);
    },
  );

  it("names the key and its range in the report", () => {
    const report = vi.fn();
    resolveConfig({ ...input, buffering: { maxHeldRecords: 50 } }, new Diagnostics(report, 0));

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "config.invalid",
        message: expect.stringContaining("buffering.maxHeldRecords") as string,
      }),
    );
  });

  it("keeps the other buffering keys when only this key is set", () => {
    const config = resolveConfig(
      { ...input, buffering: { maxHeldRecords: 1000 } },
      new Diagnostics(vi.fn(), 0),
    );

    expect(config.buffering).toEqual({
      maxPendingRecords: 10000,
      maxPendingBytes: 16777216,
      maxHeldRecords: 1000,
      overflow: "drop-oldest",
    });
  });
});

describe("the runtime's hold buffers", () => {
  // These tests select the old policy, which permits an endpoint change through configure().
  const base = {
    securityContext: { isolation: false },
    endpoint: "https://x/v1/logs",
    serviceName: "svc",
    minLevel: "TRACE" as const,
  };

  /**
   * The runtime pinned to this realm.
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
    await runtime()["started"];
    expect(runtime()["ready"]).toBe(true);
  }

  const bootBodies = (): string[] =>
    runtime()["bootBuffer"].records.map((one: LogRecord) => one.body);

  beforeEach(() => {
    // The released records reach the sender, and a real request to the test endpoint would fail.
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 204 }))),
    );
  });

  afterEach(async () => {
    await shutdown().catch(() => undefined);
    vi.unstubAllGlobals();
  });

  it("keeps the first error of a startup storm and reports the dropped count", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, onDrop });
    const logger = getLogger("boot");
    const storm = 2000;

    logger.error("first failure");
    for (let index = 0; index < storm; index++) {
      logger.info(`burst ${String(index)}`);
    }

    const kept = bootBodies();
    expect(kept).toHaveLength(CAP);
    expect(kept[0]).toBe("first failure");
    expect(kept[HEAD - 1]).toBe(`burst ${String(HEAD - 2)}`);
    expect(kept[HEAD]).toBe(`burst ${String(storm - (CAP - HEAD))}`);
    expect(kept[CAP - 1]).toBe(`burst ${String(storm - 1)}`);

    const lost = storm + 1 - CAP;
    expect(runtime().diagnostics.snapshot()["record.dropped_boot_buffer_full"]).toBe(lost);
    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "buffer_full", records: lost }),
      );
    });
    // One summary covers the whole storm, so the hook doesn't run once per record.
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("holds a larger startup burst when the app raises the cap", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, onDrop, buffering: { maxHeldRecords: 3000 } });
    const logger = getLogger("boot");

    for (let index = 0; index < 3000; index++) {
      logger.info(`burst ${String(index)}`);
    }

    expect(bootBodies()).toHaveLength(3000);

    logger.info("one too many");
    expect(bootBodies()).toHaveLength(3000);
    expect(runtime().diagnostics.snapshot()["record.dropped_boot_buffer_full"]).toBe(1);
    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "buffer_full", records: 1 }),
      );
    });
  });

  it("uses the app's cap for records that an early log call held before configure()", () => {
    // The first log call starts a runtime with the default cap of 500.
    const logger = getLogger("early");
    for (let index = 0; index < CAP; index++) {
      logger.info(`early ${String(index)}`);
    }
    expect(bootBodies()).toHaveLength(CAP);

    configure({ ...base, buffering: { maxHeldRecords: 1000 } });
    for (let index = 0; index < 500; index++) {
      logger.info(`late ${String(index)}`);
    }

    // A cap copied at construction would stay at 500 and drop every late record's worth.
    expect(bootBodies()).toHaveLength(1000);
    expect(runtime().diagnostics.snapshot()["record.dropped_boot_buffer_full"]).toBeUndefined();
  });

  it("applies a cap that a later configure() changes", () => {
    configure({ ...base, buffering: { maxHeldRecords: 300 } });
    const logger = getLogger("boot");
    for (let index = 0; index < 400; index++) {
      logger.info(`burst ${String(index)}`);
    }
    expect(bootBodies()).toHaveLength(300);

    configure({ buffering: { maxHeldRecords: 400 } });
    for (let index = 400; index < 600; index++) {
      logger.info(`burst ${String(index)}`);
    }

    expect(bootBodies()).toHaveLength(400);
    expect(runtime().config.buffering.maxHeldRecords).toBe(400);
  });

  it("keeps the head of the records that wait for the sender to load", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, endpoint: null, onDrop, buffering: { maxHeldRecords: 250 } });
    await ready();

    // The endpoint starts the sender load, and these records arrive before it ends.
    configure({ endpoint: base.endpoint });
    const logger = getLogger("burst");
    logger.error("first failure");
    for (let index = 0; index < 400; index++) {
      logger.info(`burst ${String(index)}`);
    }

    const pending = runtime()["pendingRecords"].records.map((one: LogRecord) => one.body);
    expect(pending).toHaveLength(250);
    expect(pending[0]).toBe("first failure");
    expect(pending[249]).toBe("burst 399");
    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "buffer_full", records: 151 }),
      );
    });
  });

  it("keeps the first actions and the newest actions at the action cap", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...base, onDrop });

    for (let index = 0; index <= ACTION_CAP; index++) {
      logAction(`action ${String(index)}`);
    }

    const kept = bootBodies();
    expect(kept).toHaveLength(ACTION_CAP);
    expect(kept[0]).toBe("action 0");
    expect(kept[HEAD]).toBe(`action ${String(HEAD + 1)}`);
    expect(kept[ACTION_CAP - 1]).toBe(`action ${String(ACTION_CAP)}`);
    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "buffer_full",
          records: 1,
          actions: [`action ${String(HEAD)}`],
        }),
      );
    });
  });
});

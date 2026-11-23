import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { DropReporter } from "../src/core/drops";
import { EMERGENCY_MAX_ENTRIES } from "../src/constants";
import { isActionRecord } from "../src/models/batch";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { configure, createMemoryTransport, info, warn } from "../src/index";
import { saveToEmergencyQueue } from "../src/storage/emergency-queue";
import { isLibraryConsole } from "../src/utils/library-console";
import { isLibraryRequest } from "../src/utils/library-request";

const record = (body: string, attributes: Record<string, unknown>): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes,
  resource: {},
});

const log = (body: string, journey?: string): LogRecord =>
  record(body, { "log.type": "log", ...(journey === undefined ? {} : { "journey.id": journey }) });

const action = (name: string, journey?: string): LogRecord =>
  record(name, {
    "log.type": "action",
    ...(journey === undefined ? {} : { "journey.id": journey }),
  });

/**
 * Builds a reporter on a config with the given hook.
 * @param onDrop The config's hook.
 * @returns The reporter, its config and its diagnostic events.
 */
function setup(onDrop?: (summary: DropSummary) => void) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const config = resolveConfig(
    { endpoint: "https://x/v1/logs", serviceName: "svc", onDrop },
    diagnostics,
  );
  return { reporter: new DropReporter(config, diagnostics), config, events };
}

describe("DropReporter", () => {
  it("joins the losses of one reason in one task into one summary", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const { reporter } = setup(onDrop);

    reporter.add("buffer_full", [log("a", "j1"), action("submit order", "j1")]);
    reporter.add("buffer_full", [action("cancel order", "j2")]);
    reporter.add("expired", [log("b")], ["batch-1"]);
    expect(onDrop).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(onDrop.mock.calls).toEqual([
      [
        {
          reason: "buffer_full",
          records: 3,
          batchIds: [],
          journeyIds: ["j1", "j2"],
          actions: ["submit order", "cancel order"],
        },
      ],
      [{ reason: "expired", records: 1, batchIds: ["batch-1"], journeyIds: [], actions: [] }],
    ]);
  });

  it("keeps at most 20 different values in each list", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const { reporter } = setup(onDrop);
    const records = Array.from({ length: 30 }, (_unused, i) =>
      action(`a${String(i)}`, `j${String(i)}`),
    );

    reporter.add(
      "rejected",
      [...records, ...records],
      records.map((_unused, i) => `b${String(i)}`),
    );
    await Promise.resolve();

    const [summary] = onDrop.mock.calls[0];
    expect(summary.records).toBe(60);
    expect(summary.batchIds).toHaveLength(20);
    expect(summary.journeyIds).toHaveLength(20);
    expect(summary.actions).toEqual(records.slice(0, 20).map((one) => one.body));
  });

  it("counts a loss that the reporter can't name records for", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const { reporter } = setup(onDrop);

    reporter.add("partially_rejected", [], ["batch-1"], 3);
    await Promise.resolve();

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({
      reason: "partially_rejected",
      records: 3,
      batchIds: ["batch-1"],
      journeyIds: [],
      actions: [],
    });
  });

  it("ignores a loss with no records and no batch ids", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const { reporter } = setup(onDrop);

    reporter.add("load_failed", []);
    reporter.add("expired", [], ["b1"]);
    await Promise.resolve();

    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ reason: "expired", records: 0 }));
  });

  it("keeps nothing without an onDrop hook", async () => {
    const { reporter, config } = setup();

    reporter.add("expired", [log("a")]);
    // A hook added later gets nothing from the time before it.
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    config.onDrop = onDrop;
    await Promise.resolve();

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("reports a hook that throws and still gives the next summary", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>(() => {
      throw new Error("hook");
    });
    const { reporter, events } = setup(onDrop);

    reporter.add("quota", [log("a")]);
    reporter.add("expired", [log("b")]);
    await Promise.resolve();

    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.code)).toEqual(["handler.threw", "handler.threw"]);
  });

  it("does not report a loss that the hook causes", async () => {
    // A hook that logs can fill the buffer again, and reporting that loss would start a loop.
    const hook: { again?: () => void } = {};
    const onDrop = vi.fn<(summary: DropSummary) => void>(() => {
      hook.again?.();
    });
    const { reporter } = setup(onDrop);
    hook.again = () => {
      reporter.add("buffer_full", [log("again")]);
    };

    reporter.add("buffer_full", [log("a")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("reports nothing when configure() removes the hook before the report", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const { reporter, config } = setup(onDrop);

    reporter.add("expired", [log("a")]);
    config.onDrop = undefined;
    await Promise.resolve();

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("reads a stored record with no attributes as a record that is not an action", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const { reporter } = setup(onDrop);

    reporter.add("expired", [{ body: "old shape" } as never]);
    await Promise.resolve();

    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ records: 1, journeyIds: [], actions: [] }),
    );
  });

  it("counts a corrupt stored record and keeps a body that is not a string out of actions", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const { reporter } = setup(onDrop);

    // Another script on the origin can write any value under the storage prefix.
    const corrupt = [null, { body: 42, attributes: { "log.type": "action" } }] as never[];
    reporter.add("expired", corrupt);
    await Promise.resolve();

    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ records: 2, journeyIds: [], actions: [] }),
    );
  });

  it("runs the hook inside the library request scope and the library console scope", async () => {
    // A request or console line from the hook must not become a record. That record could evict
    // one more stored batch, and the hook would run again.
    const scopes: boolean[] = [];
    const { reporter } = setup(() => {
      scopes.push(isLibraryRequest(), isLibraryConsole());
    });

    reporter.add("expired", [log("a")]);
    await Promise.resolve();

    expect(scopes).toEqual([true, true]);
  });
});

describe("isActionRecord", () => {
  it("reads a null record as a record that is not an action", () => {
    expect(isActionRecord(null as never)).toBe(false);
  });
});

describe("an onDrop hook that logs while the page leaves", () => {
  /** Turns of the microtask queue. A closing document runs no timer, so nothing else runs. */
  const TURNS = 400;

  /** The hook stops logging after this many calls, so a cycle that never ends still ends here. */
  const CAP = 50;

  /** A correct fix lets a cycle run a few turns at most. */
  const BOUND = 10;

  /** Waits for the chunk loads and the startup, with the real timers. */
  async function ready(): Promise<void> {
    await vi.dynamicImportSettled();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /** Gives the microtask queue its turns, and no timer. */
  async function turns(): Promise<void> {
    for (let i = 0; i < TURNS; i++) {
      await Promise.resolve();
    }
  }

  /** Leaves an emergency queue that is full, so each park drops the oldest entry. */
  // Runs after startup, because the startup import empties the queue. A current createdAt keeps
  // each entry from expiring, otherwise the queue isn't full at pagehide.
  function fillEmergencyQueue(): void {
    for (let i = 0; i < EMERGENCY_MAX_ENTRIES; i++) {
      saveToEmergencyQueue(
        {
          id: `old-${String(i)}`,
          createdAt: Date.now() + i,
          attempts: 0,
          records: [log("parked")],
        },
        new Diagnostics(vi.fn(), 0),
      );
    }
  }

  const base = {
    serviceName: "svc",
    endpoint: "https://x/v1/logs",
    securityContext: { isolation: false },
    bus: { mode: "off" as const },
    capture: { errors: false, rejections: false },
  };

  it.each([
    [
      "a custom transport without transportOnExit on memory storage",
      () => ({ transport: createMemoryTransport().transport }),
      (): void => undefined,
    ],
    [
      "a headers function with no result yet on memory storage",
      () => ({ headers: () => ({ authorization: "Bearer t1" }) }),
      (): void => undefined,
    ],
    [
      "a full emergency queue",
      // With credentials include the exit send is a beacon, and the refused beacon parks the batch.
      () => ({ storage: { backend: "localstorage" as const }, credentials: "include" as const }),
      fillEmergencyQueue,
    ],
  ])("ends the cycle after a few late flushes with %s", async (_name, extra, afterStart) => {
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 204 }))),
    );
    let calls = 0;
    configure({
      ...base,
      storage: { backend: "memory" },
      ...extra(),
      onDrop: (summary) => {
        calls++;
        if (calls < CAP) {
          warn("records lost", { reason: summary.reason });
        }
      },
    });
    await ready();
    afterStart();

    dispatchEvent(new Event("pagehide"));
    info("late record");
    await turns();

    // Each late flush loses a batch, the hook logs, and the next late flush loses that record.
    // The page is closing, so the cycle never reaches a task boundary to stop.
    expect(calls).toBeLessThanOrEqual(BOUND);
  });

  it("ends the cycle after a few late flushes when each exit send reports", async () => {
    // With diagnostics.records and no throttle, the report of a failed exit send is a record.
    let calls = 0;
    const transportOnExit = vi.fn(() => {
      calls++;
      if (calls < CAP) {
        throw new Error("the exit hook failed");
      }
      return true;
    });
    configure({
      ...base,
      transport: createMemoryTransport().transport,
      transportOnExit,
      storage: { backend: "memory" },
      diagnostics: { records: true, throttleMs: 0 },
    });
    await ready();

    dispatchEvent(new Event("pagehide"));
    info("late record");
    await turns();

    expect(calls).toBeLessThanOrEqual(BOUND);
  });
});

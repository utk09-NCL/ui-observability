import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { DropReporter } from "../src/core/drops";
import { isActionRecord } from "../src/models/batch";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
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
 * @param onDrop Hook of the config.
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
    // A hook that arrives later gets nothing from the time before it.
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
    // A hook that logs can fill the buffer again. A report of that loss starts a loop.
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

  it("gives nothing when configure() removes the hook before the report", async () => {
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
    // A request or a console line of the hook must not become a record. That record can evict
    // one more stored batch. The hook then runs again.
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

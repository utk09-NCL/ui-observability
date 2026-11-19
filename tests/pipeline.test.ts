import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CEILING_MAX_PER_WINDOW, STORAGE_DEADLINE_MS } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { LogPipeline, type StreamName, type StreamOptions } from "../src/core/pipeline";
import type { LogBatch } from "../src/models/batch";
import type { LogRecord } from "../src/models/log-record";
import type { GapReporter, StorageAdapter } from "../src/models/storage";
import { createStorage } from "../src/storage/factory";
import { MemoryStorage } from "../src/storage/memory-storage";
import { TransportError } from "../src/transport/errors";
import { RetryEngine, type StoreOutcome } from "../src/transport/retry-engine";

const LOG_FLUSH_MS = 1000;
const METRIC_FLUSH_MS = 5000;
const BATCH_SIZE = 100;

/** Enough to carry a flush timer over, whichever stream armed it. */
const PAST_LOG_FLUSH_MS = LOG_FLUSH_MS + 100;
const PAST_METRIC_FLUSH_MS = METRIC_FLUSH_MS - LOG_FLUSH_MS + 100;

const limits = { maxBatches: 100, maxAgeMs: 60_000, maxAttempts: 5 };

type Send = (batch: LogBatch, onKeepalive?: () => void) => Promise<void>;

const record = (over: Partial<LogRecord> = {}): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "x",
  attributes: { "log.type": "system", "app.namespace": "trading" },
  resource: {},
  ...over,
});

const metric = (over: Partial<LogRecord> = {}): LogRecord =>
  record({ attributes: { "log.type": "metric", "app.namespace": "trading" }, ...over });

/** A real MemoryStorage, stubbed transport and retry, and a pipeline wired to all three. */
const DEFAULT_STREAMS: Record<StreamName, StreamOptions> = {
  logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: BATCH_SIZE },
  metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
  traces: { flushIntervalMs: LOG_FLUSH_MS, batchSize: BATCH_SIZE },
};

const setup = (
  override?: StorageAdapter,
  streams: Partial<Record<StreamName, StreamOptions>> = {},
) => {
  const handler = vi.fn<(event: DiagnosticEvent) => void>();
  const diagnostics = new Diagnostics(handler, 0);

  const send = vi.fn<Send>(() => Promise.resolve());
  const throttledForMs = vi.fn<(batch: LogBatch) => number>(() => 0);
  const storage = override ?? new MemoryStorage(limits);
  const nudge = vi.fn<() => void>();

  // This stub takes the place of the engine's classification. retry-engine.test.ts proves the
  // split and the outcomes, so here the stub only stores, nudges and says "stored".
  const storeFailed = vi.fn<(batch: LogBatch, error: unknown) => Promise<StoreOutcome>>(
    async (failed) => {
      await storage.save(failed);
      nudge();
      return "stored";
    },
  );

  const pipeline = new LogPipeline(
    { send, throttledForMs },
    storage,
    { nudge, storeFailed } as unknown as RetryEngine,
    diagnostics,
    { ...DEFAULT_STREAMS, ...streams },
  );

  return { pipeline, send, throttledForMs, storage, nudge, storeFailed, diagnostics, handler };
};

/** The texts of the send-failure reports that reached the handler, in order. */
const sendFailureTexts = (handler: ReturnType<typeof setup>["handler"]): string[] =>
  handler.mock.calls
    .map(([event]) => event)
    .filter((event) => event.code === "transport.http_error")
    .map((event) => event.message);

/** The texts of the throttle reports that reached the handler, in order. */
const throttleTexts = (handler: ReturnType<typeof setup>["handler"]): string[] =>
  handler.mock.calls
    .map(([event]) => event)
    .filter((event) => event.code === "transport.throttled")
    .map((event) => event.message);

/** The reports for a store call that threw or ran past its deadline, so its result is unknown. */
const SEND_FAILED_UNCONFIRMED_TEXT =
  "The send failed. The library could not confirm that storage kept the batch. " +
  "The library sends again only the records that are in storage.";
const THROTTLED_UNCONFIRMED_TEXT =
  "The server throttles requests. The library could not confirm that storage kept the batch. " +
  "The library sends the batch later only if it is in storage.";

/** The record bodies of one send, in order. */
const bodiesOf = (batch: LogBatch): string[] => batch.records.map((one) => one.body);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LogPipeline", () => {
  it("emits one batch per flush interval and caps it at batchSize", async () => {
    const { pipeline, send } = setup();

    for (let i = 0; i < 250; i++) {
      pipeline.push(record());
    }
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([batch]) => batch.records.length)).toEqual([100, 100, 50]);
    pipeline.destroy();
  });

  it("adds the clock offset to a log and a span record but not to a metric point", async () => {
    const send = vi.fn<Send>(() => Promise.resolve());
    const clockOffset = vi.fn<() => number | undefined>(() => undefined);
    const pipeline = new LogPipeline(
      { send, throttledForMs: () => 0 },
      new MemoryStorage(limits),
      { nudge: vi.fn(), storeFailed: vi.fn() } as unknown as RetryEngine,
      new Diagnostics(vi.fn(), 0),
      DEFAULT_STREAMS,
      undefined,
      undefined,
      undefined,
      clockOffset,
    );
    const span = record({ body: "span", attributes: { "log.type": "span" } });

    pipeline.push(record({ body: "before" }));
    clockOffset.mockReturnValue(-1500);
    pipeline.push(record({ body: "after" }));
    pipeline.push(span);
    pipeline.push(metric({ body: "metric" }));
    await vi.advanceTimersByTimeAsync(PAST_METRIC_FLUSH_MS + LOG_FLUSH_MS);

    const sent = send.mock.calls.flatMap(([batch]) => batch.records);
    const offsets = sent.map((one) => [one.body, one.attributes["uiobs.clock_offset_ms"]]);
    expect(Object.fromEntries(offsets)).toEqual({
      before: undefined,
      after: -1500,
      span: -1500,
      metric: undefined,
    });
    expect(sent).toHaveLength(4);
    // The pipeline copies the attributes, so the caller's record keeps no offset.
    expect(span.attributes).not.toHaveProperty("uiobs.clock_offset_ms");
    pipeline.destroy();
  });

  it("stamps every record with the time this context saw it", async () => {
    const { pipeline, send } = setup();

    pipeline.push(record({ observedTimeUnixNano: undefined }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send.mock.calls[0][0].records[0].observedTimeUnixNano).toMatch(/^\d+000000$/);
    pipeline.destroy();
  });

  it("batches metrics and logs separately, on their own schedules", async () => {
    const { pipeline, send } = setup();

    pipeline.push(record({ body: "log" }));
    pipeline.push(metric({ body: "metric" }));

    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);
    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["log"]);

    await vi.advanceTimersByTimeAsync(PAST_METRIC_FLUSH_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(bodiesOf(send.mock.calls[1][0])).toEqual(["metric"]);
    pipeline.destroy();
  });

  it("hands each stream to the exit flush as its own batch and clears them", () => {
    const { pipeline } = setup();
    pipeline.push(record({ body: "log" }));
    pipeline.push(metric({ body: "metric" }));

    const batches = pipeline.drainForExit();

    // A mixed batch would send a metric to the logs endpoint.
    expect(batches.map((batch) => batch.records.map((one) => one.body))).toEqual([
      ["metric"],
      ["log"],
    ]);
    expect(pipeline.drainForExit()).toEqual([]);
    pipeline.destroy();
  });

  it("sorts the records of the batches in flight by kind for the exit flush", () => {
    const { pipeline, send } = setup();
    send.mockImplementation(() => new Promise<void>(() => undefined));
    pipeline.push(metric({ body: "metric in flight" }));
    // The flush queues the batch, and a queued batch counts as in flight.
    void pipeline.flushPending();
    pipeline.push(record({ body: "log" }));

    const batches = pipeline.drainForExit();

    expect(batches.map((batch) => batch.records.map((one) => one.body))).toEqual([
      ["metric in flight"],
      ["log"],
    ]);
    pipeline.destroy();
  });

  it("keeps sending after one batch fails, rather than tearing down the stream", async () => {
    const { pipeline, send } = setup();
    send.mockRejectedValueOnce(new Error("boom"));

    pipeline.push(record({ body: "first" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);
    pipeline.push(record({ body: "second" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).toHaveBeenCalledTimes(2);
    pipeline.destroy();
  });

  it("counts the live delivery when it stores a batch the transport refused", async () => {
    // A batch stored with zero attempts would get one request more than the maxAttempts limit,
    // and every X-UiObs-Attempt header would show one attempt too few.
    const { pipeline, send, storage, nudge, diagnostics } = setup();
    send.mockRejectedValueOnce(new Error("network"));

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    const stored = await storage.take(1);
    expect(stored).toHaveLength(1);
    expect(stored[0].attempts).toBe(1);
    expect(nudge).toHaveBeenCalled();
    expect(diagnostics.snapshot()["transport.http_error"]).toBe(1);
    pipeline.destroy();
  });

  it("hands a refused batch to the retry engine to classify", async () => {
    // A store here keeps an oversized batch that only the drain can split.
    const { pipeline, send, storeFailed } = setup();
    const refused = new TransportError("too_large", "413", 413);
    send.mockRejectedValueOnce(refused);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(storeFailed).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 }), refused);
    pipeline.destroy();
  });

  it("stores without spending an attempt while the server is throttling us", async () => {
    // The pipeline sent nothing, so no attempt counts against the batch.
    const { pipeline, send, throttledForMs, storage, nudge, handler } = setup();
    throttledForMs.mockReturnValue(5000);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).not.toHaveBeenCalled();
    const stored = await storage.take(1);
    expect(stored[0].attempts).toBe(0);
    expect(nudge).toHaveBeenCalled();
    expect(throttleTexts(handler)).toEqual([
      "The server throttles requests. The pipeline stored the batch and did not send it.",
    ]);
    pipeline.destroy();
  });

  it("doesn't claim it stored a throttled batch when the app runs without storage", async () => {
    const onGap = vi.fn<GapReporter>();
    const none = await createStorage("none", "db", limits, new Diagnostics(vi.fn(), 0), onGap);
    const { pipeline, send, throttledForMs, nudge, handler } = setup(none);
    throttledForMs.mockReturnValue(5000);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).not.toHaveBeenCalled();
    expect(onGap).toHaveBeenCalledWith({ batches: 1, records: 1, reason: "not_stored" }, [
      expect.objectContaining({ attempts: 0 }),
    ]);
    expect(throttleTexts(handler)).toEqual([
      "The server throttles requests, and storage did not keep the batch. " +
        "The library drops the batch.",
    ]);
    // Storage holds nothing, so an earlier drain would find nothing to send.
    expect(nudge).not.toHaveBeenCalled();
    pipeline.destroy();
  });

  it("reports an unconfirmed store when the save of a throttled batch throws", async () => {
    const save = vi.fn<(batch: LogBatch) => Promise<boolean>>(() =>
      Promise.reject(new Error("quota")),
    );
    const { pipeline, throttledForMs, nudge, diagnostics, handler } = setup({
      save,
    } as unknown as StorageAdapter);
    throttledForMs.mockReturnValue(5000);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(diagnostics.snapshot()["storage.degraded"]).toBe(1);
    // A rejected save says nothing about what storage holds, so the report can't say "drops".
    expect(throttleTexts(handler)).toEqual([THROTTLED_UNCONFIRMED_TEXT]);
    expect(nudge).not.toHaveBeenCalled();
    pipeline.destroy();
  });

  it("reports an unconfirmed store when a throttled batch's save passes its deadline", async () => {
    // The save is still running at the deadline, so it can still put the batch in storage.
    const save = vi.fn<(batch: LogBatch) => Promise<boolean>>(() => new Promise(() => undefined));
    const { pipeline, throttledForMs, nudge, diagnostics, handler } = setup({
      save,
    } as unknown as StorageAdapter);
    throttledForMs.mockReturnValue(5000);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(throttleTexts(handler)).toEqual([]);

    await vi.advanceTimersByTimeAsync(STORAGE_DEADLINE_MS);

    expect(diagnostics.snapshot()["storage.degraded"]).toBe(1);
    expect(throttleTexts(handler)).toEqual([THROTTLED_UNCONFIRMED_TEXT]);
    expect(nudge).not.toHaveBeenCalled();
    pipeline.destroy();
  });

  it.each([
    ["brings the drain forward when storage keeps the record", true, 1],
    ["leaves the drain alone when storage doesn't keep the record", false, 0],
  ] as const)("on a persist overflow, %s", async (_name, kept, nudges) => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const policy = resolveConfig(
      {
        endpoint: "https://x/v1/logs",
        serviceName: "svc",
        buffering: { maxPendingRecords: 1, overflow: "persist" },
      },
      diagnostics,
    );
    const save = vi.fn<(batch: LogBatch) => Promise<boolean>>(() => Promise.resolve(kept));
    const nudge = vi.fn<() => void>();
    const pipeline = new LogPipeline(
      { send: vi.fn<Send>(() => Promise.resolve()), throttledForMs: () => 0 },
      { save } as unknown as StorageAdapter,
      { nudge, storeFailed: vi.fn() } as unknown as RetryEngine,
      diagnostics,
      DEFAULT_STREAMS,
      undefined,
      policy,
    );

    pipeline.push(record({ body: "held" }));
    pipeline.push(record({ body: "overflow" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledOnce();
    expect(bodiesOf(save.mock.calls[0][0])).toEqual(["overflow"]);
    expect(nudge).toHaveBeenCalledTimes(nudges);
    pipeline.destroy();
  });

  it("stores only the batches of the kind whose endpoint throttles", async () => {
    // A throttled metricsEndpoint must not hold back the log batches.
    const { pipeline, send, throttledForMs, storage } = setup();
    throttledForMs.mockImplementation((sent?: LogBatch) =>
      sent?.records[0].attributes["log.type"] === "metric" ? 5000 : 0,
    );

    pipeline.push(record({ body: "log" }));
    pipeline.push(metric({ body: "point" }));
    await vi.advanceTimersByTimeAsync(METRIC_FLUSH_MS + 100);

    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["log"]);
    expect(bodiesOf((await storage.take(1))[0])).toEqual(["point"]);
    pipeline.destroy();
  });

  it("reports rather than nudging when the store refuses the batch", async () => {
    const save = vi.fn<(batch: LogBatch) => Promise<boolean>>(() =>
      Promise.reject(new Error("quota")),
    );
    const { pipeline, send, nudge, diagnostics, handler } = setup({
      save,
    } as unknown as StorageAdapter);
    send.mockRejectedValueOnce(new Error("network"));

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(save).toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()["storage.degraded"]).toBe(1);
    // A store call that threw says nothing about what storage holds, so the report can't
    // promise a resend and can't say "drops".
    expect(sendFailureTexts(handler)).toEqual([SEND_FAILED_UNCONFIRMED_TEXT]);
    pipeline.destroy();
  });

  it("reports an unconfirmed store when a failed batch's save passes its deadline", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const diagnostics = new Diagnostics(handler, 0);
    const config = resolveConfig(
      { endpoint: "https://x/v1/logs", serviceName: "svc" },
      diagnostics,
    );
    // The save is still running at the deadline, so it can still put the batch in storage.
    const save = vi.fn<(batch: LogBatch) => Promise<boolean>>(() => new Promise(() => undefined));
    const storage = { save } as unknown as StorageAdapter;
    const send = vi.fn<Send>(() => Promise.reject(new Error("network")));
    const transport = { send, throttledForMs: () => 0 };
    // The real engine, because the deadline on this path is the engine's.
    const retry = new RetryEngine(storage, transport, diagnostics, config);
    const nudge = vi.spyOn(retry, "nudge");
    const pipeline = new LogPipeline(transport, storage, retry, diagnostics, DEFAULT_STREAMS);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(save).toHaveBeenCalledOnce();
    expect(sendFailureTexts(handler)).toEqual([]);

    await vi.advanceTimersByTimeAsync(STORAGE_DEADLINE_MS);

    expect(diagnostics.snapshot()["storage.degraded"]).toBe(1);
    expect(sendFailureTexts(handler)).toEqual([SEND_FAILED_UNCONFIRMED_TEXT]);
    expect(nudge).not.toHaveBeenCalled();
    pipeline.destroy();
    retry.stop();
  });

  it.each([
    [
      "says the library stored the batch and sends it again",
      "stored",
      "The send failed. The library stored the batch and sends it again later.",
    ],
    [
      "says the library stored the batch in two parts",
      "split",
      "The send failed. The library stored the batch in two parts and sends them again later.",
    ],
    [
      "says the library drops a batch that another send can't deliver",
      "rejected",
      "The send failed, and another send would fail too. The library drops the batch.",
    ],
    [
      "says the library drops the records that storage didn't keep",
      "not_stored",
      "The send failed, and storage did not keep the batch. " +
        "The library drops the records that are not in storage.",
    ],
  ] as const)("after a failed send, %s", async (_name, outcome, text) => {
    const { pipeline, send, storeFailed, handler } = setup();
    const failure = new Error("network");
    send.mockRejectedValueOnce(failure);
    storeFailed.mockResolvedValueOnce(outcome);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(sendFailureTexts(handler)).toEqual([text]);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "transport.http_error", cause: failure }),
    );
    pipeline.destroy();
  });

  it("doesn't claim a retry for a failed send when the app runs without storage", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const diagnostics = new Diagnostics(handler, 0);
    const config = resolveConfig(
      { endpoint: "https://x/v1/logs", serviceName: "svc" },
      diagnostics,
    );
    const onGap = vi.fn<GapReporter>();
    const none = await createStorage("none", "db", limits, diagnostics, onGap);
    const send = vi.fn<Send>(() => Promise.reject(new Error("network")));
    const transport = { send, throttledForMs: () => 0 };
    // The real engine and the real "none" adapter, because the finding was in how they meet.
    const retry = new RetryEngine(none, transport, diagnostics, config);
    const pipeline = new LogPipeline(transport, none, retry, diagnostics, DEFAULT_STREAMS);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(onGap).toHaveBeenCalledWith({ batches: 1, records: 1, reason: "not_stored" }, [
      expect.objectContaining({ attempts: 1 }),
    ]);
    expect(sendFailureTexts(handler)).toEqual([
      "The send failed, and storage did not keep the batch. " +
        "The library drops the records that are not in storage.",
    ]);
    pipeline.destroy();
    retry.stop();
  });

  it("contains a dispatch that rejects instead of stopping delivery", async () => {
    // dispatch must never reject. If it does, the pipeline loses the batch and reports it, and
    // the records after it still go to the transport.
    const { pipeline, send, throttledForMs, diagnostics } = setup();
    throttledForMs.mockImplementationOnce(() => {
      throw new Error("clock gone");
    });

    pipeline.push(record({ body: "first" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);
    pipeline.push(record({ body: "second" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(diagnostics.snapshot()["pipeline.crashed"]).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["second"]);
    pipeline.destroy();
  });

  it("drops only the record that threw on its way into a stream", async () => {
    const { pipeline, send, diagnostics } = setup();

    pipeline.push(record({ attributes: undefined as unknown as Record<string, unknown> }));
    pipeline.push(record({ body: "after" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(diagnostics.snapshot()["pipeline.crashed"]).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["after"]);
    pipeline.destroy();
  });

  it("caps an ERROR storm that sampling would let through whole", () => {
    // ERROR and FATAL bypass sampling by design. Application code calling
    // logger.error in a render loop is the case with no other limit.
    // A batch size past the ceiling, so the assertion reads the buffer rather
    // than whatever an early batch already took.
    const { pipeline, diagnostics } = setup(undefined, {
      logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: ERROR_CEILING_MAX_PER_WINDOW * 2 },
      metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
    });
    const over = 10;

    for (let i = 0; i < ERROR_CEILING_MAX_PER_WINDOW + over; i++) {
      pipeline.push(record({ severityText: "ERROR" }));
    }

    expect(diagnostics.snapshot()["record.dropped_by_ceiling"]).toBe(over);
    expect(pipeline.drainForExit()[0].records).toHaveLength(ERROR_CEILING_MAX_PER_WINDOW);
    pipeline.destroy();
  });

  it("does not resend records the exit flush already took", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record());
    pipeline.push(record());

    const [flushed] = pipeline.drainForExit();
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(flushed.records).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
    pipeline.destroy();
  });

  it("keeps records that arrived after the exit flush, and sends only those", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record({ body: "before" }));
    pipeline.drainForExit();
    pipeline.push(record({ body: "after" }));

    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["after"]);
    pipeline.destroy();
  });

  it("leaves in-flight batches alone on an explicit flush", async () => {
    // A send that never settles keeps a claimed batch unconfirmed. An explicit flush that took it
    // would send those records again under a new batch id, which the server can't match to the id
    // still in flight.
    const { pipeline, send } = setup(undefined, {
      logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: 2 },
      metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
    });
    send.mockImplementation(() => new Promise<void>(() => undefined));

    pipeline.push(record({ body: "in-flight" }));
    pipeline.push(record({ body: "in-flight" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledOnce();
    void pipeline.flushPending();
    await vi.advanceTimersByTimeAsync(0);

    // The flush sends no second copy, and the batch stays in flight for the exit flush.
    expect(send).toHaveBeenCalledOnce();
    expect(pipeline.drainForExit()[0].records).toHaveLength(2);
    pipeline.destroy();
  });

  it("hands over batches that are claimed but not yet confirmed sent", async () => {
    // These requests never settle, so every claimed batch stays between the claim and the
    // network. Three batches form. MAX_CONCURRENT_REQUESTS lets two go in flight and holds the
    // third. A document that closes takes all of them.
    const { pipeline, send } = setup(undefined, {
      logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: 2 },
      metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
    });
    send.mockImplementation(() => new Promise<void>(() => undefined));

    for (let i = 0; i < 6; i++) {
      pipeline.push(record());
    }
    await vi.advanceTimersByTimeAsync(0);

    const [batch] = pipeline.drainForExit();

    expect(send).toHaveBeenCalledTimes(2);
    expect(batch.records).toHaveLength(6);
    pipeline.destroy();
  });

  it("does not hand over a batch that the transport sends with keepalive", async () => {
    // A keepalive request continues after unload, so a second copy under a new id is a duplicate.
    const { pipeline, send } = setup();
    send.mockImplementation((_batch, onKeepalive) => {
      onKeepalive?.();
      return new Promise<void>(() => undefined);
    });

    pipeline.push(record({ body: "sent" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);
    pipeline.push(record({ body: "buffered" }));

    const [batch] = pipeline.drainForExit();

    expect(send).toHaveBeenCalledOnce();
    expect(batch.records.map((one) => one.body)).toEqual(["buffered"]);
    pipeline.destroy();
  });

  it("batches the span records in their own stream, and hands them to the exit flush", async () => {
    const { pipeline, send } = setup();
    const span = record({ attributes: { "log.type": "span" } });

    pipeline.push(span);
    pipeline.push(record());
    pipeline.push(metric());

    // The error logs get the beacon budget before the spans.
    expect(pipeline.drainForExit().map((batch) => batch.records)).toEqual([
      [
        expect.objectContaining({
          attributes: { "log.type": "metric", "app.namespace": "trading" },
        }),
      ],
      [
        expect.objectContaining({
          attributes: { "log.type": "system", "app.namespace": "trading" },
        }),
      ],
      [span],
    ]);

    pipeline.push(span);
    pipeline.push(record());
    await pipeline.flushPending();

    expect(send.mock.calls.map(([batch]) => batch.records.length)).toEqual([1, 1]);
    expect(send.mock.calls[1][0].records).toEqual([span]);
    pipeline.destroy();
  });

  it("counts the buffered and queued records as pending, and the dispatched records as in flight", async () => {
    // Three batches of 2 form. Two go in flight, and the pipeline holds the third in the queue.
    const { pipeline, send } = setup(undefined, {
      logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: 2 },
      metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
    });
    let finish = (): void => undefined;
    send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    for (let i = 0; i < 6; i++) {
      pipeline.push(record());
    }
    pipeline.push(metric());

    expect(pipeline.counts()).toEqual({ pending: 7, inFlight: 0 });

    await vi.advanceTimersByTimeAsync(0);

    expect(pipeline.counts()).toEqual({ pending: 3, inFlight: 4 });

    finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(pipeline.counts()).toEqual({ pending: 1, inFlight: 4 });
    pipeline.destroy();
  });

  it("accepts nothing once destroyed", async () => {
    const { pipeline, send } = setup();
    pipeline.destroy();

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).not.toHaveBeenCalled();
    expect(pipeline.drainForExit()).toEqual([]);
    pipeline.destroy();
  });
});

describe("LogPipeline hold", () => {
  it("keeps every record and sends nothing while held, then sends them all when it starts", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record({ body: "before" }));
    pipeline.hold(true);

    // A full batch and the flush timers would each claim a batch if the stream weren't held.
    for (let i = 0; i < BATCH_SIZE; i++) {
      pipeline.push(record({ body: "during" }));
    }
    await vi.advanceTimersByTimeAsync(PAST_METRIC_FLUSH_MS + PAST_LOG_FLUSH_MS);
    await pipeline.flushPending();

    expect(send).not.toHaveBeenCalled();
    expect(pipeline.records()).toHaveLength(BATCH_SIZE + 1);

    pipeline.hold(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(send.mock.calls.flatMap(([batch]) => bodiesOf(batch))).toHaveLength(BATCH_SIZE + 1);
    pipeline.destroy();
  });

  it("sends a batch that was queued before the hold once it starts again", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record({ body: "queued" }));
    // The flush queues the batch, and the hold comes before the pump's microtask runs.
    const flushed = pipeline.flushPending();
    pipeline.hold(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(send).not.toHaveBeenCalled();
    expect(pipeline.records().map((one) => one.body)).toEqual(["queued"]);

    pipeline.hold(false);
    await flushed;

    expect(send.mock.calls.map(([batch]) => bodiesOf(batch))).toEqual([["queued"]]);
    pipeline.destroy();
  });

  it("settles a flush that waits on a queued batch when the hold starts", async () => {
    const { pipeline, send } = setup();
    send.mockImplementation(() => new Promise<void>(() => undefined));
    // Two batches fill the two dispatch slots, so the third one waits in the queue.
    for (const body of ["first", "second", "third"]) {
      pipeline.push(record({ body }));
      void pipeline.flushPending();
    }
    let settled = false;
    void pipeline.flushPending().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    pipeline.hold(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    pipeline.destroy();
  });

  it("keeps no waiter once a flush settles", async () => {
    const { pipeline } = setup();
    pipeline.push(record({ body: "sent" }));

    await pipeline.flushPending();
    await pipeline.flushPending();

    // A waiter that outlives its flush would keep memory alive until the next hold.
    expect(pipeline["waiters"].size).toBe(0);
    pipeline.destroy();
  });

  it("lists the records in requests before the buffered ones", async () => {
    const { pipeline, send } = setup();
    send.mockImplementation(() => new Promise<void>(() => undefined));
    pipeline.push(record({ body: "in flight" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);
    pipeline.push(record({ body: "buffered" }));

    expect(pipeline.records().map((one) => one.body)).toEqual(["in flight", "buffered"]);
    pipeline.destroy();
  });
});

describe("LogPipeline flushPending", () => {
  /**
   * Creates a send that only settles when the test releases it.
   * @returns The send and the release function for every call.
   */
  function heldSend() {
    const releases: (() => void)[] = [];
    const send = vi.fn<Send>(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    return { send, releases };
  }

  /**
   * Tracks whether a promise settled.
   * @param work Promise to watch.
   * @returns A function that reports whether it settled.
   */
  function watch(work: Promise<void>): () => boolean {
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    return () => settled;
  }

  it("sends the metric records and the other records in separate batches", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record({ body: "log" }));
    pipeline.push(metric({ body: "metric" }));

    await pipeline.flushPending();

    // A mixed batch would send a metric to the logs endpoint.
    expect(send.mock.calls.map(([batch]) => batch.records.map((one) => one.body))).toEqual([
      ["metric"],
      ["log"],
    ]);
    pipeline.destroy();
  });

  it("sends the buffered records and waits for the batch in flight", async () => {
    const { pipeline, send } = setup();
    const held = heldSend();
    send.mockImplementation(held.send);

    pipeline.push(record({ body: "first" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);
    pipeline.push(record({ body: "second" }));

    const done = watch(pipeline.flushPending());
    await vi.advanceTimersByTimeAsync(0);

    expect(send.mock.calls.map(([batch]) => bodiesOf(batch))).toEqual([["first"], ["second"]]);
    expect(done()).toBe(false);

    held.releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(false);

    held.releases[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
    pipeline.destroy();
  });

  it("keeps the concurrency limit, and waits for a batch it queued", async () => {
    const { pipeline, send } = setup(undefined, {
      logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: 2 },
      metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
    });
    const held = heldSend();
    send.mockImplementation(held.send);

    // Two full batches take both slots, and the third record stays in the buffer for the flush.
    for (let i = 0; i < 4; i++) {
      pipeline.push(record());
    }
    await vi.advanceTimersByTimeAsync(0);
    pipeline.push(record({ body: "queued" }));
    const done = watch(pipeline.flushPending());
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(2);

    held.releases[0]();
    held.releases[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(bodiesOf(send.mock.calls[2][0])).toEqual(["queued"]);
    expect(done()).toBe(false);

    held.releases[2]();
    await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
    pipeline.destroy();
  });

  it("waits for a batch that is still in the queue", async () => {
    const { pipeline, send } = setup(undefined, {
      logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: 2 },
      metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
    });
    const held = heldSend();
    send.mockImplementation(held.send);

    // Three full batches in one task. Two take the slots, and the third waits in the queue.
    for (let i = 0; i < 6; i++) {
      pipeline.push(record());
    }
    const done = watch(pipeline.flushPending());
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);

    held.releases[0]();
    held.releases[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(3);
    expect(done()).toBe(false);

    held.releases[2]();
    await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
    pipeline.destroy();
  });

  it("stores the batch for the retry engine while the server throttles", async () => {
    const { pipeline, send, throttledForMs, storage, nudge } = setup();
    throttledForMs.mockReturnValue(5000);

    pipeline.push(record());
    await pipeline.flushPending();

    expect(send).not.toHaveBeenCalled();
    expect(await storage.count()).toBe(1);
    expect(nudge).toHaveBeenCalled();
    pipeline.destroy();
  });

  it("resolves right away with nothing buffered and nothing in flight", async () => {
    const { pipeline, send } = setup();

    await pipeline.flushPending();

    expect(send).not.toHaveBeenCalled();
    pipeline.destroy();
  });

  it("releases a waiting flush on destroy", async () => {
    const { pipeline, send } = setup();
    send.mockImplementation(heldSend().send);

    pipeline.push(record());
    const done = watch(pipeline.flushPending());
    await vi.advanceTimersByTimeAsync(0);
    pipeline.destroy();
    await vi.advanceTimersByTimeAsync(0);

    expect(done()).toBe(true);
  });

  it("sends nothing on a flush after destroy", async () => {
    const { pipeline, send } = setup();
    pipeline.destroy();

    await pipeline.flushPending();

    expect(send).not.toHaveBeenCalled();
  });
});

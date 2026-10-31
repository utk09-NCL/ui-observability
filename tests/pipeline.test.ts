import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CEILING_MAX_PER_WINDOW } from "../src/constants";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { LogPipeline, type StreamName, type StreamOptions } from "../src/core/pipeline";
import type { LogBatch } from "../src/models/batch";
import type { LogRecord } from "../src/models/log-record";
import type { StorageAdapter } from "../src/models/storage";
import { MemoryStorage } from "../src/storage/memory-storage";
import { TransportError } from "../src/transport/errors";
import type { RetryEngine } from "../src/transport/retry-engine";

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

  // This stub takes the place of the classification of the engine. retry-engine.test.ts proves the
  // split. Here, the stub only stores and nudges.
  const storeFailed = vi.fn<(batch: LogBatch, error: unknown) => Promise<void>>(async (failed) => {
    await storage.save(failed);
    nudge();
  });

  const pipeline = new LogPipeline(
    { send, throttledForMs },
    storage,
    { nudge, storeFailed } as unknown as RetryEngine,
    diagnostics,
    { ...DEFAULT_STREAMS, ...streams },
  );

  return { pipeline, send, throttledForMs, storage, nudge, storeFailed, diagnostics, handler };
};

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

    // A mixed batch sends a metric to the endpoint of the logs.
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
    // The flush queues the batch. A queued batch counts as in flight.
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
    // A batch that the pipeline stores with zero attempts gets one request more than the
    // maxAttempts limit. Each X-UiObs-Attempt header then shows one attempt too few.
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
    // The pipeline sent nothing. No attempt counts against the batch.
    const { pipeline, send, throttledForMs, storage, nudge, diagnostics } = setup();
    throttledForMs.mockReturnValue(5000);

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).not.toHaveBeenCalled();
    const stored = await storage.take(1);
    expect(stored[0].attempts).toBe(0);
    expect(nudge).toHaveBeenCalled();
    expect(diagnostics.snapshot()["transport.throttled"]).toBe(1);
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
    const save = vi.fn<(batch: LogBatch) => Promise<void>>(() =>
      Promise.reject(new Error("quota")),
    );
    const { pipeline, send, nudge, diagnostics } = setup({ save } as unknown as StorageAdapter);
    send.mockRejectedValueOnce(new Error("network"));

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(save).toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()["storage.degraded"]).toBe(1);
    pipeline.destroy();
  });

  it("contains a dispatch that rejects instead of stopping delivery", async () => {
    // dispatch must never reject. If it rejects, the pipeline loses the batch and reports it. The
    // records after it still go to the transport.
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
    // A send that never settles keeps a claimed batch unconfirmed. An explicit flush that takes it
    // sends those records again under a new batch id. The server cannot match that id to the id
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

    // The flush sends no second copy. The batch stays in flight for the exit flush.
    expect(send).toHaveBeenCalledOnce();
    expect(pipeline.drainForExit()[0].records).toHaveLength(2);
    pipeline.destroy();
  });

  it("hands over batches that are claimed but not yet confirmed sent", async () => {
    // These requests never settle. Each claimed batch stays between the claim and the network.
    // Three batches form. MAX_CONCURRENT_REQUESTS lets two go in flight. It holds the third. A
    // document that closes takes all of them.
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
    // A keepalive request continues after unload. A second copy under a new id is a duplicate.
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

    expect(pipeline.drainForExit().map((batch) => batch.records)).toEqual([
      [
        expect.objectContaining({
          attributes: { "log.type": "metric", "app.namespace": "trading" },
        }),
      ],
      [span],
      [
        expect.objectContaining({
          attributes: { "log.type": "system", "app.namespace": "trading" },
        }),
      ],
    ]);

    pipeline.push(span);
    pipeline.push(record());
    await pipeline.flushPending();

    expect(send.mock.calls.map(([batch]) => batch.records.length)).toEqual([1, 1]);
    expect(send.mock.calls[0][0].records).toEqual([span]);
    pipeline.destroy();
  });

  it("counts the buffered and queued records as pending, and the dispatched records as in flight", async () => {
    // Three batches of 2 form. Two go in flight. The pipeline holds the third in the queue.
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

describe("LogPipeline flushPending", () => {
  /**
   * Makes a send that settles only when the test releases it.
   * @returns The send and the release function of each call.
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
   * Tracks if a promise settled.
   * @param work Promise to watch.
   * @returns A function that tells if it settled.
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

    // A mixed batch sends a metric to the endpoint of the logs.
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

    // Two full batches take both slots. The third record stays in the buffer for the flush.
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

    // Three full batches in one task. Two take the slots. The third waits in the queue.
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

  it("resolves at once with nothing buffered and nothing in flight", async () => {
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

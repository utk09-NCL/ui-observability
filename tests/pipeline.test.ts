import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { LogPipeline } from "../src/core/pipeline";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import type { StorageAdapter } from "../src/models/storage";
import { MemoryStorage } from "../src/storage/memory-storage";
import type { HttpTransport } from "../src/transport/http-transport";
import type { RetryEngine } from "../src/transport/retry-engine";

const LOG_FLUSH_MS = 1000;
const METRIC_FLUSH_MS = 5000;
const BATCH_SIZE = 100;

/** Enough to carry a flush timer over, whichever stream armed it. */
const PAST_LOG_FLUSH_MS = LOG_FLUSH_MS + 100;
const PAST_METRIC_FLUSH_MS = METRIC_FLUSH_MS - LOG_FLUSH_MS + 100;

const limits = { maxBatches: 100, maxAgeMs: 60_000, maxAttempts: 5 };

type Send = (batch: LogBatch) => Promise<void>;

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
const setup = (over: Partial<ObservabilityConfig> = {}, override?: StorageAdapter) => {
  const handler = vi.fn<(event: DiagnosticEvent) => void>();
  const diagnostics = new Diagnostics(handler, 0);
  const config = resolveConfig(
    {
      endpoint: "https://x/v1/logs",
      serviceName: "svc",
      streams: {
        logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: BATCH_SIZE },
        metrics: { flushIntervalMs: METRIC_FLUSH_MS, batchSize: BATCH_SIZE },
      },
      storage: limits,
      ...over,
    },
    diagnostics,
  );

  const send = vi.fn<Send>(() => Promise.resolve());
  const throttledForMs = vi.fn<() => number>(() => 0);
  const storage = override ?? new MemoryStorage(limits);
  const nudge = vi.fn<() => void>();

  const pipeline = new LogPipeline(
    config,
    { send, throttledForMs } as unknown as HttpTransport,
    storage,
    { nudge } as unknown as RetryEngine,
    diagnostics,
  );

  return { pipeline, send, throttledForMs, storage, nudge, diagnostics, handler };
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

  it("hands both streams to the exit flush as one batch and clears them", () => {
    const { pipeline } = setup();
    pipeline.push(record({ body: "log" }));
    pipeline.push(metric({ body: "metric" }));

    const batch = pipeline.drainPending();

    expect(batch?.records.map((one) => one.body).sort()).toEqual(["log", "metric"]);
    expect(pipeline.drainPending()).toBeNull();
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
    // Stored at zero, this batch would get one request more than maxAttempts
    // allows, and every X-UiObs-Attempt header would under-report by one.
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

  it("stores without spending an attempt while the server is throttling us", async () => {
    // Nothing was sent, so nothing may count against the batch.
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

  it("reports rather than nudging when the store refuses the batch", async () => {
    const save = vi.fn<(batch: LogBatch) => Promise<void>>(() =>
      Promise.reject(new Error("quota")),
    );
    const { pipeline, send, nudge, diagnostics } = setup({}, { save } as unknown as StorageAdapter);
    send.mockRejectedValueOnce(new Error("network"));

    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(save).toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()["storage.degraded"]).toBe(1);
    pipeline.destroy();
  });

  it("contains a dispatch that rejects instead of killing the stream", async () => {
    // The inner catchError. On the outer chain the second record never arrives,
    // because the stream would have completed.
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

  it("restarts the stream when an operator throws", async () => {
    const { pipeline, send, diagnostics } = setup();

    pipeline.push(record({ attributes: undefined as unknown as Record<string, unknown> }));
    pipeline.push(record({ body: "after" }));
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(diagnostics.snapshot()["pipeline.crashed"]).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["after"]);
    pipeline.destroy();
  });

  it("does not accumulate records that sampling dropped", () => {
    const { pipeline, diagnostics } = setup({ sampling: { defaultRate: 0 } });

    for (let i = 0; i < 100; i++) {
      pipeline.push(record());
    }

    expect(pipeline.drainPending()).toBeNull();
    expect(diagnostics.snapshot()["record.dropped_by_sampling"]).toBe(100);
    pipeline.destroy();
  });

  it("drops the oldest record when a stream buffer fills", () => {
    // A batch size of zero stops the operator flushing on count, which is the
    // one way the buffer can outgrow its cap.
    const { pipeline, diagnostics } = setup({
      streams: { logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: 0 } },
    });

    for (let i = 0; i < 11; i++) {
      pipeline.push(record({ body: String(i) }));
    }
    const batch = pipeline.drainPending();

    expect(batch?.records).toHaveLength(10);
    expect(bodiesOf(batch!)[0]).toBe("1");
    expect(diagnostics.snapshot()["record.dropped_pending_full"]).toBe(1);
    pipeline.destroy();
  });

  it("does not resend records the exit flush already took", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record());
    pipeline.push(record());

    const flushed = pipeline.drainPending();
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(flushed?.records).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
    pipeline.destroy();
  });

  it("keeps records that arrived after the exit flush, and sends only those", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record({ body: "before" }));
    pipeline.drainPending();
    pipeline.push(record({ body: "after" }));

    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["after"]);
    pipeline.destroy();
  });

  it("hands over batches that are claimed but not yet confirmed sent", async () => {
    // One request that never settles, so the batches behind it sit between the
    // claim and the network. A closing document takes those too.
    const { pipeline, send } = setup({
      streams: { logs: { flushIntervalMs: LOG_FLUSH_MS, batchSize: 2 } },
      maxConcurrentRequests: 1,
    });
    send.mockImplementation(() => new Promise<void>(() => undefined));

    for (let i = 0; i < 6; i++) {
      pipeline.push(record());
    }
    await vi.advanceTimersByTimeAsync(0);

    const batch = pipeline.drainPending();

    expect(send).toHaveBeenCalledOnce();
    expect(batch?.records).toHaveLength(6);
    pipeline.destroy();
  });

  it("keeps the buffers across a refresh", async () => {
    const { pipeline, send } = setup();
    pipeline.push(record({ body: "buffered" }));

    pipeline.refresh();
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(bodiesOf(send.mock.calls[0][0])).toEqual(["buffered"]);
    pipeline.destroy();
  });

  it("accepts nothing and resubscribes to nothing once destroyed", async () => {
    const { pipeline, send } = setup();
    pipeline.destroy();

    pipeline.refresh();
    pipeline.push(record());
    await vi.advanceTimersByTimeAsync(PAST_LOG_FLUSH_MS);

    expect(send).not.toHaveBeenCalled();
    expect(pipeline.drainPending()).toBeNull();
    pipeline.destroy();
  });
});

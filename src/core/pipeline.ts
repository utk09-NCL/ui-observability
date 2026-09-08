// src/core/pipeline.ts
//
// Stream buffering, batch formation, and delivery for logs and metrics.
//
// Each stream owns its buffer and its own flush timer, so the exit flush can
// take every record that has not reached the transport yet.

import {
  ATTR_LOG_TYPE,
  LOG_BATCH_SIZE,
  LOG_FLUSH_INTERVAL_MS,
  LOG_TYPE_METRIC,
  MAX_CONCURRENT_REQUESTS,
  METRIC_BATCH_SIZE,
  METRIC_FLUSH_INTERVAL_MS,
} from "../constants";
import type { LogBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import { type LogRecord, nowUnixNano } from "../models/log-record";
import type { StorageAdapter } from "../models/storage";
import type { HttpTransport } from "../transport/http-transport";
import type { RetryEngine } from "../transport/retry-engine";
import { newId } from "../utils/identity";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";
import { shouldSample } from "./sampling";

/** Pipeline stream classification for logs versus metrics. */
export type StreamName = "logs" | "metrics";

/**
 * Evaluates whether a log record is classified as a metric.
 * @param record Record to evaluate.
 * @returns True if the record log type attribute equals metric.
 */
function isMetric(record: LogRecord): boolean {
  return record.attributes[ATTR_LOG_TYPE] === LOG_TYPE_METRIC;
}

/** Batching policy for one record stream. */
export interface StreamOptions {
  /** Max time a partial batch waits before it is sent, in milliseconds. */
  flushIntervalMs: number;
  /** Max records per batch before it is sent early. */
  batchSize: number;
}

/** Batching policy per stream. Metrics batch harder: higher volume, nothing waits on them. */
export const STREAM_OPTIONS: Record<StreamName, StreamOptions> = {
  logs: { flushIntervalMs: LOG_FLUSH_INTERVAL_MS, batchSize: LOG_BATCH_SIZE },
  metrics: { flushIntervalMs: METRIC_FLUSH_INTERVAL_MS, batchSize: METRIC_BATCH_SIZE },
};

/** One stream's pending records and the timer that closes a partial batch. */
class RecordStream {
  /** Pending records waiting in chronological order. */
  private pending: LogRecord[] = [];

  /** Handle of the armed flush timer, or null when none is pending. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param options Batching policy for this stream.
   * @param onFlush Called with this stream when a batch is ready to close.
   */
  constructor(
    readonly options: StreamOptions,
    private readonly onFlush: (stream: RecordStream) => void,
  ) {}

  /**
   * Buffers a record, closing the batch at once on the batchSize-th and arming
   * the interval timer on the first. Without the timer a batch below batchSize
   * waits for the next record, which on a quiet page never comes.
   * @param record Record to enqueue.
   */
  add(record: LogRecord): void {
    this.pending.push(record);

    if (this.pending.length >= this.options.batchSize) {
      this.onFlush(this);
      return;
    }

    this.arm();
  }

  /**
   * Drains and returns all buffered records, disarming the flush timer.
   * @returns Array of buffered records.
   */
  take(): LogRecord[] {
    this.clearTimer();

    const records = this.pending;
    this.pending = [];

    return records;
  }

  /** Disarms the flush timer, leaving buffered records in place. */
  stop(): void {
    this.clearTimer();
  }

  /** Arms the flush timer unless one is already pending. */
  private arm(): void {
    if (this.timer !== null) {
      return;
    }

    const timer = setTimeout(() => {
      this.timer = null;
      this.onFlush(this);
    }, this.options.flushIntervalMs);

    this.timer = timer;
    unrefTimer(timer);
  }

  /** Clears the pending timer handle if armed. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Pipeline orchestrating log and metric stream buffering, batch creation, and HTTP dispatch. */
export class LogPipeline {
  /** Buffer instances for logs and metrics streams. */
  private readonly streams: Record<StreamName, RecordStream>;

  /** Unconfirmed in-flight batches tracked for exit flush recovery. */
  private readonly unconfirmed = new Map<string, LogBatch>();

  /** Closed batches waiting for a free dispatch slot. */
  private readonly queue: LogBatch[] = [];

  /** Dispatches currently in flight, capped at MAX_CONCURRENT_REQUESTS. */
  private inFlight = 0;

  /** Indicates a pump is already queued, so one microtask drains a burst. */
  private pumpScheduled = false;

  /** Indicates whether the pipeline has been destroyed. */
  private stopped = false;

  /**
   * @param config Active configuration instance.
   * @param transport HTTP transport for live batch delivery.
   * @param storage Storage adapter for offline batch persistence.
   * @param retry Retry engine for redelivering persisted batches.
   * @param diagnostics Diagnostics reporter.
   * @param streamOptions Batching policy per stream.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly transport: HttpTransport,
    private readonly storage: StorageAdapter,
    private readonly retry: RetryEngine,
    private readonly diagnostics: Diagnostics,
    streamOptions: Record<StreamName, StreamOptions> = STREAM_OPTIONS,
  ) {
    const flush = (stream: RecordStream): void => {
      this.claim(stream);
    };

    this.streams = {
      logs: new RecordStream(streamOptions.logs, flush),
      metrics: new RecordStream(streamOptions.metrics, flush),
    };
  }

  /**
   * Stamps observed timestamp and enqueues a record into the pipeline.
   * @param record Record to push.
   */
  push(record: LogRecord): void {
    if (this.stopped) {
      return;
    }

    record.observedTimeUnixNano = nowUnixNano();
    this.route(record);
  }

  /**
   * Drains the stream buffers into one batch. In-flight batches stay where they
   * are. They carry their own ids and are still on their way, so taking them here
   * resends every record under an id the server cannot deduplicate against.
   * @returns Combined LogBatch or null if no records are buffered.
   */
  drainPending(): LogBatch | null {
    return this.toBatch([...this.streams.metrics.take(), ...this.streams.logs.take()]);
  }

  /**
   * Atomically drains all buffered and unconfirmed in-flight records into a single
   * exit batch. Records already handed to fetch go out again under a new batch id,
   * so the server cannot deduplicate them and the exit flush can deliver duplicates.
   * A document being closed cannot confirm delivery, so this is by design.
   * @returns Combined LogBatch or null if no records are pending.
   */
  drainForExit(): LogBatch | null {
    const inFlight = [...this.unconfirmed.values()].flatMap((batch) => batch.records);
    this.unconfirmed.clear();

    return this.toBatch([...inFlight, ...this.streams.metrics.take(), ...this.streams.logs.take()]);
  }

  /** Stops the flush timers and refuses further records. */
  destroy(): void {
    this.stopped = true;
    this.streams.logs.stop();
    this.streams.metrics.stop();
    this.queue.length = 0;
  }

  /**
   * Wraps drained records in a batch.
   * @param records Records taken from the buffers, in delivery order.
   * @returns New LogBatch, or null when nothing was drained.
   */
  private toBatch(records: LogRecord[]): LogBatch | null {
    if (records.length === 0) {
      return null;
    }

    return { id: newId(), records, createdAt: Date.now(), attempts: 0 };
  }

  /**
   * Sorts a record into its stream, after sampling. Every fault is contained
   * here: a record carrying no `attributes` makes isMetric throw, and a throw
   * escaping this method would surface inside the caller's own log call.
   * @param record Record to sort.
   */
  private route(record: LogRecord): void {
    try {
      const stream = isMetric(record) ? this.streams.metrics : this.streams.logs;

      if (!shouldSample(record, this.config)) {
        this.diagnostics.count("record.dropped_by_sampling");
        return;
      }

      stream.add(record);
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "a record was dropped on its way into a stream",
        undefined,
        error,
      );
    }
  }

  /**
   * Drains a stream buffer into a new batch and queues it for dispatch. The
   * buffer always holds at least one record here: a timer is armed only by a
   * push, and every `take` disarms the timer that would have called this.
   * @param stream Stream buffer to drain.
   */
  private claim(stream: RecordStream): void {
    const records = stream.take();

    const batch: LogBatch = {
      id: newId(),
      records,
      createdAt: Date.now(),
      attempts: 0,
    };
    this.unconfirmed.set(batch.id, batch);
    this.enqueue(batch);
  }

  /**
   * Queues a batch and schedules the pump on a microtask. Dispatching inline
   * would start a fetch inside the application's own log call.
   * @param batch Batch ready for delivery.
   */
  private enqueue(batch: LogBatch): void {
    this.queue.push(batch);

    if (this.pumpScheduled) {
      return;
    }

    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** Starts queued dispatches up to the concurrency limit. */
  private pump(): void {
    while (this.inFlight < MAX_CONCURRENT_REQUESTS) {
      const batch = this.queue.shift();
      if (!batch) {
        return;
      }

      this.inFlight++;
      void this.run(batch);
    }
  }

  /**
   * Delivers one batch and frees its concurrency slot.
   * @param batch Batch to deliver.
   */
  private async run(batch: LogBatch): Promise<void> {
    try {
      await this.dispatch(batch);
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "dispatch rejected, which it is written never to do",
        { batchId: batch.id },
        error,
      );
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  /**
   * Sends a batch over HTTP transport or persists it to offline storage if throttled or failed.
   * @param batch Batch to deliver.
   */
  private async dispatch(batch: LogBatch): Promise<void> {
    try {
      // Persists directly to storage while transport is throttled. Sending here
      // posts a batch every flush interval straight through the throttle.
      // Attempt count unchanged: nothing was sent.
      const throttledMs = this.transport.throttledForMs();
      if (throttledMs > 0) {
        await this.store(batch);
        this.diagnostics.report("transport.throttled", "stored the batch rather than sending it", {
          batchId: batch.id,
          records: batch.records.length,
          throttledMs,
        });
        return;
      }

      try {
        await this.transport.send(batch);
      } catch (error) {
        // Increments attempt count before storing failed live send. Stored at 0,
        // the batch exceeds STORAGE_LIMITS.maxAttempts by one and attempt headers
        // under-report.
        await this.store({ ...batch, attempts: batch.attempts + 1 });
        this.diagnostics.report(
          "transport.http_error",
          "batch was stored for retry instead of being delivered",
          { batchId: batch.id, records: batch.records.length },
          error,
        );
      }
    } finally {
      this.unconfirmed.delete(batch.id);
    }
  }

  /**
   * Persists an undelivered batch to storage and triggers retry engine.
   * @param batch Batch to persist.
   */
  private async store(batch: LogBatch): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "persisting an undelivered batch",
      async () => {
        await this.storage.save(batch);
        this.retry.nudge();
      },
    );
  }
}

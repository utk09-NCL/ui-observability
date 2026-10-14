// src/core/pipeline.ts
//
// This module buffers log and metric streams, makes batches and delivers them.
//
// Each stream has its own buffer and flush timer. Thus the exit flush can take each
// record that is not yet at the transport.

import {
  ATTR_LOG_TYPE,
  LOG_BATCH_SIZE,
  LOG_FLUSH_INTERVAL_MS,
  LOG_TYPE_METRIC,
  MAX_CONCURRENT_REQUESTS,
  METRIC_BATCH_SIZE,
  METRIC_FLUSH_INTERVAL_MS,
  STORAGE_DEADLINE_MS,
} from "../constants";
import type { LogBatch } from "../models/batch";
import { type LogRecord, nowUnixNano } from "../models/log-record";
import type { StorageAdapter } from "../models/storage";
import type { BatchTransport } from "../transport/status-transport";
import type { RetryEngine } from "../transport/retry-engine";
import { withDeadline } from "../utils/deadline";
import { newId } from "../utils/identity";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";
import { ErrorCeiling } from "./sampling";

/** Name of a pipeline stream. */
export type StreamName = "logs" | "metrics";

/**
 * Checks if a log record is a metric.
 * @param record Record to evaluate.
 * @returns True if the record log type attribute equals metric.
 */
function isMetric(record: LogRecord): boolean {
  return record.attributes[ATTR_LOG_TYPE] === LOG_TYPE_METRIC;
}

/** Batching policy for one record stream. */
export interface StreamOptions {
  /** Maximum time in milliseconds that a partial batch waits before the pipeline sends it. */
  flushIntervalMs: number;
  /** Maximum records in a batch. At this count, the pipeline sends the batch early. */
  batchSize: number;
}

/**
 * Batching policy per stream. Metrics use larger batches and a longer interval.
 * Metrics have a higher volume, and no process waits for them.
 */
export const STREAM_OPTIONS: Record<StreamName, StreamOptions> = {
  logs: { flushIntervalMs: LOG_FLUSH_INTERVAL_MS, batchSize: LOG_BATCH_SIZE },
  metrics: { flushIntervalMs: METRIC_FLUSH_INTERVAL_MS, batchSize: METRIC_BATCH_SIZE },
};

/** One stream's pending records and the timer that closes a partial batch. */
class RecordStream {
  /** Pending records in time order. */
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
   * Adds a record to the buffer. At batchSize records, it closes the batch.
   * Below batchSize, it starts the interval timer. Without the timer, a small batch
   * waits for the next record. On a quiet page, the next record does not come.
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
   * Removes and returns all buffered records. It also stops the flush timer.
   * @returns Array of buffered records.
   */
  take(): LogRecord[] {
    this.clearTimer();

    const records = this.pending;
    this.pending = [];

    return records;
  }

  /** Stops the flush timer. The buffered records stay in place. */
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

/** Buffers log and metric streams, makes batches and sends them over HTTP. */
export class LogPipeline {
  /** Buffer instances for logs and metrics streams. */
  private readonly streams: Record<StreamName, RecordStream>;

  /** In-flight batches without delivery confirmation. The exit flush sends them again. */
  private readonly unconfirmed = new Map<string, LogBatch>();

  /** Closed batches waiting for a free dispatch slot. */
  private readonly queue: LogBatch[] = [];

  /** Ceiling on the ERROR and FATAL records that bypass sampling. */
  private readonly ceiling = new ErrorCeiling();

  /** Dispatches currently in flight, capped at MAX_CONCURRENT_REQUESTS. */
  private inFlight = 0;

  /** It is true when a pump is in the queue. One microtask then drains a burst. */
  private pumpScheduled = false;

  /** Indicates whether the pipeline has been destroyed. */
  private stopped = false;

  /**
   * @param transport HTTP transport for live batch delivery.
   * @param storage Storage adapter for offline batch persistence.
   * @param retry Retry engine for redelivering persisted batches.
   * @param diagnostics Diagnostics reporter.
   * @param streamOptions Batching policy per stream.
   */
  constructor(
    private readonly transport: BatchTransport,
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
   * Sets the observed timestamp and adds a record to the pipeline.
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
   * Drains the stream buffers into one batch. It does not take in-flight batches.
   * An in-flight batch has its own ID and its send is not complete. If this method
   * takes it, the pipeline sends each record again under a new ID. The server cannot
   * deduplicate that ID.
   * @returns Combined LogBatch or null if no records are buffered.
   */
  drainPending(): LogBatch | null {
    return this.toBatch([...this.streams.metrics.take(), ...this.streams.logs.take()]);
  }

  /**
   * Drains all buffered and unconfirmed in-flight records into one exit batch in one step.
   * Records already given to fetch go again under a new batch ID. The server cannot
   * deduplicate them. Thus the exit flush can deliver duplicates. This is intentional.
   * A closing document cannot confirm delivery.
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

    return { id: newId(this.diagnostics), records, createdAt: Date.now(), attempts: 0 };
  }

  /**
   * Sorts a record into its stream. Sampling already ran. RecordBuilder samples a local
   * record. The runtime samples a forwarded record. This method catches each fault.
   * A record without `attributes` makes isMetric throw. An uncaught throw goes into the
   * log call of the caller.
   * @param record Record to sort.
   */
  private route(record: LogRecord): void {
    try {
      const stream = isMetric(record) ? this.streams.metrics : this.streams.logs;

      // ERROR and FATAL records bypass sampling upstream. This ceiling is their only
      // limit.
      if (!this.ceiling.allow(record)) {
        this.diagnostics.count("record.dropped_by_ceiling");
        return;
      }

      stream.add(record);
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "The pipeline dropped a record before it reached a stream.",
        undefined,
        error,
      );
    }
  }

  /**
   * Drains a stream buffer into a new batch and queues the batch for dispatch.
   * The buffer always has one or more records here. Only a push starts a timer.
   * Each `take` stops the timer that calls this method.
   * @param stream Stream buffer to drain.
   */
  private claim(stream: RecordStream): void {
    const records = stream.take();

    const batch: LogBatch = {
      id: newId(this.diagnostics),
      records,
      createdAt: Date.now(),
      attempts: 0,
    };
    this.unconfirmed.set(batch.id, batch);
    this.enqueue(batch);
  }

  /**
   * Queues a batch and schedules the pump on a microtask. An inline dispatch starts
   * a fetch inside the log call of the application.
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
        "A dispatch rejected its promise. This must not occur.",
        { batchId: batch.id },
        error,
      );
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  /**
   * Sends a batch over the HTTP transport. If the transport throttles or fails, it stores
   * the batch.
   * @param batch Batch to deliver.
   */
  private async dispatch(batch: LogBatch): Promise<void> {
    try {
      // Store the batch while the transport throttles. A send here posts a batch each
      // flush interval through the throttle. Do not change the attempt count.
      // The pipeline sent nothing.
      const throttledMs = this.transport.throttledForMs();
      if (throttledMs > 0) {
        await this.store(batch);
        this.diagnostics.report(
          "transport.throttled",
          "The server throttles requests. The pipeline stored the batch and did not send it.",
          {
            batchId: batch.id,
            records: batch.records.length,
            throttledMs,
          },
        );
        return;
      }

      try {
        await this.transport.send(batch);
      } catch (error) {
        // Increment the attempt count before the store. At 0, the batch exceeds
        // STORAGE_LIMITS.maxAttempts by one. The attempt headers then report one too few.
        await this.storeFailed({ ...batch, attempts: batch.attempts + 1 }, error);
        this.diagnostics.report(
          "transport.http_error",
          "The send failed. The pipeline stored the batch for a retry.",
          { batchId: batch.id, records: batch.records.length },
          error,
        );
      }
    } finally {
      this.unconfirmed.delete(batch.id);
    }
  }

  /**
   * Stores a batch that the transport refused. The retry engine splits a 413 and
   * drops a batch that the server does not accept.
   * @param batch Batch to persist, with its attempt already counted.
   * @param error Failure thrown by the transport.
   */
  private async storeFailed(batch: LogBatch, error: unknown): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not store an undelivered batch.",
      async () => {
        await this.retry.storeFailed(batch, error);
      },
    );
  }

  /**
   * Stores an undelivered batch and triggers the retry engine. A deadline limits the
   * wait. A storage call that does not settle holds this dispatch slot. Two such calls
   * stop the pipeline.
   * @param batch Batch to persist.
   */
  private async store(batch: LogBatch): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not store an undelivered batch.",
      async () => {
        await withDeadline(this.storage.save(batch), STORAGE_DEADLINE_MS);
        this.retry.nudge();
      },
    );
  }
}

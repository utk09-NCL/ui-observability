// src/core/pipeline.ts
//
// This module buffers the log and metric streams. It makes batches. It delivers them.
//
// Each stream has its own buffer and flush timer. Thus the exit flush can take each
// record that is not yet at the transport.

import {
  ATTR_LOG_TYPE,
  LOG_TYPE_METRIC,
  LOG_TYPE_SPAN,
  MAX_CONCURRENT_REQUESTS,
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
export type StreamName = "logs" | "metrics" | "traces";

/** Streams in the order of the exit batches. The logs get the beacon budget before the spans. */
const STREAM_ORDER: readonly StreamName[] = ["metrics", "logs", "traces"];

/**
 * Gives the stream of a record. Each stream makes batches of one kind.
 * @param record Record to evaluate.
 * @returns "metrics" for a metric, "traces" for a span, else "logs".
 */
function streamOf(record: LogRecord): StreamName {
  const type = record.attributes[ATTR_LOG_TYPE];

  if (type === LOG_TYPE_METRIC) {
    return "metrics";
  }

  return type === LOG_TYPE_SPAN ? "traces" : "logs";
}

/** Batching policy for one record stream. */
export interface StreamOptions {
  /** Maximum time in milliseconds that a partial batch waits before the pipeline sends it. */
  flushIntervalMs: number;
  /** Maximum records in a batch. At this count, the pipeline sends the batch early. */
  batchSize: number;
}

/** A closed batch in the queue or in flight. */
interface Pending {
  /** Batch to deliver. */
  batch: LogBatch;
  /** Resolves when the dispatch of the batch ends, or on destroy. */
  done: Promise<void>;
  /** Resolves `done`. */
  resolve: () => void;
}

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

  /** Number of buffered records. */
  get size(): number {
    return this.pending.length;
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

/** Buffers the log and metric streams. It makes batches. It sends them over HTTP. */
export class LogPipeline {
  /** Buffer instances for logs and metrics streams. */
  private readonly streams: Record<StreamName, RecordStream>;

  /** In-flight batches without delivery confirmation. The exit flush sends them again. */
  private readonly unconfirmed = new Map<string, LogBatch>();

  /** Closed batches waiting for a free dispatch slot. */
  private readonly queue: Pending[] = [];

  /** Each batch in the queue or in flight. flushPending waits for them. destroy() resolves them. */
  private readonly open = new Set<Pending>();

  /** Ceiling on the ERROR and FATAL records that bypass sampling. */
  private readonly ceiling = new ErrorCeiling();

  /** Number of dispatches in flight. MAX_CONCURRENT_REQUESTS is the limit. */
  private inFlight = 0;

  /** It is true when a pump is in the queue. One microtask then drains a burst. */
  private pumpScheduled = false;

  /** True after destroy() stops the pipeline. */
  private stopped = false;

  /**
   * @param transport HTTP transport for live batch delivery.
   * @param storage Storage adapter for offline batch persistence.
   * @param retry Retry engine for redelivering persisted batches.
   * @param diagnostics Diagnostics reporter.
   * @param streamOptions Batching policy per stream, from the batching config.
   */
  constructor(
    private readonly transport: BatchTransport,
    private readonly storage: StorageAdapter,
    private readonly retry: RetryEngine,
    private readonly diagnostics: Diagnostics,
    streamOptions: Record<StreamName, StreamOptions>,
  ) {
    const flush = (stream: RecordStream): void => {
      this.claim(stream);
    };

    this.streams = {
      logs: new RecordStream(streamOptions.logs, flush),
      metrics: new RecordStream(streamOptions.metrics, flush),
      traces: new RecordStream(streamOptions.traces, flush),
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
   * Drains all buffered and unconfirmed in-flight records into exit batches in one step.
   * Records already given to fetch go again under a new batch ID. The server cannot
   * deduplicate them. Thus the exit flush can deliver duplicates. This is intentional.
   * A closing document cannot confirm delivery.
   * @returns One batch for each stream, metrics first. A stream with no records has no batch.
   * A mixed batch sends a metric to the endpoint of the logs.
   */
  drainForExit(): LogBatch[] {
    const inFlight = [...this.unconfirmed.values()].flatMap((batch) => batch.records);
    this.unconfirmed.clear();

    return STREAM_ORDER.map((name) =>
      this.toBatch([
        ...inFlight.filter((record) => streamOf(record) === name),
        ...this.streams[name].take(),
      ]),
    ).filter((batch) => batch !== null);
  }

  /**
   * Sends the buffered records through the normal dispatch path. Then it waits for each
   * batch in the queue and in flight. The throttle check and the concurrency limit apply.
   * A direct send goes around both.
   * @returns Promise that resolves when the pipeline sends or stores each batch, or on destroy.
   */
  async flushPending(): Promise<void> {
    // One batch for each stream. A mixed batch sends a metric to the endpoint of the logs.
    // The claim does not take an in-flight batch. A second copy under a new ID is a duplicate
    // that the server cannot remove.
    if (!this.stopped) {
      for (const name of STREAM_ORDER) {
        this.claim(this.streams[name]);
      }
    }

    // A batch in the queue counts too. If not, the exit flush sends it again under a new id.
    await Promise.all([...this.open].map((pending) => pending.done));
  }

  /**
   * Counts the records that wait and the records in requests.
   * @returns Records in the buffers and the queue, and records in dispatch.
   */
  counts(): { pending: number; inFlight: number } {
    const records = (items: Iterable<Pending>): number => {
      let total = 0;
      for (const item of items) {
        total += item.batch.records.length;
      }
      return total;
    };

    // Each batch in the queue is also in the open set.
    const queued = records(this.queue);

    const buffered = STREAM_ORDER.reduce((total, name) => total + this.streams[name].size, 0);

    return { pending: buffered + queued, inFlight: records(this.open) - queued };
  }

  /** Stops the flush timers and refuses further records. */
  destroy(): void {
    this.stopped = true;
    for (const name of STREAM_ORDER) {
      this.streams[name].stop();
    }
    this.queue.length = 0;

    // destroy() drops each queued batch. Release each flushPending that waits for one.
    for (const pending of this.open) {
      pending.resolve();
    }
    this.open.clear();
  }

  /**
   * Wraps drained records in a batch.
   * @param records Records taken from the buffers, in delivery order.
   * @returns New LogBatch, or null when the drain takes nothing.
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
   * A record without `attributes` makes streamOf throw. An uncaught throw goes into the
   * log call of the caller.
   * @param record Record to sort.
   */
  private route(record: LogRecord): void {
    try {
      const stream = this.streams[streamOf(record)];

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
   * A timer or a flush calls it. An empty buffer gives no batch.
   * Each `take` stops the timer that calls this method.
   * @param stream Stream buffer to drain.
   */
  private claim(stream: RecordStream): void {
    this.enqueue(this.toBatch(stream.take()));
  }

  /**
   * Queues a batch and schedules the pump on a microtask. An inline dispatch starts
   * a fetch inside the log call of the application.
   * @param batch Batch ready for delivery, or null when the drain found no records.
   */
  private enqueue(batch: LogBatch | null): void {
    if (!batch) {
      return;
    }

    let resolve!: () => void;
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    const pending: Pending = { batch, done, resolve };

    this.unconfirmed.set(batch.id, batch);
    this.open.add(pending);
    this.queue.push(pending);

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
      const pending = this.queue.shift();
      if (!pending) {
        return;
      }

      this.inFlight++;
      void this.run(pending);
    }
  }

  /**
   * Delivers one batch. It then frees the concurrency slot. It resolves the promise of the batch.
   * @param pending Batch to deliver.
   */
  private async run(pending: Pending): Promise<void> {
    const { batch } = pending;

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
      this.open.delete(pending);
      pending.resolve();
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
      const throttledMs = this.transport.throttledForMs(batch);
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
        // A keepalive request continues after unload. The exit flush must not send it again.
        // A failed send still goes to the retry engine from this batch reference.
        await this.transport.send(batch, () => {
          this.unconfirmed.delete(batch.id);
        });
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
   * Stores an undelivered batch. Then it starts the retry engine. A deadline limits the
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

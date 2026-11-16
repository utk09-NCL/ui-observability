// src/core/pipeline.ts
//
// Buffers the log, metric and trace streams, builds batches and delivers them.
//
// Every stream has its own buffer and flush timer, so the exit flush can take every record
// that hasn't reached the transport yet.

import {
  ATTR_CLOCK_OFFSET_MS,
  ATTR_LOG_TYPE,
  LOG_TYPE_METRIC,
  LOG_TYPE_SPAN,
  STORAGE_DEADLINE_MS,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LossReporter } from "../models/drop";
import { estimateBytes } from "../utils/sanitize";
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

/** Streams in exit-batch order. The logs get the beacon budget before the spans. */
const STREAM_ORDER: readonly StreamName[] = ["metrics", "logs", "traces"];

/**
 * Returns the stream for a record. Each stream builds batches of one kind.
 * @param record Record to evaluate.
 * @returns "metrics" for a metric, "traces" for a span, otherwise "logs".
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
  /** Maximum time in milliseconds a partial batch waits before the pipeline sends it. */
  flushIntervalMs: number;
  /** Maximum records in a batch. At this count the pipeline sends the batch early. */
  batchSize: number;
}

/** A closed batch in the queue or in flight. */
interface Pending {
  /** Batch to deliver. */
  batch: LogBatch;
  /** Resolves when the batch's dispatch ends, or on destroy. */
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
   * Adds a record to the buffer. At batchSize records it closes the batch, and below that
   * it starts the interval timer. Without the timer a small batch would wait for the next
   * record, which on a quiet page never comes.
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
   * Removes and returns all buffered records, and stops the flush timer.
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

/** Buffers the log, metric and trace streams, builds batches and sends them over HTTP. */
export class LogPipeline {
  /** Buffer instances for the logs, metrics and traces streams. */
  private readonly streams: Record<StreamName, RecordStream>;

  /** In-flight batches with no delivery confirmation yet. The exit flush sends them again. */
  private readonly unconfirmed = new Map<string, LogBatch>();

  /** Closed batches waiting for a free dispatch slot. */
  private readonly queue: Pending[] = [];

  /** Every batch in the queue or in flight. flushPending waits on them, destroy() resolves them. */
  private readonly open = new Set<Pending>();

  /** Ceiling on the ERROR and FATAL records that bypass sampling. */
  private readonly ceiling = new ErrorCeiling();

  /** Requests that haven't completed. Capped by delivery.maxConcurrentRequests. */
  private inFlight = 0;

  /** True while a pump is queued, so one microtask drains a whole burst. */
  private pumpScheduled = false;

  /** True after destroy() stops the pipeline. */
  private stopped = false;
  /** Encoded byte count of every record in the buffers or in requests. */
  private readonly held = new Map<LogRecord, number>();
  /** Total encoded bytes of the held records. */
  private heldBytes = 0;
  /** True while the overflow storage operation is still running. */
  private persisting = false;

  /**
   * Removes completed or dropped records from the buffer counts.
   * @param records Records to remove from the counts.
   */
  private release(records: readonly LogRecord[]): void {
    for (const record of records) {
      this.heldBytes -= this.held.get(record) ?? 0;
      this.held.delete(record);
    }
  }

  /**
   * Removes records that haven't reached the transport. A request that was already sent can't
   * be removed.
   * @returns True if a batch or a buffered group was removed.
   */
  private evict(): boolean {
    const pending = this.queue.shift();
    if (pending) {
      this.open.delete(pending);
      this.unconfirmed.delete(pending.batch.id);
      this.release(pending.batch.records);
      pending.resolve();
      this.onLoss("buffer_full", pending.batch.records, [pending.batch.id]);
      return true;
    }
    for (const stream of Object.values(this.streams)) {
      const records = stream.take();
      if (records.length) {
        this.release(records);
        this.onLoss("buffer_full", records);
        return true;
      }
    }
    return false;
  }

  /**
   * Checks the buffer limits and applies the overflow rule.
   * @param record New record to add.
   * @returns True if the record can enter the live buffer.
   */
  private admit(record: LogRecord): boolean {
    if (!this.policy) return true;
    const { maxPendingRecords, maxPendingBytes, overflow } = this.policy.buffering;
    // Encode every record, even without a byte budget. A record JSON can't encode is dropped
    // here on its own. Otherwise the transport would drop its whole batch.
    let bytes: number;
    try {
      bytes = estimateBytes(JSON.stringify(record));
    } catch {
      this.onLoss("unserializable", [record]);
      return false;
    }
    const full = (): boolean =>
      Boolean(
        (maxPendingRecords && this.held.size >= maxPendingRecords) ||
        (maxPendingBytes && this.heldBytes + bytes > maxPendingBytes),
      );
    // A record larger than the byte budget never fits, so don't evict other records for it.
    const fits = !maxPendingBytes || bytes <= maxPendingBytes;
    while (fits && full() && overflow === "drop-oldest" && this.evict()) {
      /* Remove complete groups until the new record fits or no group remains. */
    }
    if (full()) {
      if (overflow === "persist" && !this.persisting) {
        this.persisting = true;
        const batch = this.toBatch([record]);
        void this.diagnostics.guardAsync(
          "storage.degraded",
          "Could not persist an overflow record.",
          async () => {
            try {
              await this.storage.save(batch);
              this.retry.nudge();
            } finally {
              this.persisting = false;
            }
          },
        );
      } else this.onLoss("buffer_full", [record]);
      return false;
    }
    this.held.set(record, bytes);
    this.heldBytes += bytes;
    return true;
  }

  /**
   * @param transport HTTP transport for live batch delivery.
   * @param storage Storage adapter for offline batch persistence.
   * @param retry Retry engine for redelivering persisted batches.
   * @param diagnostics Diagnostics reporter.
   * @param streamOptions Batching policy per stream, from the batching config.
   * @param routingContextId Returns the delivery context id for a new batch.
   * @param policy Active configuration instance.
   * @param onLoss Receives the records the pipeline loses.
   * @param clockOffset Returns the clock offset for a new log or span record, if known.
   */
  constructor(
    private readonly transport: BatchTransport,
    private readonly storage: StorageAdapter,
    private readonly retry: RetryEngine,
    private readonly diagnostics: Diagnostics,
    streamOptions: Record<StreamName, StreamOptions>,
    private readonly routingContextId?: () => string | undefined,
    private readonly policy?: ResolvedConfig,
    private readonly onLoss: LossReporter = () => undefined,
    private readonly clockOffset: () => number | undefined = () => undefined,
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
    const queued = { ...record };
    if (!this.admit(queued)) return;
    this.route(queued);
  }

  /**
   * Drains all buffered and unconfirmed in-flight records into exit batches in one step.
   * Records already handed to fetch go out again under a new batch ID, and the server can't
   * deduplicate them. So the exit flush can deliver duplicates. That is intentional: a
   * closing document can't confirm delivery.
   * @returns One batch per stream, metrics first. A stream with no records gets no batch.
   * A mixed batch would send a metric to the logs endpoint.
   */
  drainForExit(): LogBatch[] {
    const inFlight = [...this.unconfirmed.values()].flatMap((batch) => batch.records);
    this.unconfirmed.clear();
    this.held.clear();
    this.heldBytes = 0;

    return STREAM_ORDER.map((name) =>
      this.toBatch([
        ...inFlight.filter((record) => streamOf(record) === name),
        ...this.streams[name].take(),
      ]),
    ).filter((batch) => batch !== null);
  }

  /**
   * Sends the buffered records through the normal dispatch path, then waits for every batch
   * in the queue and in flight. The throttle check and the concurrency limit apply. A direct
   * send would bypass both.
   * @returns Promise that resolves once every batch is sent or stored, or on destroy.
   */
  async flushPending(): Promise<void> {
    // One batch per stream, because a mixed batch would send a metric to the logs endpoint.
    // The claim leaves in-flight batches alone. A second copy under a new ID would be a
    // duplicate the server can't remove.
    if (!this.stopped) {
      for (const name of STREAM_ORDER) {
        this.claim(this.streams[name]);
      }
    }

    // Queued batches count too. Otherwise the exit flush would send them again under a new id.
    await Promise.all([...this.open].map((pending) => pending.done));
  }

  /**
   * Counts the waiting records and the records in requests.
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

    // Every batch in the queue is also in the open set.
    const queued = records(this.queue);

    const buffered = STREAM_ORDER.reduce((total, name) => total + this.streams[name].size, 0);

    return { pending: buffered + queued, inFlight: records(this.open) - queued };
  }

  /** Stops the flush timers and refuses further records. */
  destroy(): void {
    this.stopped = true;
    this.held.clear();
    this.heldBytes = 0;
    for (const name of STREAM_ORDER) {
      this.streams[name].stop();
    }
    this.queue.length = 0;

    // destroy() drops every queued batch, so release any flushPending waiting on one.
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
  private toBatch(records: [LogRecord, ...LogRecord[]]): LogBatch;
  private toBatch(records: LogRecord[]): LogBatch | null;
  private toBatch(records: LogRecord[]): LogBatch | null {
    if (records.length === 0) {
      return null;
    }

    return {
      id: newId(this.diagnostics),
      records,
      createdAt: Date.now(),
      attempts: 0,
      routingContextId: this.routingContextId?.(),
      persistenceNamespace: this.policy?.persistence.namespace,
    };
  }

  /**
   * Sorts a record into its stream. Sampling has already run: RecordBuilder samples a local
   * record and the runtime samples a forwarded one. Every fault is caught here. A record
   * without `attributes` makes streamOf throw, and an uncaught throw would land in the
   * caller's log call.
   * @param record Record to sort.
   */
  private route(record: LogRecord): void {
    try {
      const name = streamOf(record);
      const stream = this.streams[name];

      // Records at or above alwaysSampleFrom bypass sampling upstream, so this ceiling is
      // their only limit. Metric points and spans have level INFO, and a lost point gives a
      // false sum.
      if (
        name === "logs" &&
        !this.ceiling.allow(
          record,
          this.policy?.capturePolicy.errorCeiling,
          this.policy?.capturePolicy.windowMs,
          this.policy?.sampling.alwaysSampleFrom,
        )
      ) {
        this.release([record]);
        this.diagnostics.count("record.dropped_by_ceiling");
        return;
      }

      // A changing value on a metric point would start a new series, so only logs and spans
      // get it.
      const offset = this.clockOffset();
      if (offset !== undefined && name !== "metrics") {
        record.attributes = { ...record.attributes, [ATTR_CLOCK_OFFSET_MS]: offset };
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
   * Drains a stream buffer into a new batch and queues it for dispatch. Called by a timer
   * or a flush. An empty buffer produces no batch. Every `take` stops the timer that calls
   * this method.
   * @param stream Stream buffer to drain.
   */
  private claim(stream: RecordStream): void {
    this.enqueue(this.toBatch(stream.take()));
  }

  /**
   * Queues a batch and schedules the pump on a microtask. Dispatching inline would start
   * a fetch inside the application's log call.
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
    if (this.stopped) return;
    while (this.inFlight < (this.policy?.delivery.maxConcurrentRequests ?? 2)) {
      const pending = this.queue.shift();
      if (!pending) {
        return;
      }

      this.inFlight++;
      void this.run(pending);
    }
  }

  /**
   * Delivers one batch, then frees the concurrency slot and resolves the batch's promise.
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
      this.release(batch.records);
      this.inFlight--;
      this.open.delete(pending);
      pending.resolve();
      this.pump();
    }
  }

  /**
   * Sends a batch over the HTTP transport. Stores the batch if the transport is throttled
   * or fails.
   * @param batch Batch to deliver.
   */
  private async dispatch(batch: LogBatch): Promise<void> {
    try {
      // Store the batch while the transport is throttled. Sending here would post a batch
      // through the throttle every flush interval. Leave the attempt count alone, because
      // nothing was sent.
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
        // A keepalive request carries on after unload, so the exit flush must not send it
        // again. A failed send still reaches the retry engine through this batch reference.
        await this.transport.send(batch, () => {
          this.unconfirmed.delete(batch.id);
        });
      } catch (error) {
        if (this.stopped) return;
        // Increment the attempt count before storing. Left at 0, the batch would exceed
        // STORAGE_LIMITS.maxAttempts by one and the attempt headers would report one too few.
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
   * Stores a batch that the transport refused. The retry engine splits a 413 and drops a
   * batch the server won't accept.
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
   * Stores an undelivered batch, then starts the retry engine. A deadline caps the wait,
   * because a storage call that never settles holds this dispatch slot, and two of them
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

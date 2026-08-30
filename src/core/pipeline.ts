// src/core/pipeline.ts
//
// Stream buffering, batch formation, and delivery pipeline for logs and metrics.
//
// Each stream owns its buffer. The exit flush cannot drain bufferTime's array.

import {
  asapScheduler,
  bufferTime,
  catchError,
  EMPTY,
  filter,
  from,
  map,
  merge,
  mergeMap,
  type Observable,
  observeOn,
  partition,
  Subject,
  type Subscription,
  tap,
} from "rxjs";
import { ATTR_LOG_TYPE, LOG_TYPE_METRIC, PENDING_BUFFER_BATCHES } from "../constants";
import type { LogBatch } from "../models/batch";
import type { ResolvedConfig, StreamOptions } from "../models/config";
import { type LogRecord, nowUnixNano } from "../models/log-record";
import type { StorageAdapter } from "../models/storage";
import type { HttpTransport } from "../transport/http-transport";
import type { RetryEngine } from "../transport/retry-engine";
import { newId } from "../utils/identity";
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

/** Dedicated stream buffer accumulating records until flushed by timer, capacity, or exit flush. */
class RecordStream {
  /** Pending records waiting in chronological order. */
  private pending: LogRecord[] = [];

  /**
   * @param config Active configuration instance.
   * @param name Target stream name.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly config: ResolvedConfig,
    readonly name: StreamName,
    private readonly diagnostics: Diagnostics,
  ) {}

  /** Stream batching configuration options. */
  get options(): StreamOptions {
    return this.config.streams[this.name];
  }

  /** Maximum buffered record capacity before FIFO eviction. */
  private get capacity(): number {
    return Math.max(this.options.batchSize, 1) * PENDING_BUFFER_BATCHES;
  }

  /**
   * Buffers a record, dropping the oldest if capacity is exceeded.
   * @param record Record to enqueue.
   */
  add(record: LogRecord): void {
    if (this.pending.length >= this.capacity) {
      this.pending.shift();
      this.diagnostics.count("record.dropped_pending_full");
    }

    this.pending.push(record);
  }

  /**
   * Drains and returns all buffered records in an atomic operation.
   * @returns Array of buffered records.
   */
  take(): LogRecord[] {
    const records = this.pending;
    this.pending = [];

    return records;
  }
}

/** Pipeline orchestrating log and metric stream buffering, batch creation, and HTTP dispatch. */
export class LogPipeline {
  /** Ingress Subject receiving records pushed into the pipeline. */
  readonly records$ = new Subject<LogRecord>();

  /** Buffer instances for logs and metrics streams. */
  private readonly streams: Record<StreamName, RecordStream>;

  /** Active RxJS subscription managing the pipeline stream. */
  private subscription: Subscription | null = null;

  /** Unconfirmed in-flight batches tracked for exit flush recovery. */
  private readonly unconfirmed = new Map<string, LogBatch>();

  /** Indicates whether the pipeline has been destroyed. */
  private stopped = false;

  /**
   * @param config Active configuration instance.
   * @param transport HTTP transport for live batch delivery.
   * @param storage Storage adapter for offline batch persistence.
   * @param retry Retry engine for redelivering persisted batches.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly transport: HttpTransport,
    private readonly storage: StorageAdapter,
    private readonly retry: RetryEngine,
    private readonly diagnostics: Diagnostics,
  ) {
    this.streams = {
      logs: new RecordStream(config, "logs", diagnostics),
      metrics: new RecordStream(config, "metrics", diagnostics),
    };

    this.subscribe();
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
    this.records$.next(record);
  }

  /**
   * Atomically drains all buffered and unconfirmed in-flight records into a single exit batch.
   * @returns Combined LogBatch or null if no records are pending.
   */
  drainPending(): LogBatch | null {
    const records = [
      ...[...this.unconfirmed.values()].flatMap((batch) => batch.records),
      ...this.streams.metrics.take(),
      ...this.streams.logs.take(),
    ];
    this.unconfirmed.clear();

    if (records.length === 0) {
      return null;
    }

    return { id: newId(), records, createdAt: Date.now(), attempts: 0 };
  }

  /** Re-subscribes RxJS pipeline stream to apply updated interval and batch size settings. */
  refresh(): void {
    this.subscription?.unsubscribe();
    this.subscribe();
  }

  /** Terminates pipeline subscriptions and completes the ingress stream. */
  destroy(): void {
    this.stopped = true;
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.records$.complete();
  }

  /** Assembles and subscribes the partitioned RxJS stream pipeline. */
  private subscribe(): void {
    if (this.stopped) {
      return;
    }

    // Partitions records by type before sampling to evaluate hash once per record.
    const [metric$, log$] = partition(this.records$, isMetric);

    this.subscription = merge(
      this.batches(metric$, this.streams.metrics),
      this.batches(log$, this.streams.logs),
    )
      .pipe(
        // Catches pipeline errors and restarts subscription on failure.
        // Stays ahead of observeOn. Behind it the restart runs a microtask late
        // and records pushed in between reach a Subject with no subscriber.
        catchError((error: unknown) => {
          this.diagnostics.report(
            "pipeline.crashed",
            "the pipeline errored and was restarted",
            undefined,
            error,
          );
          this.subscribe();

          return EMPTY;
        }),

        // Dispatches batch processing on microtask boundary after buffering.
        // Ahead of it, records sit in a microtask queue an unloading document
        // never drains.
        observeOn(asapScheduler),
        mergeMap(
          (batch) =>
            from(this.dispatch(batch)).pipe(
              // Inner catchError isolates individual batch delivery rejections.
              // On the outer chain it completes the stream and logging stops.
              catchError((error: unknown) => {
                this.diagnostics.report(
                  "pipeline.crashed",
                  "dispatch rejected, which it is written never to do",
                  { batchId: batch.id },
                  error,
                );

                return EMPTY;
              }),
            ),
          this.config.maxConcurrentRequests,
        ),
      )
      .subscribe();
  }

  /**
   * Applies sampling, buffers stream records, and triggers timed batch emissions.
   * @param source$ Stream observable emitting records.
   * @param stream Stream buffer managing pending records.
   * @returns Observable emitting closed LogBatch objects.
   */
  private batches(source$: Observable<LogRecord>, stream: RecordStream): Observable<LogBatch> {
    return source$.pipe(
      filter((record) => {
        if (shouldSample(record, this.config)) {
          return true;
        }

        this.diagnostics.count("record.dropped_by_sampling");
        return false;
      }),

      // Buffers records after sampling evaluation. The reverse order buffers
      // dropped records for the life of the tab and beacons them on exit.
      tap((record) => {
        stream.add(record);
      }),

      // Uses bufferTime for trigger cadence while RecordStream owns record
      // retention. The array bufferTime emits is discarded.
      bufferTime(stream.options.flushIntervalMs, null, stream.options.batchSize),
      map(() => this.claim(stream)),
      filter((batch): batch is LogBatch => batch !== null),
    );
  }

  /**
   * Drains the stream buffer into a new LogBatch and tracks it in unconfirmed storage.
   * @param stream Stream buffer to drain.
   * @returns Created LogBatch or null if stream was empty.
   */
  private claim(stream: RecordStream): LogBatch | null {
    const records = stream.take();
    if (records.length === 0) {
      return null;
    }

    const batch: LogBatch = {
      id: newId(),
      records,
      createdAt: Date.now(),
      attempts: 0,
    };
    this.unconfirmed.set(batch.id, batch);

    return batch;
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
        // the batch exceeds storage.maxAttempts by one and attempt headers
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

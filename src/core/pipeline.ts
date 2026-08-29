// src/core/pipeline.ts
//
// Records in, batches out. Logs and metrics buffer under their own policy and
// converge on one dispatcher with a shared concurrency cap.
//
// Each stream owns its buffer: the exit flush must empty everything in the
// current turn, and an operator's buffer cannot be read or reset from outside.

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

/** The two batching policies a record can follow. */
export type StreamName = "logs" | "metrics";

/**
 * Whether a record belongs to the metric stream.
 *
 * @param record The record being routed.
 */
function isMetric(record: LogRecord): boolean {
  return record.attributes[ATTR_LOG_TYPE] === LOG_TYPE_METRIC;
}

/** One stream's records, held until the flush trigger or the exit flush takes them. */
class RecordStream {
  /** Records waiting, in log order. Replaced wholesale by `take`. */
  private pending: LogRecord[] = [];

  /**
   * @param config The live config, read through so a reconfigure applies.
   * @param name Which stream this is.
   * @param diagnostics Where a dropped record is counted.
   */
  constructor(
    private readonly config: ResolvedConfig,
    readonly name: StreamName,
    private readonly diagnostics: Diagnostics,
  ) {}

  /** This stream's batching policy, read through on every use. */
  get options(): StreamOptions {
    return this.config.streams[this.name];
  }

  /**
   * How many records may wait. The floor bounds the buffer for a batch size of
   * zero, which stops the operator flushing on count at all.
   */
  private get capacity(): number {
    return Math.max(this.options.batchSize, 1) * PENDING_BUFFER_BATCHES;
  }

  /**
   * Buffer one record, dropping the oldest once the buffer is full.
   *
   * @param record The record to hold.
   */
  add(record: LogRecord): void {
    if (this.pending.length >= this.capacity) {
      this.pending.shift();
      this.diagnostics.count("record.dropped_pending_full");
    }

    this.pending.push(record);
  }

  /**
   * Take everything buffered, leaving the stream empty.
   *
   * Nothing can interleave between the two statements, which is what stops the
   * flush trigger and the exit flush claiming the same record.
   */
  take(): LogRecord[] {
    const records = this.pending;
    this.pending = [];

    return records;
  }
}

/** The live path: buffers records, forms batches, and delivers or stores them. */
export class LogPipeline {
  /** Where records enter, and the seam a consumer can subscribe to. */
  readonly records$ = new Subject<LogRecord>();

  /** The two buffers. They outlive a resubscribe. */
  private readonly streams: Record<StreamName, RecordStream>;

  /** The live subscription, or null once destroyed. */
  private subscription: Subscription | null = null;

  /**
   * Batches that have left a buffer and are not yet confirmed sent. Without
   * them an exit flush between `claim` and `dispatch` loses those records.
   */
  private readonly unconfirmed = new Map<string, LogBatch>();

  /** True after `destroy`. Nothing is accepted or resubscribed while set. */
  private stopped = false;

  /**
   * @param config The live config object, read through on every use.
   * @param transport How one batch is sent.
   * @param storage Where an undelivered batch waits.
   * @param retry Woken whenever a batch is stored.
   * @param diagnostics Where a dropped record and a broken stream are reported.
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
   * Put one record into the pipeline.
   *
   * @param record The record, stamped here with the time this context saw it.
   */
  push(record: LogRecord): void {
    if (this.stopped) {
      return;
    }

    record.observedTimeUnixNano = nowUnixNano();
    this.records$.next(record);
  }

  /**
   * Everything not yet confirmed sent, as one batch, synchronously, for the
   * exit flush. An in-flight batch goes too and is deduplicated on batch id.
   *
   * @returns The batch, or null when there is nothing to send.
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

  /**
   * Resubscribe against the current config. `bufferTime` captures its interval
   * at subscribe time, so a changed flush interval needs a new subscription.
   */
  refresh(): void {
    this.subscription?.unsubscribe();
    this.subscribe();
  }

  /** Stop accepting records and release the subscription. */
  destroy(): void {
    this.stopped = true;
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.records$.complete();
  }

  /** Build the delivery chain and hold its subscription. */
  private subscribe(): void {
    if (this.stopped) {
      return;
    }

    // Split on the attribute rather than after sampling, so the sampling hash
    // runs once per record instead of once per branch.
    const [metric$, log$] = partition(this.records$, isMetric);

    this.subscription = merge(
      this.batches(metric$, this.streams.metrics),
      this.batches(log$, this.streams.logs),
    )
      .pipe(
        // A throw above leaves the chain dead, so restart it. Before observeOn,
        // or the restart lands a microtask late and drops records pushed since.
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

        // After the buffering: ahead of it a record sits in the microtask queue
        // that an unloading document never drains.
        observeOn(asapScheduler),
        mergeMap(
          (batch) =>
            from(this.dispatch(batch)).pipe(
              // On the inner observable, so a failed batch is one failed batch.
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
   * One stream: sample, buffer, and emit a batch on that stream's schedule.
   *
   * @param source$ The records routed to this stream.
   * @param stream The buffer that holds them.
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

      // Buffered after sampling. The other order accumulates every dropped
      // record for the life of the tab and beacons the lot out on exit.
      tap((record) => {
        stream.add(record);
      }),

      // Taken for its timing and count semantics only. The array it emits is
      // ignored, because `stream` owns the records.
      bufferTime(stream.options.flushIntervalMs, null, stream.options.batchSize),
      map(() => this.claim(stream)),
      filter((batch): batch is LogBatch => batch !== null),
    );
  }

  /**
   * Turn what a stream is holding into a batch, tracked until it is sent.
   *
   * @param stream The buffer to empty.
   * @returns The batch, or null when the exit flush got there first.
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
   * Deliver one batch, or keep it for the retry engine. Never rejects: a
   * rejection reaches the outer chain and kills it.
   *
   * @param batch The batch to send.
   */
  private async dispatch(batch: LogBatch): Promise<void> {
    try {
      // While throttled only the retry engine's backoff may send. Sending here
      // posts a fresh batch every flush interval straight through the throttle.
      const throttledMs = this.transport.throttledForMs();
      if (throttledMs > 0) {
        // Nothing was tried, so nothing counts against the batch.
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
        // Counts the delivery just made. Stored at zero, the batch outruns
        // `storage.maxAttempts` by one and every attempt header under-reports.
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
   * Persist an undelivered batch and wake the retry engine.
   *
   * @param batch The batch to keep, carrying the attempts already spent on it.
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

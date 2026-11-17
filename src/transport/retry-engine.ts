// src/transport/retry-engine.ts
//
// Resends stored log batches in the background, with exponential backoff and jitter.
// There is only ever one timer, never a chain of timers, because every scheduling path
// clears the pending timer first.

import { DRAIN_LOCK_NAME, STORAGE_DEADLINE_MS } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { type LogBatch, splitBatch } from "../models/batch";
import type { BatchKind, ResolvedConfig } from "../models/config";
import type { LossReporter } from "../models/drop";
import { type StorageAdapter, storageLimits } from "../models/storage";
import { withDeadline } from "../utils/deadline";
import { lockName, withDrainLock } from "../utils/lock";
import { isOnline } from "../utils/platform";
import { unrefTimer } from "../utils/unref";
import { TransportError } from "./errors";
import { batchKind } from "./serializers/select";
import type { BatchTransport } from "./status-transport";

/** Result of one delivery. A number is the delay before a failed batch is tried again. */
type Outcome = "next" | "stop" | number;

/**
 * What became of a batch whose live send failed. The pipeline picks its report from this, so
 * the report never promises a resend that can't happen.
 * - "stored": storage holds the whole batch, and the drain sends it again.
 * - "split": the server said the batch is too large, and storage holds its two halves.
 * - "rejected": no later send can succeed, so the engine dropped the batch.
 * - "not_stored": storage didn't keep the batch, or kept only one half of a split.
 */
export type StoreOutcome = "stored" | "split" | "rejected" | "not_stored";

/**
 * Resends persisted offline batches on a timer, with backoff, a cross-tab drain lock and
 * batch splitting.
 */
export class RetryEngine {
  /** The active retry timer handle, or null when no timer is running. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Consecutive failed deliveries. Feeds the backoff calculation. */
  private attempt = 0;

  /** True while a storage drain is running. */
  private draining = false;

  /** True after stop(). */
  private stopped = false;

  /** Attempt limit for a stored batch. Retention can't change after the delivery stack loads. */
  private readonly maxAttempts: number;

  /** Runs on the online event. Resets the attempt count and starts a drain. */
  private readonly onOnline = (): void => {
    this.attempt = 0;
    this.schedule(0);
  };

  /**
   * @param storage Storage adapter holding undelivered batches.
   * @param transport HTTP transport for batch delivery.
   * @param diagnostics Diagnostics reporter.
   * @param config Active configuration instance.
   * @param batchesPerDrain Maximum batches processed per drain tick.
   * @param onLoss Receives the records of every batch that the engine drops.
   */
  constructor(
    private readonly storage: StorageAdapter,
    private readonly transport: BatchTransport,
    private readonly diagnostics: Diagnostics,
    private readonly config: ResolvedConfig,
    private readonly batchesPerDrain?: number,
    private readonly onLoss: LossReporter = () => undefined,
  ) {
    this.maxAttempts = storageLimits(config.retention).maxAttempts;
  }

  /** Starts the engine. Listens for online events and arms the first timer. */
  start(): void {
    this.stopped = false;

    if (typeof addEventListener !== "undefined") {
      addEventListener("online", this.onOnline);
    }

    this.schedule(this.config.delivery.retryIdleDelayMs);
  }

  /** Schedules an earlier retry when storage receives a new offline batch. */
  nudge(): void {
    if (!this.draining) {
      this.schedule(this.config.delivery.retryBaseDelayMs);
    }
  }

  /**
   * Stores a batch that failed outside the drain loop, under the same rules as the drain.
   * A refused batch is never stored whole, because that would cause another request with a
   * payload the server already refused.
   * @param batch Rejected batch, with its attempt already counted.
   * @param error Failure thrown by the transport.
   * @returns What became of the batch. A storage call that throws or runs past its deadline
   * rejects instead, and the caller reports it.
   */
  async storeFailed(batch: LogBatch, error: unknown): Promise<StoreOutcome> {
    const parts = this.toStorable(batch, error);

    if (parts.length === 0) {
      return "rejected";
    }

    let written = 0;

    for (const part of parts) {
      if (await this.bounded(this.storage.save(part))) {
        written++;
      }
    }

    // Only bring the drain forward for a batch that is in storage. With `storage: "none"` an
    // early drain would find nothing to send.
    if (written > 0) {
      this.nudge();
    }

    if (written < parts.length) {
      return "not_stored";
    }

    return parts.length > 1 ? "split" : "stored";
  }

  /** Stops the engine. Removes the listener and clears the pending timer. */
  stop(): void {
    this.stopped = true;

    if (typeof removeEventListener !== "undefined") {
      removeEventListener("online", this.onOnline);
    }

    this.clearTimer();
  }

  /**
   * Tries one delivery pass over the stored batches before a context change. The caller sets
   * the deadline.
   * @returns Promise that resolves when this pass stops.
   */
  async flush(): Promise<void> {
    this.stopped = false;
    try {
      await this.drain();
    } finally {
      this.stop();
    }
  }

  /**
   * Clears the pending timer, then schedules a drain after the delay.
   * @param delayMs Delay duration in milliseconds.
   */
  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.clearTimer();

    const timer = setTimeout(() => {
      void this.drain();
    }, delayMs);

    this.timer = timer;
    unrefTimer(timer);
  }

  /**
   * Puts a deadline on a storage call. A call that never settles would keep
   * `draining` true, and this window would run no more drains.
   * @param work Storage promise to bound.
   * @returns The promise's value, or a rejection after the deadline.
   */
  private bounded<T>(work: Promise<T>): Promise<T> {
    return withDeadline(work, STORAGE_DEADLINE_MS);
  }

  /** Clears the pending timer if there is one. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Calculates the exponential backoff delay from consecutive failures. Uses full jitter
   * instead of a fixed offset, because with a fixed offset tabs that reconnect together send
   * their requests at the same time.
   * @returns Backoff duration in milliseconds.
   */
  private backoffMs(): number {
    const exponential = Math.min(
      this.config.delivery.retryBaseDelayMs * 2 ** this.attempt,
      this.config.delivery.retryMaxDelayMs,
    );

    return Math.random() * exponential;
  }

  /** Runs a drain under the origin-wide Web Lock. */
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;

    try {
      const lock = lockName(DRAIN_LOCK_NAME, this.config.persistence.namespace);
      const ran = await withDrainLock(lock, this.diagnostics, () => this.drainLocked());

      // The value is undefined when another window holds the lock. Without this reschedule,
      // one lost lock race would stop all drains in this window.
      if (ran !== true) {
        this.schedule(this.config.delivery.retryIdleDelayMs);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Processes batches while holding the Web Lock, and schedules the next tick.
   * It always resolves, because a throw would leave the engine idle with no armed timer.
   * @returns Promise that resolves to true on completion.
   */
  private async drainLocked(): Promise<true> {
    try {
      if (!isOnline()) {
        this.schedule(this.config.delivery.retryIdleDelayMs);
        return true;
      }

      const batches = await this.bounded(
        this.storage.take(this.batchesPerDrain ?? this.config.delivery.batchesPerDrain),
      );

      if (batches.length === 0) {
        this.schedule(this.config.delivery.retryIdleDelayMs);
        return true;
      }

      // A failure blocks only its own batch kind. The other endpoints can still accept batches.
      const blocked = new Set<BatchKind>();
      let delayMs = 0;

      for (const batch of batches) {
        if (this.stopped) {
          return true;
        }

        const kind = batchKind(batch, this.config);
        if (blocked.has(kind)) {
          continue;
        }

        const outcome = await this.deliver(batch);
        if (outcome === "stop") {
          return true;
        }

        if (outcome !== "next") {
          blocked.add(kind);
          // Keep the longest delay. A shorter one would send before another server's
          // Retry-After.
          delayMs = Math.max(delayMs, outcome);
        }
      }

      if (blocked.size > 0) {
        this.schedule(delayMs);
      } else {
        this.schedule(
          batches.length === (this.batchesPerDrain ?? this.config.delivery.batchesPerDrain)
            ? 0
            : this.config.delivery.retryIdleDelayMs,
        );
      }
      return true;
    } catch (error) {
      this.diagnostics.report(
        "storage.degraded",
        "The drain loop threw an error.",
        undefined,
        error,
      );
      this.attempt++;
      this.schedule(this.backoffMs());
      return true;
    }
  }

  /**
   * Tries to deliver one batch. Removes it on success, and on failure applies the rule for
   * the failure kind.
   * @param batch Log batch to deliver.
   * @returns "next" to continue with the next batch, "stop" to stop the current drain, or a
   * delay in milliseconds that blocks the batch's kind until the next drain.
   */
  private async deliver(batch: LogBatch): Promise<Outcome> {
    if (batch.attempts >= this.maxAttempts) {
      this.diagnostics.report(
        "storage.dead_lettered",
        `The library dropped a batch after ${batch.attempts.toString()} attempts.`,
        { batchId: batch.id, records: batch.records.length },
      );
      this.onLoss("max_attempts", batch.records, [batch.id]);
      await this.bounded(this.storage.remove(batch.id));
      return "next";
    }

    try {
      await this.transport.send(batch);
      await this.bounded(this.storage.remove(batch.id));
      this.attempt = 0;
      return "next";
    } catch (error) {
      if (this.stopped) return "stop";
      const failure = error instanceof TransportError ? error : undefined;

      if (failure?.kind === "permanent" || failure?.kind === "too_large") {
        await this.replaceStored(batch, error);
        return "next";
      }

      // Offline stops every kind, because the other endpoints aren't reachable either.
      if (failure?.kind === "offline") {
        this.schedule(this.config.delivery.retryIdleDelayMs);
        return "stop";
      }

      // A throttle rejects no records. The server only asks for the batch later, so don't bump
      // the stored attempts here. A bump would dead-letter the batch after
      // `retention.maxAttempts` throttled responses.
      if (failure?.kind === "throttled") {
        this.attempt++;
        return failure.retryAfterMs ?? this.backoffMs();
      }

      await this.bounded(this.storage.bumpAttempts(batch.id, batch.attempts + 1));
      this.attempt++;
      return failure?.retryAfterMs ?? this.backoffMs();
    }
  }

  /**
   * Replaces a stored batch with whatever survives its failure. That is the split halves,
   * or nothing after a permanent refusal.
   * @param batch Rejected log batch, already held in storage.
   * @param error Failure thrown by the transport.
   */
  private async replaceStored(batch: LogBatch, error: unknown): Promise<void> {
    const parts = this.toStorable(batch, error);
    await this.bounded(this.storage.remove(batch.id));

    for (const part of parts) {
      await this.bounded(this.storage.save(part));
    }
  }

  /**
   * Picks the batches to keep after a failure. A 413 response splits the batch in two, a
   * permanent refusal keeps nothing, and any other failure keeps the batch whole.
   * @param batch Rejected log batch.
   * @param error Failure thrown by the transport.
   * @returns Batches to persist. The array is empty when the engine drops the records.
   */
  private toStorable(batch: LogBatch, error: unknown): LogBatch[] {
    const failure = error instanceof TransportError ? error : undefined;

    if (failure?.kind === "permanent") {
      this.onLoss("rejected", batch.records, [batch.id]);
      return [];
    }

    if (failure?.kind !== "too_large") {
      return [batch];
    }

    const halves = splitBatch(batch, this.diagnostics);

    if (!halves) {
      this.diagnostics.report(
        "transport.dropped_permanent",
        "One record is larger than the server limit. The library dropped it.",
        {
          batchId: batch.id,
          bodies: batch.records.map((record) => record.body),
        },
      );
      this.onLoss("rejected", batch.records, [batch.id]);
      return [];
    }

    this.diagnostics.report(
      "transport.batch_split",
      "The server refused the batch because it is too large.",
      {
        from: batch.records.length,
        to: halves[0].records.length,
        serverMaxBytes: failure.maxBytes,
      },
    );

    return halves;
  }
}

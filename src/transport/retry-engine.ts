// src/transport/retry-engine.ts
//
// This module sends stored log batches again in the background. It uses exponential
// backoff with jitter. It keeps one timer, never a chain of timers. Each scheduling path
// clears the pending timer first.

import {
  BATCHES_PER_DRAIN,
  DRAIN_LOCK_NAME,
  RETRY_BASE_DELAY_MS,
  RETRY_IDLE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  STORAGE_DEADLINE_MS,
  STORAGE_LIMITS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { type LogBatch, splitBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { StorageAdapter } from "../models/storage";
import { withDeadline } from "../utils/deadline";
import { withDrainLock } from "../utils/lock";
import { unrefTimer } from "../utils/unref";
import { TransportError } from "./errors";
import type { BatchTransport } from "./status-transport";

/**
 * This class sends persisted offline batches again on a timer. It uses backoff, a cross-tab
 * drain lock and batch splitting.
 */
export class RetryEngine {
  /** This field holds the active retry timer handle. It is null when no timer runs. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** This field counts consecutive failed deliveries. The backoff calculation uses it. */
  private attempt = 0;

  /** This flag is true while a storage drain runs. */
  private draining = false;

  /** This flag is true after stop(). */
  private stopped = false;

  /** This listener runs on the online event. It resets the attempt count and starts a drain. */
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
   */
  constructor(
    private readonly storage: StorageAdapter,
    private readonly transport: BatchTransport,
    private readonly diagnostics: Diagnostics,
    private readonly config: ResolvedConfig,
    private readonly batchesPerDrain = BATCHES_PER_DRAIN,
  ) {}

  /** This method starts the engine. It listens for online events and arms the first timer. */
  start(): void {
    this.stopped = false;

    if (typeof addEventListener !== "undefined") {
      addEventListener("online", this.onOnline);
    }

    this.schedule(RETRY_IDLE_DELAY_MS);
  }

  /** This method schedules an earlier retry when storage receives a new offline batch. */
  nudge(): void {
    if (!this.draining) {
      this.schedule(RETRY_BASE_DELAY_MS);
    }
  }

  /**
   * Stores a batch that failed outside the drain loop. It applies the same rules
   * as the drain. It does not store a refused batch whole. A whole batch causes another request
   * with a payload that the server refused.
   * @param batch Rejected batch, with its attempt already counted.
   * @param error Failure thrown by the transport.
   */
  async storeFailed(batch: LogBatch, error: unknown): Promise<void> {
    const parts = this.toStorable(batch, error);

    for (const part of parts) {
      await this.bounded(this.storage.save(part));
    }

    if (parts.length > 0) {
      this.nudge();
    }
  }

  /** This method stops the engine. It removes the listener and clears the pending timer. */
  stop(): void {
    this.stopped = true;

    if (typeof removeEventListener !== "undefined") {
      removeEventListener("online", this.onOnline);
    }

    this.clearTimer();
  }

  /**
   * Clears the pending timer. It then schedules a drain after the delay.
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
   * Sets a deadline on a storage call. A call that does not settle keeps
   * `draining` true. This window then runs no more drains.
   * @param work Storage promise to bound.
   * @returns The value of the promise, or a rejection after the deadline.
   */
  private bounded<T>(work: Promise<T>): Promise<T> {
    return withDeadline(work, STORAGE_DEADLINE_MS);
  }

  /** This method clears the pending timer when a timer is active. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Calculates the exponential backoff delay from consecutive failures. It applies
   * full jitter, not a fixed offset. With a fixed offset, tabs that reconnect together send
   * their requests at the same time.
   * @returns Backoff duration in milliseconds.
   */
  private backoffMs(): number {
    const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** this.attempt, RETRY_MAX_DELAY_MS);

    return Math.random() * exponential;
  }

  /** This method runs a drain under the origin-wide Web Lock. */
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;

    try {
      const ran = await withDrainLock(DRAIN_LOCK_NAME, this.diagnostics, () => this.drainLocked());

      // The value is undefined when another window holds the lock. Without this reschedule,
      // one lost lock race stops all drains in this window.
      if (ran !== true) {
        this.schedule(RETRY_IDLE_DELAY_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Processes batches while it holds the Web Lock. It schedules the next tick.
   * It always resolves. A throw leaves the engine idle with no armed timer.
   * @returns Promise that resolves to true on completion.
   */
  private async drainLocked(): Promise<true> {
    try {
      const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
      if (online === false) {
        this.schedule(RETRY_IDLE_DELAY_MS);
        return true;
      }

      const batches = await this.bounded(this.storage.take(this.batchesPerDrain));

      if (batches.length === 0) {
        this.schedule(RETRY_IDLE_DELAY_MS);
        return true;
      }

      for (const batch of batches) {
        if (this.stopped) {
          return true;
        }

        const done = await this.deliver(batch);
        if (!done) {
          return true;
        }
      }

      this.schedule(batches.length === this.batchesPerDrain ? 0 : RETRY_IDLE_DELAY_MS);
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
   * Tries to deliver one batch. It removes the batch on success. On failure, it applies the
   * rule for the failure kind.
   * @param batch Log batch to deliver.
   * @returns True to continue with the next batch. False to stop the current drain.
   */
  private async deliver(batch: LogBatch): Promise<boolean> {
    if (batch.attempts >= STORAGE_LIMITS.maxAttempts) {
      this.diagnostics.report(
        "storage.dead_lettered",
        `The library dropped a batch after ${batch.attempts.toString()} attempts.`,
        { batchId: batch.id, records: batch.records.length },
      );
      await this.bounded(this.storage.remove(batch.id));
      return true;
    }

    try {
      await this.transport.send(batch);
      await this.bounded(this.storage.remove(batch.id));
      this.attempt = 0;
      return true;
    } catch (error) {
      const failure = error instanceof TransportError ? error : undefined;

      if (failure?.kind === "permanent" || failure?.kind === "too_large") {
        await this.replaceStored(batch, error);
        return true;
      }

      if (failure?.kind === "offline") {
        this.schedule(RETRY_IDLE_DELAY_MS);
        return false;
      }

      // A throttle rejects no records. The server asks for the batch later. Do not bump the
      // stored attempts here. A bump dead-letters the batch after five throttled responses.
      if (failure?.kind === "throttled") {
        this.attempt++;
        this.schedule(failure.retryAfterMs ?? this.backoffMs());
        return false;
      }

      await this.bounded(this.storage.bumpAttempts(batch.id, batch.attempts + 1));
      this.attempt++;
      this.schedule(failure?.retryAfterMs ?? this.backoffMs());
      return false;
    }
  }

  /**
   * Replaces a stored batch with the parts that survive its failure. The parts
   * are the split halves, or nothing after a permanent refusal.
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
   * Selects the batches to keep after a failure. A 413 response splits the batch
   * in two. A permanent refusal keeps nothing. Each other failure keeps the batch whole.
   * @param batch Rejected log batch.
   * @param error Failure thrown by the transport.
   * @returns Batches to persist. The array is empty when the engine drops the records.
   */
  private toStorable(batch: LogBatch, error: unknown): LogBatch[] {
    const failure = error instanceof TransportError ? error : undefined;

    if (failure?.kind === "permanent") {
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

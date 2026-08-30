// src/transport/retry-engine.ts
//
// Scheduled background redelivery of stored log batches using jittered exponential
// backoff. One timer, never a chain. Every scheduling path clears the pending
// timer first.

import { BATCHES_PER_DRAIN, DRAIN_LOCK_NAME } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { type LogBatch, splitBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { StorageAdapter } from "../models/storage";
import { withDrainLock } from "../utils/lock";
import { unrefTimer } from "../utils/unref";
import { TransportError } from "./errors";
import type { HttpTransport } from "./http-transport";

/** Manages timed redelivery of persisted offline batches with backoff, lock coordination, and batch splitting. */
export class RetryEngine {
  /** Active retry timer handle or null if unreserved. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Consecutive failed delivery attempts for exponential backoff calculation. */
  private attempt = 0;

  /** Indicates whether a storage drain operation is actively executing. */
  private draining = false;

  /** Indicates whether the engine is stopped. */
  private stopped = false;

  /** Online event listener resetting attempts and scheduling immediate drain. */
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
    private readonly transport: HttpTransport,
    private readonly diagnostics: Diagnostics,
    private readonly config: ResolvedConfig,
    private readonly batchesPerDrain = BATCHES_PER_DRAIN,
  ) {}

  /** Starts the retry engine, listens for online events, and arms the initial timer. */
  start(): void {
    this.stopped = false;

    if (typeof addEventListener !== "undefined") {
      addEventListener("online", this.onOnline);
    }

    this.schedule(this.config.retry.idleDelayMs);
  }

  /** Triggers an accelerated retry schedule when a new batch is stored offline. */
  nudge(): void {
    if (!this.draining) {
      this.schedule(this.config.retry.baseDelayMs);
    }
  }

  /** Halts retry execution, removes listeners, and clears pending timers. */
  stop(): void {
    this.stopped = true;

    if (typeof removeEventListener !== "undefined") {
      removeEventListener("online", this.onOnline);
    }

    this.clearTimer();
  }

  /**
   * Clears existing timers and schedules a new drain execution after a delay.
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

  /** Clears the pending timer handle if active. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Computes jittered exponential backoff delay based on consecutive failures. Full
   * jitter, not a fixed offset. Tabs reconnecting together stampede otherwise.
   * @returns Backoff duration in milliseconds.
   */
  private backoffMs(): number {
    const exponential = Math.min(
      this.config.retry.baseDelayMs * 2 ** this.attempt,
      this.config.retry.maxDelayMs,
    );

    return Math.random() * exponential;
  }

  /** Executes a drain operation protected by the origin-wide Web Lock. */
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;

    try {
      const ran = await withDrainLock(DRAIN_LOCK_NAME, this.diagnostics, () => this.drainLocked());

      // undefined means the lock was held elsewhere. Without the reschedule, one
      // lost race retires this window.
      if (ran !== true) {
        this.schedule(this.config.retry.idleDelayMs);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Processes batches while holding the Web Lock and schedules subsequent ticks.
   * Always resolves. A throw leaves the engine idle with no timer armed.
   * @returns Promise resolving to true on completion.
   */
  private async drainLocked(): Promise<true> {
    try {
      const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
      if (online === false) {
        this.schedule(this.config.retry.idleDelayMs);
        return true;
      }

      const batches = await this.storage.take(this.batchesPerDrain);

      if (batches.length === 0) {
        this.schedule(this.config.retry.idleDelayMs);
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

      this.schedule(batches.length === this.batchesPerDrain ? 0 : this.config.retry.idleDelayMs);
      return true;
    } catch (error) {
      this.diagnostics.report("storage.degraded", "the drain loop threw", undefined, error);
      this.attempt++;
      this.schedule(this.backoffMs());
      return true;
    }
  }

  /**
   * Attempts delivery of a single batch, removing it on success or handling errors.
   * @param batch Log batch to deliver.
   * @returns True to continue processing next batch; false to halt current drain.
   */
  private async deliver(batch: LogBatch): Promise<boolean> {
    if (batch.attempts >= this.config.storage.maxAttempts) {
      this.diagnostics.report(
        "storage.dead_lettered",
        `giving up on a batch after ${batch.attempts.toString()} attempts`,
        { batchId: batch.id, records: batch.records.length },
      );
      await this.storage.remove(batch.id);
      return true;
    }

    try {
      await this.transport.send(batch);
      await this.storage.remove(batch.id);
      this.attempt = 0;
      return true;
    } catch (error) {
      const failure = error instanceof TransportError ? error : undefined;

      if (failure?.kind === "permanent") {
        await this.storage.remove(batch.id);
        return true;
      }

      if (failure?.kind === "too_large") {
        await this.splitStored(batch, failure.maxBytes);
        return true;
      }

      if (failure?.kind === "offline") {
        this.schedule(this.config.retry.idleDelayMs);
        return false;
      }

      await this.storage.bumpAttempts(batch.id, batch.attempts + 1);
      this.attempt++;
      this.schedule(failure?.retryAfterMs ?? this.backoffMs());
      return false;
    }
  }

  /**
   * Splits an oversized batch into two smaller stored batches after a 413 rejection.
   * @param batch Rejected log batch.
   * @param serverMaxBytes Optional byte limit reported by the server.
   */
  private async splitStored(batch: LogBatch, serverMaxBytes: number | undefined): Promise<void> {
    const halves = splitBatch(batch);
    await this.storage.remove(batch.id);

    if (!halves) {
      this.diagnostics.report(
        "transport.dropped_permanent",
        "a single record exceeds the server limit and was dropped",
        {
          batchId: batch.id,
          bodies: batch.records.map((record) => record.body),
        },
      );
      return;
    }

    this.diagnostics.report("transport.batch_split", "the server refused the batch as too large", {
      from: batch.records.length,
      to: halves[0].records.length,
      serverMaxBytes,
    });

    for (const half of halves) {
      await this.storage.save(half);
    }
  }
}

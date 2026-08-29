// src/transport/retry-engine.ts
//
// Redelivery of stored batches. One timer, never a chain: every scheduling path
// goes through `schedule()`, which clears the pending handle first. A fresh
// timer per `online` event multiplies its own polling until the tab crawls.
//
// Classification belongs to the transport. What happens to the batch belongs
// here.

import { BATCHES_PER_DRAIN, DRAIN_LOCK_NAME } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { type LogBatch, splitBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { StorageAdapter } from "../models/storage";
import { withDrainLock } from "../utils/lock";
import { unrefTimer } from "../utils/unref";
import { TransportError } from "./errors";
import type { HttpTransport } from "./http-transport";

/** Sends what storage is holding, on a timer, until the queue is empty. */
export class RetryEngine {
  /** The one pending timer. Null when none is armed. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Consecutive failed attempts. The exponent in the backoff. */
  private attempt = 0;

  /** True while a drain is in flight, so a timer that fires meanwhile does nothing. */
  private draining = false;

  /** True between `stop()` and the next `start()`. Nothing schedules while set. */
  private stopped = false;

  /** Back online: drop the accumulated backoff and drain now. */
  private readonly onOnline = () => {
    this.attempt = 0;
    this.schedule(0);
  };

  /**
   * @param storage Where undelivered batches wait.
   * @param transport How one is sent.
   * @param diagnostics Where a dead-lettered batch and a broken drain are reported.
   * @param config The live config object, read through on every use.
   * @param batchesPerDrain Stored batches one tick sends.
   */
  constructor(
    private readonly storage: StorageAdapter,
    private readonly transport: HttpTransport,
    private readonly diagnostics: Diagnostics,
    private readonly config: ResolvedConfig,
    private readonly batchesPerDrain = BATCHES_PER_DRAIN,
  ) {}

  /** Arm the idle timer and start listening for the connection coming back. */
  start(): void {
    this.stopped = false;

    // Undeclared outside a browser and a worker, so `typeof` rather than a
    // property read.
    if (typeof addEventListener !== "undefined") {
      addEventListener("online", this.onOnline);
    }

    this.schedule(this.config.retry.idleDelayMs);
  }

  /** Called the moment a batch is stored, so recovery is not left to the idle timer. */
  nudge(): void {
    if (!this.draining) {
      this.schedule(this.config.retry.baseDelayMs);
    }
  }

  /** Stop draining and release the timer. `start()` resumes. */
  stop(): void {
    this.stopped = true;

    if (typeof removeEventListener !== "undefined") {
      removeEventListener("online", this.onOnline);
    }

    this.clearTimer();
  }

  /**
   * Replace the pending timer with one firing in `delayMs`.
   *
   * @param delayMs How long to wait. Zero means the next macrotask.
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

  /** Drop the pending timer. Zero is a legal handle, so this tests for null. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * The delay before the next attempt. Full jitter, not a fixed offset added to
   * a delay: tabs that reconnect together would otherwise stampede the endpoint.
   */
  private backoffMs(): number {
    const exponential = Math.min(
      this.config.retry.baseDelayMs * 2 ** this.attempt,
      this.config.retry.maxDelayMs,
    );

    return Math.random() * exponential;
  }

  /** One tick: take the origin-wide lock, drain under it, and make sure a next tick exists. */
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;

    try {
      // Origin-wide, so five open windows do not each send the same stored
      // batches. A window already draining hands back a null grant.
      const ran = await withDrainLock(DRAIN_LOCK_NAME, this.diagnostics, () => this.drainLocked());

      // `undefined` means the lock was held elsewhere and nothing ran. Without
      // the reschedule, losing one race retires this window for good.
      if (ran !== true) {
        this.schedule(this.config.retry.idleDelayMs);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Send what is waiting, holding the lock. Always arms the next tick before it
   * returns, and always resolves: a throw here would leave the engine idle.
   */
  private async drainLocked(): Promise<true> {
    try {
      const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
      if (online === false) {
        this.schedule(this.config.retry.idleDelayMs);
        return true;
      }

      const batches = await this.storage.take(this.batchesPerDrain);

      // The attempt counter stays where it is: an idle app would otherwise
      // climb to the maximum backoff and stay there.
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

      // A full tick means there may be more waiting.
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
   * Deliver one batch and dispose of it.
   *
   * @returns True to carry on with the next batch. False to stop the loop, with
   * the timer for the next attempt already armed.
   */
  private async deliver(batch: LogBatch): Promise<boolean> {
    // A batch retried forever blocks every batch behind it.
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
      // Anything the transport did not classify is treated as transient.
      const failure = error instanceof TransportError ? error : undefined;

      if (failure?.kind === "permanent") {
        await this.storage.remove(batch.id);
        return true;
      }

      if (failure?.kind === "too_large") {
        await this.splitStored(batch, failure.maxBytes);
        return true;
      }

      // Nothing was tried, so nothing is counted against the batch.
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
   * Replace an oversized batch with two stored halves.
   *
   * Split here rather than in the transport: each half gets its own id and its
   * own delivery record. Splitting inside one send redelivers the half that
   * succeeded under an id the server has never seen.
   *
   * @param batch The batch the server rejected.
   * @param serverMaxBytes The limit the server named, where it named one.
   */
  private async splitStored(batch: LogBatch, serverMaxBytes: number | undefined): Promise<void> {
    const halves = splitBatch(batch);
    await this.storage.remove(batch.id);

    // One record the server will never accept. Retrying it forever would block
    // every batch behind it.
    if (!halves) {
      this.diagnostics.report(
        "transport.dropped_permanent",
        "a single record exceeds the server limit and was dropped",
        { batchId: batch.id, bodies: batch.records.map((record) => record.body) },
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

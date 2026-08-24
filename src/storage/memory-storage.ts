// src/storage/memory-storage.ts
//
// The last resort, and the reference implementation. Everything the other
// adapters do, without a store that can refuse a write.
//
// A document that reloads loses what is here, which is the whole difference
// between this and the other two. It is still better than dropping records the
// moment a send fails.

import { STORAGE_NAME_MEMORY } from "../constants";
import type { LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";

/** How many records a set of batches holds, which is the size of the hole they leave. */
function countRecords(batches: LogBatch[]): number {
  return batches.reduce((total, batch) => total + batch.records.length, 0);
}

/** Batches held in an array. Survives nothing, refuses nothing. */
export class MemoryStorage implements StorageAdapter {
  /** The adapter name, which is also the strategy that selects it. */
  readonly name = STORAGE_NAME_MEMORY;

  /** Oldest first, which is the order `take` is required to return. */
  private batches: LogBatch[] = [];

  /**
   * @param limits Age and count ceilings.
   * @param onGap Told when a prune drops records.
   */
  constructor(
    private readonly limits: StorageLimits,
    private readonly onGap?: GapReporter,
  ) {}

  /** @param batch The batch to keep. Pruning follows, so the ceilings hold after every save. */
  async save(batch: LogBatch): Promise<void> {
    this.batches.push(batch);
    await this.prune();
  }

  /** @param limit How many to hand back. */
  take(limit: number): Promise<LogBatch[]> {
    return Promise.resolve(this.batches.slice(0, limit));
  }

  /** @param id The batch that was delivered, or given up on. */
  remove(id: string): Promise<void> {
    this.batches = this.batches.filter((batch) => batch.id !== id);
    return Promise.resolve();
  }

  /**
   * @param id The batch that was tried.
   * @param attempts Its new attempt count.
   */
  bumpAttempts(id: string, attempts: number): Promise<void> {
    const found = this.batches.find((batch) => batch.id === id);
    if (found) {
      found.attempts = attempts;
    }
    return Promise.resolve();
  }

  /** Drop what is too old, then what is over capacity. Oldest first in both passes. */
  prune(): Promise<PruneResult> {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    const expired = this.batches.filter((batch) => batch.createdAt < cutoff);
    this.batches = this.batches.filter((batch) => batch.createdAt >= cutoff);
    result.batches += expired.length;
    result.records += countRecords(expired);

    const excess = this.batches.length - this.limits.maxBatches;
    if (excess > 0) {
      result.reason = "over_capacity";
      const evicted = this.batches.slice(0, excess);
      this.batches = this.batches.slice(excess);
      result.batches += evicted.length;
      result.records += countRecords(evicted);
    }

    if (result.batches > 0) {
      this.onGap?.(result);
    }

    return Promise.resolve(result);
  }

  /** How many batches are waiting. */
  count(): Promise<number> {
    return Promise.resolve(this.batches.length);
  }

  /** Forget every batch. */
  clear(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }

  /** Nothing to release, so this is `clear` under the name the interface uses. */
  close(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }
}

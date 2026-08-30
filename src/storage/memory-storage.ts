// src/storage/memory-storage.ts
//
// In-memory fallback storage adapter for volatile batch retention during offline
// periods. A reload loses everything here. Last resort adapter.

import { STORAGE_NAME_MEMORY } from "../constants";
import type { LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";

/**
 * Sums the total count of records contained across an array of batches.
 * @param batches Batches to measure.
 * @returns Total record count.
 */
function countRecords(batches: LogBatch[]): number {
  return batches.reduce((total, batch) => total + batch.records.length, 0);
}

/** In-memory StorageAdapter implementation retaining batches in volatile memory. */
export class MemoryStorage implements StorageAdapter {
  /** Storage adapter strategy name. */
  readonly name = STORAGE_NAME_MEMORY;

  /** Internal array holding batches in chronological FIFO order. */
  private batches: LogBatch[] = [];

  /**
   * @param limits Storage capacity and retention thresholds.
   * @param onGap Optional callback for dropped record reporting.
   */
  constructor(
    private readonly limits: StorageLimits,
    private readonly onGap?: GapReporter,
  ) {}

  /**
   * Appends a batch to memory storage and applies retention pruning.
   * @param batch Batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    this.batches.push(batch);
    await this.prune();
  }

  /**
   * Retrieves up to limit batches in chronological order without deletion.
   * @param limit Maximum number of batches to retrieve.
   * @returns Promise resolving to an array of batches.
   */
  take(limit: number): Promise<LogBatch[]> {
    return Promise.resolve(this.batches.slice(0, limit));
  }

  /**
   * Deletes a batch from memory storage by batch ID.
   * @param id Batch identifier.
   */
  remove(id: string): Promise<void> {
    this.batches = this.batches.filter((batch) => batch.id !== id);
    return Promise.resolve();
  }

  /**
   * Updates delivery attempt count for a stored batch.
   * @param id Batch identifier.
   * @param attempts New absolute attempt count.
   */
  bumpAttempts(id: string, attempts: number): Promise<void> {
    const found = this.batches.find((batch) => batch.id === id);
    if (found) {
      found.attempts = attempts;
    }
    return Promise.resolve();
  }

  /**
   * Removes expired batches and evicts oldest entries exceeding capacity limits.
   * @returns Promise resolving to prune summary metrics.
   */
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

  /**
   * Returns total count of stored batches.
   * @returns Promise resolving to batch count.
   */
  count(): Promise<number> {
    return Promise.resolve(this.batches.length);
  }

  /** Clears all stored batches from memory. */
  clear(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }

  /** Clears stored batches on storage teardown. */
  close(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }
}

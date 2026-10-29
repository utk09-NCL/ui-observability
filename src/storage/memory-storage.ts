// src/storage/memory-storage.ts
//
// This module keeps batches in volatile memory during offline periods. A reload loses all of
// them. This adapter is the last fallback.

import { STORAGE_NAME_MEMORY } from "../constants";
import type { LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";
import { hasAction, pickEvictable } from "./eviction";

/**
 * Returns the total record count of the batches.
 * @param batches Batches to measure.
 * @returns Total record count.
 */
function countRecords(batches: LogBatch[]): number {
  return batches.reduce((total, batch) => total + batch.records.length, 0);
}

/** This StorageAdapter keeps batches in volatile memory. */
export class MemoryStorage implements StorageAdapter {
  /** This field holds the storage strategy name. */
  readonly name = STORAGE_NAME_MEMORY;

  /** This array holds the batches in FIFO order. */
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
   * Appends a batch and applies retention pruning.
   * @param batch Batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    this.batches.push(batch);
    await this.prune();
  }

  /**
   * Returns up to `limit` batches in FIFO order. It does not delete them.
   * @param limit Maximum number of batches to retrieve.
   * @returns Promise that resolves to an array of batches.
   */
  take(limit: number): Promise<LogBatch[]> {
    return Promise.resolve(this.batches.slice(0, limit));
  }

  /**
   * Deletes the batch with the given ID.
   * @param id Batch identifier.
   */
  remove(id: string): Promise<void> {
    this.batches = this.batches.filter((batch) => batch.id !== id);
    return Promise.resolve();
  }

  /**
   * Sets the delivery attempt count of a stored batch.
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
   * Removes expired batches. It then removes the oldest batches above the
   * capacity limit.
   * @returns Promise that resolves to prune summary metrics.
   */
  prune(): Promise<PruneResult> {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    const expired = this.batches.filter((batch) => batch.createdAt < cutoff);
    this.batches = this.batches.filter((batch) => batch.createdAt >= cutoff);
    this.report(result, "expired", expired);

    const excess = this.batches.length - this.limits.maxBatches;
    if (excess > 0) {
      // An action is an audit fact. Evict each batch without an action first.
      const evicted = pickEvictable(this.batches, excess, hasAction);
      this.batches = this.batches.filter((batch) => !evicted.includes(batch));
      this.report(result, "over_capacity", evicted);
    }

    return Promise.resolve(result);
  }

  /**
   * Adds dropped batches to the prune result. It reports them with their own reason.
   * @param result Prune result of all rules.
   * @param reason Rule that dropped the batches.
   * @param dropped The dropped batches.
   */
  private report(result: PruneResult, reason: PruneResult["reason"], dropped: LogBatch[]): void {
    if (dropped.length === 0) {
      return;
    }

    const records = countRecords(dropped);
    result.batches += dropped.length;
    result.records += records;
    result.reason = reason;
    this.onGap?.({ batches: dropped.length, records, reason }, dropped);
  }

  /**
   * Returns the number of stored batches.
   * @returns Promise that resolves to batch count.
   */
  count(): Promise<number> {
    return Promise.resolve(this.batches.length);
  }

  /** This method deletes all stored batches. */
  clear(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }

  /** This method deletes all stored batches when the storage closes. */
  close(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }
}

// src/storage/memory-storage.ts
//
// Keeps batches in volatile memory during offline periods, so a reload loses all of them.
// This adapter is the last fallback.

import { STORAGE_NAME_MEMORY } from "../constants";
import { countRecords, type LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";
import { hasAction, pickEvictable } from "./eviction";
import { addDrop } from "./gap";

/** StorageAdapter that keeps batches in volatile memory. */
export class MemoryStorage implements StorageAdapter {
  /** The storage strategy name. */
  readonly name = STORAGE_NAME_MEMORY;

  /** The batches, in FIFO order. */
  private batches: LogBatch[] = [];

  /**
   * @param limits Storage capacity and retention thresholds.
   * @param onGap Optional callback for reporting dropped records.
   */
  constructor(
    private readonly limits: StorageLimits,
    private readonly onGap?: GapReporter,
  ) {}

  /**
   * Appends a batch and applies retention pruning.
   * @param batch The batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    // A batch with a known id replaces the old copy in place, as IndexedDB put() does.
    const index = this.batches.findIndex((stored) => stored.id === batch.id);
    if (index >= 0) {
      this.batches[index] = batch;
    } else {
      this.batches.push(batch);
    }
    await this.prune();
  }

  /**
   * Returns up to `limit` batches in FIFO order without deleting them.
   * @param limit Maximum number of batches to retrieve.
   * @returns A promise that resolves to the batches.
   */
  take(limit: number): Promise<LogBatch[]> {
    return Promise.resolve(this.batches.slice(0, limit));
  }

  /**
   * Returns up to `limit` batches of one context in FIFO order without deleting them.
   * @param id Delivery context id.
   * @param limit Maximum number of batches to retrieve.
   * @returns A promise that resolves to this context's batches.
   */
  takeContext(id: string, limit: number): Promise<LogBatch[]> {
    return Promise.resolve(
      this.batches.filter((batch) => batch.routingContextId === id).slice(0, limit),
    );
  }

  /**
   * Counts one context's stored batches.
   * @param id Delivery context id.
   * @returns A promise that resolves to this context's batch count.
   */
  countContext(id: string): Promise<number> {
    return Promise.resolve(this.batches.filter((batch) => batch.routingContextId === id).length);
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
   * Sets a stored batch's delivery attempt count.
   * @param id Batch identifier.
   * @param attempts The new absolute attempt count.
   */
  bumpAttempts(id: string, attempts: number): Promise<void> {
    const found = this.batches.find((batch) => batch.id === id);
    if (found) {
      found.attempts = attempts;
    }
    return Promise.resolve();
  }

  /**
   * Removes expired batches, then the oldest batches above the capacity limit.
   * @returns A promise that resolves to the prune summary metrics.
   */
  prune(): Promise<PruneResult> {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    const expired = this.batches.filter((batch) => batch.createdAt < cutoff);
    this.batches = this.batches.filter((batch) => batch.createdAt >= cutoff);
    this.report(result, "expired", expired);

    const excess = this.batches.length - this.limits.maxBatches;
    if (excess > 0) {
      // An action is an audit fact, so evict the batches without one first.
      const evicted = pickEvictable(this.batches, excess, hasAction);
      this.batches = this.batches.filter((batch) => !evicted.includes(batch));
      this.report(result, "over_capacity", evicted);
    }

    return Promise.resolve(result);
  }

  /**
   * Adds dropped batches to the prune result and reports them under their own reason.
   * @param result The prune result across all rules.
   * @param reason The rule that dropped the batches.
   * @param dropped The dropped batches.
   */
  private report(result: PruneResult, reason: PruneResult["reason"], dropped: LogBatch[]): void {
    if (dropped.length === 0) {
      return;
    }

    const gap = addDrop(result, reason, dropped.length, countRecords(dropped));
    this.onGap?.(gap, dropped);
  }

  /**
   * Returns the number of stored batches.
   * @returns A promise that resolves to the batch count.
   */
  count(): Promise<number> {
    return Promise.resolve(this.batches.length);
  }

  /** Deletes every stored batch. */
  clear(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }

  /** Deletes every stored batch when the storage closes. */
  close(): Promise<void> {
    this.batches = [];
    return Promise.resolve();
  }
}

// src/storage/indexeddb-storage.ts
//
// This module stores batches in IndexedDB. It indexes them by creation time.

import { QUOTA_EVICTION_DIVISOR, QUOTA_EXCEEDED_ERROR, STORAGE_NAME_INDEXEDDB } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { countRecords, type LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";
import { EvictionPick, hasAction } from "./eviction";
import { addDrop, reportEviction } from "./gap";
import { IdbDriver } from "./idb-driver";

/** This StorageAdapter keeps batches in IndexedDB. */
export class IndexedDbStorage implements StorageAdapter {
  /** This field holds the storage strategy name. */
  readonly name = STORAGE_NAME_INDEXEDDB;

  /** This driver holds the IndexedDB code for the batch store. */
  private readonly db: IdbDriver;

  /**
   * @param dbName Database name.
   * @param limits Storage capacity and retention thresholds.
   * @param diagnostics Diagnostics reporter.
   * @param onGap Optional callback for dropped record reporting.
   */
  constructor(
    dbName: string,
    private readonly limits: StorageLimits,
    private readonly diagnostics: Diagnostics,
    private readonly onGap?: GapReporter,
  ) {
    this.db = new IdbDriver(dbName);
  }

  /**
   * Opens the database. It has no guard. The factory needs the rejection to
   * select the next adapter.
   */
  async open(): Promise<void> {
    await this.db.ready();
  }

  /**
   * Writes a batch to IndexedDB. It then prunes the storage.
   * @param batch Batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    try {
      await this.db.put(batch);
      await this.prune();
    } catch (error) {
      if (error instanceof Error && error.name === QUOTA_EXCEEDED_ERROR) {
        this.diagnostics.report(
          "storage.quota_exceeded",
          "IndexedDB is full. The library removes the oldest batches.",
        );
        const evicted = await this.diagnostics.guardAsync(
          "storage.degraded",
          "The library could not remove old batches after a full disk.",
          () => this.evictOldest(Math.ceil(this.limits.maxBatches / QUOTA_EVICTION_DIVISOR)),
        );
        if (evicted) {
          const records = countRecords(evicted);
          const gap: PruneResult = { batches: evicted.length, records, reason: "quota" };
          reportEviction(this.diagnostics, this.onGap, gap, evicted);
        }

        // The eviction makes room for this batch. Without a second write, save() resolves.
        // The library then loses the batch. No counter shows the loss.
        const stored = await this.diagnostics.guardAsync(
          "storage.degraded",
          "The library could not write the batch after it removed old batches.",
          async () => {
            await this.db.put(batch);
            return true;
          },
        );
        if (stored !== true) {
          const gap: PruneResult = { batches: 1, records: batch.records.length, reason: "quota" };
          reportEviction(this.diagnostics, this.onGap, gap, [batch]);
        }
        return;
      }

      this.diagnostics.report(
        "storage.degraded",
        "The library could not store a batch.",
        { batchId: batch.id },
        error,
      );
      // The diagnostic above names the failure. A storage.evicted report counts it two times.
      this.onGap?.({ batches: 1, records: batch.records.length, reason: "not_stored" }, [batch]);
    }
  }

  /**
   * Reads up to `limit` batches in FIFO order. It does not delete them.
   * @param limit Maximum number of batches to retrieve.
   * @returns Array of retrieved batches.
   */
  async take(limit: number): Promise<LogBatch[]> {
    const batches = await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not read the stored batches.",
      () => this.db.takeOldest(limit),
    );
    return batches ?? [];
  }

  /**
   * Deletes the batch with the given ID from IndexedDB.
   * @param id Batch identifier to delete.
   */
  async remove(id: string): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not delete a batch.",
      () => this.db.delete(id),
    );
  }

  /**
   * Sets the delivery attempt count of a stored batch.
   * @param id Batch identifier.
   * @param attempts New absolute attempt count.
   */
  async bumpAttempts(id: string, attempts: number): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not update the attempt count.",
      () => this.db.bumpAttempts(id, attempts),
    );
  }

  /**
   * Removes expired batches. It then removes the oldest batches above the
   * capacity limit.
   * @returns Prune summary metrics.
   */
  async prune(): Promise<PruneResult> {
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not prune the stored batches.",
      async () => {
        const cutoff = Date.now() - this.limits.maxAgeMs;
        const expired = await this.db.takeBefore(cutoff);
        if (expired.length > 0) {
          await this.db.deleteMany(expired.map((batch) => batch.id));
          this.addGap(result, "expired", expired);
        }

        const total = await this.db.count();
        if (total > this.limits.maxBatches) {
          const evicted = await this.evictOldest(total - this.limits.maxBatches);
          this.addGap(result, "over_capacity", evicted);
        }
      },
    );

    return result;
  }

  /**
   * Returns the number of stored batches.
   * @returns Total batch count or 0 on failure.
   */
  async count(): Promise<number> {
    const total = await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not count the stored batches.",
      () => this.db.count(),
    );
    return total ?? 0;
  }

  /** This method deletes all stored batches from the database. */
  async clear(): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not clear the stored batches.",
      () => this.db.clear(),
    );
  }

  /** This method closes the active IndexedDB connection. */
  async close(): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not close the database.",
      () => this.db.close(),
    );
  }

  /**
   * Adds dropped batches to the prune result. It reports them with their own reason.
   * @param result Prune result of all rules.
   * @param reason Rule that dropped the batches.
   * @param dropped The dropped batches.
   */
  private addGap(result: PruneResult, reason: PruneResult["reason"], dropped: LogBatch[]): void {
    const gap = addDrop(result, reason, dropped.length, countRecords(dropped));
    reportEviction(this.diagnostics, this.onGap, gap, dropped);
  }

  /**
   * Deletes the given number of stored batches. Batches without an action go first, oldest
   * first. An action is an audit fact. It has no guard. Both callers guard it. A guard here
   * hides the failure and reports an eviction that did not occur.
   * @param howMany Number of batches to evict.
   * @returns The evicted batches.
   */
  private async evictOldest(howMany: number): Promise<LogBatch[]> {
    // Only the records tell if a batch holds an action. The walk stops at enough plain batches.
    const pick = new EvictionPick(howMany, hasAction);
    await this.db.walkOldest((batch) => pick.add(batch));

    const doomed = pick.picked();
    await this.db.deleteMany(doomed.map((batch) => batch.id));

    return doomed;
  }
}

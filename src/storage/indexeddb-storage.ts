// src/storage/indexeddb-storage.ts
//
// Stores batches in IndexedDB, indexed by creation time.

import { QUOTA_EVICTION_DIVISOR, QUOTA_EXCEEDED_ERROR, STORAGE_NAME_INDEXEDDB } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { countRecords, type LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";
import { EvictionPick, hasAction } from "./eviction";
import { addDrop, reportEviction } from "./gap";
import { IdbDriver } from "./idb-driver";

/** What one prune did. save() reads `removed` to see whether its own batch survived. */
interface Sweep {
  /** The prune summary across all rules. */
  result: PruneResult;
  /** The batches the prune deleted. */
  removed: LogBatch[];
}

/** StorageAdapter that keeps batches in IndexedDB. */
export class IndexedDbStorage implements StorageAdapter {
  /** The storage strategy name. */
  readonly name = STORAGE_NAME_INDEXEDDB;

  /** Holds the IndexedDB code for the batch store. */
  private readonly db: IdbDriver;

  /**
   * @param dbName Database name.
   * @param limits Storage capacity and retention thresholds.
   * @param diagnostics Diagnostics reporter.
   * @param onGap Optional callback for reporting dropped records.
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
   * Opens the database. Not guarded, because the factory needs the rejection to pick the
   * next adapter.
   */
  async open(): Promise<void> {
    await this.db.ready();
  }

  /**
   * Writes a batch to IndexedDB, then prunes the storage.
   * @param batch The batch to store.
   * @returns True if the batch is in the database after the prune, false if the write failed
   * or the prune removed the batch.
   */
  async save(batch: LogBatch): Promise<boolean> {
    try {
      await this.db.put(batch);
      const { removed } = await this.sweep();

      // The prune can remove the batch it just wrote, for example when every older batch holds
      // an action. A true here would promise a resend for a batch that onGap reported as lost.
      return !removed.some((gone) => gone.id === batch.id);
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

        // The eviction made room for this batch, so write it again. Without the second write,
        // save() resolves, the batch is lost and no counter shows it.
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
        return stored === true;
      }

      this.diagnostics.report(
        "storage.degraded",
        "The library could not store a batch.",
        { batchId: batch.id },
        error,
      );
      // The diagnostic above names the failure. A storage.evicted report would count it twice.
      this.onGap?.({ batches: 1, records: batch.records.length, reason: "not_stored" }, [batch]);
      return false;
    }
  }

  /**
   * Reads one context's batches in creation order without removing them.
   * @param id Delivery context id.
   * @param limit Maximum number of batches to return.
   * @returns This context's batches, oldest first.
   */
  async takeContext(id: string, limit: number): Promise<LogBatch[]> {
    return (
      (await this.diagnostics.guardAsync(
        "storage.degraded",
        "Could not query the context partition.",
        () => this.db.takeContext(id, Math.min(limit, 0xffffffff)),
      )) ?? []
    );
  }

  /**
   * Counts one context's stored batches.
   * @param id Delivery context id.
   * @returns The number of batches in this context.
   */
  async countContext(id: string): Promise<number> {
    return (
      (await this.diagnostics.guardAsync(
        "storage.degraded",
        "Could not count the context partition.",
        () => this.db.countContext(id),
      )) ?? 0
    );
  }

  /**
   * Reads up to `limit` batches in FIFO order without deleting them.
   * @param limit Maximum number of batches to retrieve.
   * @returns The retrieved batches.
   */
  async take(limit: number): Promise<LogBatch[]> {
    const batches = await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not read the stored batches.",
      // getAll() takes an unsigned 32-bit count. Anything larger throws and the read is empty.
      () => this.db.takeOldest(Math.min(limit, 0xffffffff)),
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
   * Sets a stored batch's delivery attempt count.
   * @param id Batch identifier.
   * @param attempts The new absolute attempt count.
   */
  async bumpAttempts(id: string, attempts: number): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not update the attempt count.",
      () => this.db.bumpAttempts(id, attempts),
    );
  }

  /**
   * Removes expired batches, then the oldest batches above the capacity limit.
   * @returns Prune summary metrics.
   */
  async prune(): Promise<PruneResult> {
    const { result } = await this.sweep();

    return result;
  }

  /**
   * Runs the prune and keeps the batches it deleted. A failed prune reports to diagnostics and
   * returns what it deleted before the failure.
   * @returns The prune summary and the deleted batches.
   */
  private async sweep(): Promise<Sweep> {
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };
    const removed: LogBatch[] = [];

    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not prune the stored batches.",
      async () => {
        const cutoff = Date.now() - this.limits.maxAgeMs;
        const expired = await this.db.takeBefore(cutoff);
        if (expired.length > 0) {
          await this.db.deleteMany(expired.map((batch) => batch.id));
          this.addGap(result, "expired", expired);
          removed.push(...expired);
        }

        const total = await this.db.count();
        if (total > this.limits.maxBatches) {
          const evicted = await this.evictOldest(total - this.limits.maxBatches);
          this.addGap(result, "over_capacity", evicted);
          removed.push(...evicted);
        }
      },
    );

    return { result, removed };
  }

  /**
   * Returns the number of stored batches.
   * @returns The total batch count, or 0 on failure.
   */
  async count(): Promise<number> {
    const total = await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not count the stored batches.",
      () => this.db.count(),
    );
    return total ?? 0;
  }

  /** Deletes every stored batch from the database. */
  async clear(): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not clear the stored batches.",
      () => this.db.clear(),
    );
  }

  /** Closes the active IndexedDB connection. */
  async close(): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not close the database.",
      () => this.db.close(),
    );
  }

  /**
   * Adds dropped batches to the prune result and reports them under their own reason.
   * @param result The prune result across all rules.
   * @param reason The rule that dropped the batches.
   * @param dropped The dropped batches.
   */
  private addGap(result: PruneResult, reason: PruneResult["reason"], dropped: LogBatch[]): void {
    const gap = addDrop(result, reason, dropped.length, countRecords(dropped));
    reportEviction(this.diagnostics, this.onGap, gap, dropped);
  }

  /**
   * Deletes the given number of stored batches. Batches without an action go first, oldest
   * first, because an action is an audit fact. Not guarded, because both callers guard it. A
   * guard here would hide the failure and report an eviction that never happened.
   * @param howMany Number of batches to evict.
   * @returns The evicted batches.
   */
  private async evictOldest(howMany: number): Promise<LogBatch[]> {
    // Only the records say whether a batch holds an action. Stop at enough plain batches.
    const pick = new EvictionPick(howMany, hasAction);
    await this.db.walkOldest((batch) => pick.add(batch));

    const doomed = pick.picked();
    await this.db.deleteMany(doomed.map((batch) => batch.id));

    return doomed;
  }
}

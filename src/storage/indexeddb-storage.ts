// src/storage/indexeddb-storage.ts
//
// Persistent storage adapter backed by IndexedDB and Dexie with time-ordered indexing.

import Dexie, { type Table } from "dexie";
import {
  INDEXEDDB_SCHEMA_VERSION,
  QUOTA_EVICTION_DIVISOR,
  QUOTA_EXCEEDED_ERROR,
  STORAGE_NAME_INDEXEDDB,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
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

/** Dexie database instance schema definition for log batch storage. */
class ObservabilityDb extends Dexie {
  /** Table storing LogBatch entities keyed by id and indexed by createdAt. */
  batches!: Table<LogBatch, string>;

  /**
   * @param name IndexedDB database name.
   */
  constructor(name: string) {
    super(name);
    this.version(INDEXEDDB_SCHEMA_VERSION).stores({ batches: "id, createdAt" });
  }
}

/** Persistent StorageAdapter implementation backed by IndexedDB. */
export class IndexedDbStorage implements StorageAdapter {
  /** Storage adapter strategy name. */
  readonly name = STORAGE_NAME_INDEXEDDB;

  /** Underlying Dexie database instance. */
  private readonly db: ObservabilityDb;

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
    this.db = new ObservabilityDb(dbName);
  }

  /**
   * Persists a batch to IndexedDB and triggers storage pruning.
   * @param batch Batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    try {
      await this.db.batches.put(batch);
      await this.prune();
    } catch (error) {
      if (error instanceof Error && error.name === QUOTA_EXCEEDED_ERROR) {
        this.diagnostics.report("storage.quota_exceeded", "IndexedDB is full, evicting the oldest");
        const evicted = await this.diagnostics.guardAsync(
          "storage.degraded",
          "evicting after a full disk",
          () => this.evictOldest(Math.ceil(this.limits.maxBatches / QUOTA_EVICTION_DIVISOR)),
        );
        if (evicted) {
          this.reportGap({ ...evicted, reason: "quota" });
        }
        return;
      }

      this.diagnostics.report(
        "storage.degraded",
        "could not persist a batch",
        { batchId: batch.id },
        error,
      );
    }
  }

  /**
   * Reads up to limit batches in chronological order without deletion.
   * @param limit Maximum number of batches to retrieve.
   * @returns Array of retrieved batches.
   */
  async take(limit: number): Promise<LogBatch[]> {
    const batches = await this.diagnostics.guardAsync(
      "storage.degraded",
      "reading stored batches",
      () => this.db.batches.orderBy("createdAt").limit(limit).toArray(),
    );
    return batches ?? [];
  }

  /**
   * Deletes a batch from IndexedDB by ID.
   * @param id Batch identifier to delete.
   */
  async remove(id: string): Promise<void> {
    await this.diagnostics.guardAsync("storage.degraded", "deleting a batch", () =>
      this.db.batches.delete(id),
    );
  }

  /**
   * Updates delivery attempt count for a stored batch.
   * @param id Batch identifier.
   * @param attempts New absolute attempt count.
   */
  async bumpAttempts(id: string, attempts: number): Promise<void> {
    await this.diagnostics.guardAsync("storage.degraded", "updating attempts", () =>
      this.db.batches.update(id, { attempts }),
    );
  }

  /**
   * Removes expired batches and evicts oldest entries exceeding capacity.
   * @returns Prune summary metrics.
   */
  async prune(): Promise<PruneResult> {
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    await this.diagnostics.guardAsync("storage.degraded", "pruning", async () => {
      const cutoff = Date.now() - this.limits.maxAgeMs;
      const expired = await this.db.batches.where("createdAt").below(cutoff).toArray();
      if (expired.length > 0) {
        await this.db.batches.bulkDelete(expired.map((batch) => batch.id));
        result.batches += expired.length;
        result.records += countRecords(expired);
      }

      const total = await this.db.batches.count();
      if (total > this.limits.maxBatches) {
        result.reason = "over_capacity";
        const evicted = await this.evictOldest(total - this.limits.maxBatches);
        result.batches += evicted.batches;
        result.records += evicted.records;
      }
    });

    this.reportGap(result);
    return result;
  }

  /**
   * Returns total count of stored batches.
   * @returns Total batch count or 0 on failure.
   */
  async count(): Promise<number> {
    const total = await this.diagnostics.guardAsync("storage.degraded", "counting", () =>
      this.db.batches.count(),
    );
    return total ?? 0;
  }

  /** Deletes all stored batches from the database. */
  async clear(): Promise<void> {
    await this.diagnostics.guardAsync("storage.degraded", "clearing", () =>
      this.db.batches.clear(),
    );
  }

  /** Closes the active IndexedDB connection. */
  close(): Promise<void> {
    this.diagnostics.guard("storage.degraded", "closing the database", () => {
      this.db.close();
    });
    return Promise.resolve();
  }

  /**
   * Reports dropped records to diagnostics and registered gap handlers.
   * @param result Prune result metrics.
   */
  private reportGap(result: PruneResult): void {
    if (result.batches === 0) {
      return;
    }

    this.diagnostics.report(
      "storage.evicted",
      `dropped ${String(result.batches)} stored batches (${String(result.records)} records)`,
      { ...result },
    );
    this.onGap?.(result);
  }

  /**
   * Deletes a specified count of the oldest stored batches. Unguarded: both callers
   * guard it, and swallowing the failure here reports an eviction that did not
   * happen.
   * @param howMany Number of oldest batches to evict.
   * @returns Metrics of evicted batches and records.
   */
  private async evictOldest(howMany: number): Promise<Omit<PruneResult, "reason">> {
    const doomed = await this.db.batches.orderBy("createdAt").limit(howMany).toArray();
    await this.db.batches.bulkDelete(doomed.map((batch) => batch.id));

    return { batches: doomed.length, records: countRecords(doomed) };
  }
}

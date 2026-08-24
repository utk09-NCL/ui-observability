// src/storage/indexeddb-storage.ts
//
// The preferred store: asynchronous, indexed, and big enough that a long
// offline period does not overflow it.
//
// This is the only file that imports Dexie, and the factory imports this file
// dynamically. Dexie is by some way the heaviest dependency here, and a static
// import puts it in the main bundle for every consumer, including the ones who
// configured `storage: { strategy: "memory" }` to avoid exactly that.

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

/** How many records a set of batches holds, which is the size of the hole they leave. */
function countRecords(batches: LogBatch[]): number {
  return batches.reduce((total, batch) => total + batch.records.length, 0);
}

/** One table, keyed by batch id and indexed by creation time, which is the order everything reads in. */
class ObservabilityDb extends Dexie {
  /** The batches waiting to be delivered. */
  batches!: Table<LogBatch, string>;

  /** @param name The database name, from `storage.dbName`. */
  constructor(name: string) {
    super(name);
    this.version(INDEXEDDB_SCHEMA_VERSION).stores({ batches: "id, createdAt" });
  }
}

/** Batches in IndexedDB, through Dexie. */
export class IndexedDbStorage implements StorageAdapter {
  /** The adapter name, which is also the strategy that selects it. */
  readonly name = STORAGE_NAME_INDEXEDDB;

  /** The open database. Private, and reached in tests only to force a failure inside Dexie. */
  private readonly db: ObservabilityDb;

  /**
   * @param dbName Which database to open, from `storage.dbName`.
   * @param limits Age and count ceilings.
   * @param diagnostics Where a full disk and a failed read are reported.
   * @param onGap Told when a prune drops records.
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
   * Write one batch, then prune.
   *
   * A full disk evicts a share of the oldest rather than giving up: the newest
   * batch is the one most likely to still matter.
   *
   * @param batch The batch to keep.
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

  /** @param limit How many to hand back, oldest first. */
  async take(limit: number): Promise<LogBatch[]> {
    const batches = await this.diagnostics.guardAsync(
      "storage.degraded",
      "reading stored batches",
      () => this.db.batches.orderBy("createdAt").limit(limit).toArray(),
    );
    return batches ?? [];
  }

  /** @param id The batch that was delivered, or given up on. */
  async remove(id: string): Promise<void> {
    await this.diagnostics.guardAsync("storage.degraded", "deleting a batch", () =>
      this.db.batches.delete(id),
    );
  }

  /**
   * @param id The batch that was tried.
   * @param attempts Its new attempt count.
   */
  async bumpAttempts(id: string, attempts: number): Promise<void> {
    await this.diagnostics.guardAsync("storage.degraded", "updating attempts", () =>
      this.db.batches.update(id, { attempts }),
    );
  }

  /** Drop what is too old, then what is over capacity. Oldest first in both passes. */
  async prune(): Promise<PruneResult> {
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    await this.diagnostics.guardAsync("storage.degraded", "pruning", async () => {
      const cutoff = Date.now() - this.limits.maxAgeMs;
      // Read then bulk delete, rather than a bare delete: the record count is
      // what the gap report needs, and it is gone once the rows are.
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

  /** How many batches are waiting. Zero when the database cannot answer. */
  async count(): Promise<number> {
    const total = await this.diagnostics.guardAsync("storage.degraded", "counting", () =>
      this.db.batches.count(),
    );
    return total ?? 0;
  }

  /** Forget every batch. The database itself stays. */
  async clear(): Promise<void> {
    await this.diagnostics.guardAsync("storage.degraded", "clearing", () =>
      this.db.batches.clear(),
    );
  }

  /** Close the connection, so a reload is not blocked by this one holding it open. */
  close(): Promise<void> {
    this.diagnostics.guard("storage.degraded", "closing the database", () => {
      this.db.close();
    });
    return Promise.resolve();
  }

  /** Announce a hole, once, and only when there is one. */
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
   * Delete the oldest batches and say what went with them.
   *
   * Unguarded on purpose: both callers guard it, and swallowing the failure
   * here would report an eviction that did not happen.
   *
   * @param howMany How many to delete.
   */
  private async evictOldest(howMany: number): Promise<Omit<PruneResult, "reason">> {
    const doomed = await this.db.batches.orderBy("createdAt").limit(howMany).toArray();
    await this.db.batches.bulkDelete(doomed.map((batch) => batch.id));

    return { batches: doomed.length, records: countRecords(doomed) };
  }
}

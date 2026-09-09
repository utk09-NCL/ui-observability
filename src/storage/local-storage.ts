// src/storage/local-storage.ts
//
// Persistent synchronous storage adapter backed by localStorage using time-ordered
// keys. The padding makes keys().sort() a sort by creation time. Unpadded it sorts
// by hex and take() stops returning the oldest batch first.

import {
  BATCH_KEY_TIME_WIDTH,
  BATCH_STORAGE_KEY_PREFIX,
  QUOTA_EVICTION_DIVISOR,
  STORAGE_NAME_LOCAL,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { isLogBatch, type LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";
import { keysWithPrefix } from "./keys";

/**
 * Formats a storage key with zero-padded creation time for FIFO key sorting. Always
 * from batch.createdAt, never Date.now(). A rebuilt key does not match the one
 * written.
 * @param batch Target log batch.
 * @returns Prefixed, timestamp-ordered storage key.
 */
function keyFor(batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${BATCH_STORAGE_KEY_PREFIX}${at}.${batch.id}`;
}

/**
 * Reads the creation time from a storage key. prune() runs after each save. Read
 * from the batch, this field costs one parse of the full store for each save.
 * @param key Prefixed storage key.
 * @returns Creation time in epoch milliseconds, or null if the key is malformed.
 */
function createdAtOf(key: string): number | null {
  const start = BATCH_STORAGE_KEY_PREFIX.length;
  const at = Number(key.slice(start, start + BATCH_KEY_TIME_WIDTH));

  return Number.isFinite(at) ? at : null;
}

/** Persistent StorageAdapter implementation backed by localStorage. */
export class LocalStorageStorage implements StorageAdapter {
  /** Storage adapter strategy name. */
  readonly name = STORAGE_NAME_LOCAL;

  /**
   * @param limits Storage capacity and retention thresholds.
   * @param diagnostics Diagnostics reporter.
   * @param onGap Optional callback for dropped record reporting.
   */
  constructor(
    private readonly limits: StorageLimits,
    private readonly diagnostics: Diagnostics,
    private readonly onGap?: GapReporter,
  ) {}

  /**
   * Persists a batch to localStorage, evicting oldest entries on quota errors.
   * @param batch Batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    if (this.write(batch, "localStorage refused a batch, evicting the oldest")) {
      await this.prune();
      return;
    }

    this.evictForQuota();

    // The eviction exists to make room for this batch. Without a second attempt
    // save() resolves while the batch is gone and uncounted.
    if (!this.write(batch, "localStorage refused a batch even after evicting")) {
      this.reportGap({ batches: 1, records: batch.records.length, reason: "quota" });
    }
  }

  /**
   * Retrieves up to limit batches in chronological order without deletion.
   * @param limit Maximum number of batches to retrieve.
   * @returns Promise resolving to an array of valid batches.
   */
  take(limit: number): Promise<LogBatch[]> {
    const out: LogBatch[] = [];

    for (const key of this.keys().slice(0, limit)) {
      const batch = this.read(key);
      // Corrupt and unrecoverable. Dropped without counting a gap: no record count
      // can be read from it.
      if (batch === null) {
        this.removeKey(key);
        continue;
      }
      out.push(batch);
    }

    return Promise.resolve(out);
  }

  /**
   * Deletes a batch from localStorage by batch ID.
   * @param id Batch identifier.
   */
  remove(id: string): Promise<void> {
    const key = this.keyOf(id);
    if (key !== null) {
      this.removeKey(key);
    }
    return Promise.resolve();
  }

  /**
   * Updates delivery attempt count for a stored batch without changing its key.
   * @param id Batch identifier.
   * @param attempts New absolute attempt count.
   */
  bumpAttempts(id: string, attempts: number): Promise<void> {
    const key = this.keyOf(id);
    if (key === null) {
      return Promise.resolve();
    }

    const batch = this.read(key);
    if (batch === null) {
      return Promise.resolve();
    }

    batch.attempts = attempts;
    this.diagnostics.guard("storage.degraded", "updating attempts", () => {
      localStorage.setItem(key, JSON.stringify(batch));
    });

    return Promise.resolve();
  }

  /**
   * Deletes expired batches and evicts oldest entries exceeding capacity limits.
   * @returns Promise resolving to prune summary metrics.
   */
  prune(): Promise<PruneResult> {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    // Parses only the batches it deletes. The record count is the one field the
    // key does not carry.
    const drop = (key: string): void => {
      const batch = this.read(key);
      this.removeKey(key);
      result.batches++;
      result.records += batch?.records.length ?? 0;
    };

    const alive: string[] = [];

    for (const key of this.keys()) {
      const createdAt = createdAtOf(key);
      // A key with no readable time also has no position in the sort order.
      if (createdAt === null || createdAt < cutoff) {
        drop(key);
        continue;
      }
      alive.push(key);
    }

    const excess = alive.length - this.limits.maxBatches;
    if (excess > 0) {
      result.reason = "over_capacity";
      for (const key of alive.slice(0, excess)) {
        drop(key);
      }
    }

    this.reportGap(result);

    return Promise.resolve(result);
  }

  /**
   * Returns total count of stored batch keys without deserialization.
   * @returns Promise resolving to batch count.
   */
  count(): Promise<number> {
    return Promise.resolve(this.keys().length);
  }

  /** Deletes all matching batch keys from localStorage. */
  clear(): Promise<void> {
    this.evict(this.keys());
    return Promise.resolve();
  }

  /** No-op storage teardown method. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Writes a batch to localStorage.
   * @param batch Batch to store.
   * @param context Description reported if the write is refused.
   * @returns True if the write succeeded.
   */
  private write(batch: LogBatch, context: string): boolean {
    const written = this.diagnostics.guard("storage.quota_exceeded", context, () => {
      localStorage.setItem(keyFor(batch), JSON.stringify(batch));
      return true;
    });

    return written === true;
  }

  /** Drops the oldest quarter of the store to free quota, counting the loss. */
  private evictForQuota(): void {
    const keys = this.keys();
    const result: PruneResult = { batches: 0, records: 0, reason: "quota" };

    for (const key of keys.slice(0, Math.ceil(keys.length / QUOTA_EVICTION_DIVISOR))) {
      const stored = this.read(key);
      this.removeKey(key);
      result.batches++;
      result.records += stored?.records.length ?? 0;
    }

    this.reportGap(result);
  }

  /**
   * Reports dropped records to diagnostics and registered gap handlers.
   * @param result Eviction metrics.
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
   * Deserializes and validates a stored batch from a key.
   * @param key Storage key to read.
   * @returns Validated LogBatch or null if missing or malformed.
   */
  private read(key: string): LogBatch | null {
    const raw = this.diagnostics.guard("storage.unavailable", "reading a stored batch", () =>
      localStorage.getItem(key),
    );
    if (!raw) {
      return null;
    }

    const parsed = this.diagnostics.guard(
      "storage.degraded",
      "a stored batch was corrupt and was removed",
      () => JSON.parse(raw) as unknown,
    );
    // The guard above already reported a parse failure. Reporting again here would
    // count one corrupt entry twice.
    if (parsed === undefined) {
      return null;
    }

    if (!isLogBatch(parsed)) {
      this.diagnostics.report("storage.degraded", "a stored entry was not a batch and was dropped");
      return null;
    }

    return parsed;
  }

  /**
   * Resolves storage key containing the specified batch ID suffix.
   * @param id Batch identifier.
   * @returns Matching storage key string or null.
   */
  private keyOf(id: string): string | null {
    return this.keys().find((key) => key.endsWith(`.${id}`)) ?? null;
  }

  /**
   * Deletes an array of storage keys.
   * @param keys Keys to delete.
   */
  private evict(keys: string[]): void {
    for (const key of keys) {
      this.removeKey(key);
    }
  }

  /**
   * Deletes a single storage key with error guarding.
   * @param key Storage key to remove.
   */
  private removeKey(key: string): void {
    this.diagnostics.guard("storage.degraded", "removing a stored batch", () => {
      localStorage.removeItem(key);
    });
  }

  /**
   * Returns all sorted batch storage keys matching prefix.
   * @returns Sorted array of storage keys.
   */
  private keys(): string[] {
    return keysWithPrefix(BATCH_STORAGE_KEY_PREFIX, this.diagnostics);
  }
}

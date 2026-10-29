// src/storage/local-storage.ts
//
// This module stores batches in localStorage with time-ordered keys. The padding makes
// keys().sort() a sort by creation time. Without padding, the sort uses hex order. take()
// then does not return the oldest batch first.

import {
  BATCH_KEY_TIME_WIDTH,
  BATCH_STORAGE_KEY_PREFIX,
  QUOTA_EVICTION_DIVISOR,
  STORAGE_NAME_LOCAL,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { isLogBatch, type LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";
import { hasAction, pickEvictable } from "./eviction";
import { keysWithPrefix } from "./keys";

/** A stored entry. A corrupt entry has no batch. */
interface Entry {
  key: string;
  batch: LogBatch | null;
}

/**
 * Formats a storage key with a zero-padded creation time. The keys sort in FIFO
 * order. Always use batch.createdAt, never Date.now(). A key from Date.now() does not match
 * the written key.
 * @param batch Target log batch.
 * @returns Prefixed, timestamp-ordered storage key.
 */
function keyFor(batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${BATCH_STORAGE_KEY_PREFIX}${at}.${batch.id}`;
}

/**
 * Reads the creation time from a storage key. prune() runs after each save. A
 * read from the batch parses the full store for each save.
 * @param key Prefixed storage key.
 * @returns Creation time in epoch milliseconds, or null for a malformed key.
 */
function createdAtOf(key: string): number | null {
  const start = BATCH_STORAGE_KEY_PREFIX.length;
  const at = Number(key.slice(start, start + BATCH_KEY_TIME_WIDTH));

  return Number.isFinite(at) ? at : null;
}

/** This StorageAdapter keeps batches in localStorage. */
export class LocalStorageStorage implements StorageAdapter {
  /** This field holds the storage strategy name. */
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
   * Writes a batch to localStorage. It removes the oldest entries on a quota error.
   * @param batch Batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    if (this.write(batch, "localStorage refused a batch, evicting the oldest")) {
      await this.prune();
      return;
    }

    this.evictForQuota();

    // The eviction makes room for this batch. Without a second write, save() resolves.
    // The library then loses the batch. No counter shows the loss.
    if (!this.write(batch, "localStorage refused a batch even after evicting")) {
      this.reportGap({ batches: 1, records: batch.records.length, reason: "quota" }, [batch]);
    }
  }

  /**
   * Returns up to `limit` batches in FIFO order. It does not delete them.
   * @param limit Maximum number of batches to retrieve.
   * @returns Promise that resolves to an array of valid batches.
   */
  take(limit: number): Promise<LogBatch[]> {
    const out: LogBatch[] = [];

    for (const key of this.keys().slice(0, limit)) {
      const batch = this.read(key);
      // The entry is corrupt. The library cannot recover it. Remove it without a gap count. It has
      // no readable record count.
      if (batch === null) {
        this.removeKey(key);
        continue;
      }
      out.push(batch);
    }

    return Promise.resolve(out);
  }

  /**
   * Deletes the batch with the given ID from localStorage.
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
   * Sets the delivery attempt count of a stored batch. It does not change the key.
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
    this.diagnostics.guard(
      "storage.degraded",
      "The library could not update the attempt count.",
      () => {
        localStorage.setItem(key, JSON.stringify(batch));
      },
    );

    return Promise.resolve();
  }

  /**
   * Deletes expired batches. It then removes the oldest batches above the
   * capacity limit.
   * @returns Promise that resolves to prune summary metrics.
   */
  prune(): Promise<PruneResult> {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };
    const expired: string[] = [];
    const alive: string[] = [];

    for (const key of this.keys()) {
      const createdAt = createdAtOf(key);
      // A key with no readable time also has no position in the sort order.
      if (createdAt === null || createdAt < cutoff) {
        expired.push(key);
        continue;
      }
      alive.push(key);
    }

    // The record count is the one field that the key does not contain. Parse only the
    // deleted batches.
    this.drop(result, "expired", [...this.entries(expired)]);

    const excess = alive.length - this.limits.maxBatches;
    if (excess > 0) {
      this.drop(result, "over_capacity", this.evictable(alive, excess));
    }

    return Promise.resolve(result);
  }

  /**
   * Returns the number of stored batch keys. It does not deserialize the batches.
   * @returns Promise that resolves to batch count.
   */
  count(): Promise<number> {
    return Promise.resolve(this.keys().length);
  }

  /** This method deletes all batch keys from localStorage. */
  clear(): Promise<void> {
    this.evict(this.keys());
    return Promise.resolve();
  }

  /** This method does nothing. localStorage has no connection to close. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Writes a batch to localStorage.
   * @param batch Batch to store.
   * @param context Text that diagnostics reports when the write fails.
   * @returns True if the write succeeded.
   */
  private write(batch: LogBatch, context: string): boolean {
    const written = this.diagnostics.guard("storage.quota_exceeded", context, () => {
      localStorage.setItem(keyFor(batch), JSON.stringify(batch));
      return true;
    });

    return written === true;
  }

  /** This method removes a quarter of the store to free quota. It counts the loss. */
  private evictForQuota(): void {
    const keys = this.keys();
    const result: PruneResult = { batches: 0, records: 0, reason: "quota" };
    const howMany = Math.ceil(keys.length / QUOTA_EVICTION_DIVISOR);

    this.drop(result, "quota", this.evictable(keys, howMany));
  }

  /**
   * Picks the entries to evict. Entries without an action go first. An action is an audit fact.
   * A corrupt entry has no action. It goes first.
   * @param keys Batch keys, oldest first.
   * @param howMany Number of entries to evict.
   * @returns The picked entries.
   */
  private evictable(keys: string[], howMany: number): Entry[] {
    return pickEvictable(
      this.entries(keys),
      howMany,
      (entry) => entry.batch !== null && hasAction(entry.batch),
    );
  }

  /**
   * Reads the entries one at a time. The eviction walk stops early. The later entries then stay
   * unparsed.
   * @param keys Batch keys.
   * @yields Each key with its batch.
   */
  private *entries(keys: string[]): Generator<Entry> {
    for (const key of keys) {
      yield { key, batch: this.read(key) };
    }
  }

  /**
   * Removes entries. It reports them with their own reason.
   * @param result Prune result of all rules.
   * @param reason Rule that removes the entries.
   * @param entries Entries to remove.
   */
  private drop(result: PruneResult, reason: PruneResult["reason"], entries: Entry[]): void {
    if (entries.length === 0) {
      return;
    }

    const dropped: LogBatch[] = [];
    let records = 0;

    for (const { key, batch } of entries) {
      this.removeKey(key);
      records += batch?.records.length ?? 0;
      if (batch) {
        dropped.push(batch);
      }
    }

    result.batches += entries.length;
    result.records += records;
    result.reason = reason;
    this.reportGap({ batches: entries.length, records, reason }, dropped);
  }

  /**
   * Reports dropped records to diagnostics and to the gap handler.
   * @param result Eviction metrics.
   * @param dropped The dropped batches that the adapter could read.
   */
  private reportGap(result: PruneResult, dropped: readonly LogBatch[]): void {
    this.diagnostics.report(
      "storage.evicted",
      `The library dropped ${String(result.batches)} stored batches (${String(result.records)} records).`,
      { ...result },
    );
    this.onGap?.(result, dropped);
  }

  /**
   * Reads and validates the stored batch at a key.
   * @param key Storage key to read.
   * @returns Validated LogBatch or null if missing or malformed.
   */
  private read(key: string): LogBatch | null {
    const raw = this.diagnostics.guard(
      "storage.unavailable",
      "The library could not read a stored batch.",
      () => localStorage.getItem(key),
    );
    if (!raw) {
      return null;
    }

    const parsed = this.diagnostics.guard(
      "storage.degraded",
      "A stored batch is corrupt. The library removed it.",
      () => JSON.parse(raw) as unknown,
    );
    // The guard above already reported a parse failure. A second report counts one corrupt
    // entry twice.
    if (parsed === undefined) {
      return null;
    }

    if (!isLogBatch(parsed)) {
      this.diagnostics.report(
        "storage.degraded",
        "A stored entry is not a batch. The library dropped it.",
      );
      return null;
    }

    return parsed;
  }

  /**
   * Finds the storage key that ends with the batch ID.
   * @param id Batch identifier.
   * @returns Matching storage key string or null.
   */
  private keyOf(id: string): string | null {
    return this.keys().find((key) => key.endsWith(`.${id}`)) ?? null;
  }

  /**
   * Deletes a list of storage keys.
   * @param keys Keys to delete.
   */
  private evict(keys: string[]): void {
    for (const key of keys) {
      this.removeKey(key);
    }
  }

  /**
   * Deletes one storage key inside a guard.
   * @param key Storage key to remove.
   */
  private removeKey(key: string): void {
    this.diagnostics.guard(
      "storage.degraded",
      "The library could not remove a stored batch.",
      () => {
        localStorage.removeItem(key);
      },
    );
  }

  /**
   * Returns all batch storage keys in sorted order.
   * @returns Sorted array of storage keys.
   */
  private keys(): string[] {
    return keysWithPrefix(BATCH_STORAGE_KEY_PREFIX, this.diagnostics);
  }
}

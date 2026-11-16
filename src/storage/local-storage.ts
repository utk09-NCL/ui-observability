// src/storage/local-storage.ts
//
// Stores batches in localStorage under time-ordered keys. The padding makes keys().sort() a
// sort by creation time. Without it the sort would compare the decimal times as text, so "10"
// sorts before "9", and take() would not return the oldest batch first.

import {
  BATCH_KEY_TIME_WIDTH,
  BATCH_STORAGE_KEY_PREFIX,
  QUOTA_EVICTION_DIVISOR,
  STORAGE_NAME_LOCAL,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { countRecords, isLogBatch, type LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";
import { hasAction, pickEvictable } from "./eviction";
import { addDrop, reportEviction } from "./gap";
import { batchKey, keysWithPrefix } from "./keys";

/** A stored entry. A corrupt entry has no batch. */
interface Entry {
  key: string;
  batch: LogBatch | null;
}

/**
 * Reads the creation time from a storage key. prune() runs after every save, and reading the
 * time from the batch would parse the whole store each time.
 * @param key The prefixed storage key.
 * @param prefix The storage key prefix.
 * @returns Creation time in epoch milliseconds, or null for a malformed key.
 */
function createdAtOf(key: string, prefix: string): number | null {
  const start = prefix.length;
  const at = Number(key.slice(start, start + BATCH_KEY_TIME_WIDTH));

  return Number.isFinite(at) ? at : null;
}

/** StorageAdapter that keeps batches in localStorage. */
export class LocalStorageStorage implements StorageAdapter {
  /** The storage strategy name. */
  readonly name = STORAGE_NAME_LOCAL;

  /**
   * @param limits Storage capacity and retention thresholds.
   * @param diagnostics Diagnostics reporter.
   * @param onGap Optional callback for reporting dropped records.
   */
  constructor(
    private readonly limits: StorageLimits,
    private readonly diagnostics: Diagnostics,
    private readonly onGap?: GapReporter,
    private readonly prefix = BATCH_STORAGE_KEY_PREFIX,
  ) {}

  /**
   * Writes a batch to localStorage, removing the oldest entries on a quota error.
   * @param batch The batch to store.
   */
  async save(batch: LogBatch): Promise<void> {
    if (this.write(batch, "localStorage refused a batch, evicting the oldest")) {
      await this.prune();
      return;
    }

    this.evictForQuota();

    // The eviction made room for this batch, so write it again. Without the second write,
    // save() resolves, the batch is lost and no counter shows it.
    if (!this.write(batch, "localStorage refused a batch even after evicting")) {
      const gap: PruneResult = { batches: 1, records: batch.records.length, reason: "quota" };
      reportEviction(this.diagnostics, this.onGap, gap, [batch]);
    }
  }

  /**
   * Returns up to `limit` batches in FIFO order without deleting them.
   * @param limit Maximum number of batches to retrieve.
   * @returns A promise that resolves to the valid batches.
   */
  take(limit: number): Promise<LogBatch[]> {
    const out: LogBatch[] = [];

    for (const key of this.keys().slice(0, limit)) {
      const batch = this.read(key);
      // A corrupt entry can't be recovered. Remove it without a gap count, because it has no
      // readable record count.
      if (batch === null) {
        this.removeKey(key);
        continue;
      }
      out.push(batch);
    }

    return Promise.resolve(out);
  }

  /**
   * Returns up to `limit` batches of one context in FIFO order without deleting them. Stops
   * at the limit, so later entries are never parsed.
   * @param id Delivery context id.
   * @param limit Maximum number of batches to retrieve.
   * @returns A promise that resolves to this context's batches.
   */
  takeContext(id: string, limit: number): Promise<LogBatch[]> {
    const out: LogBatch[] = [];

    for (const batch of this.batches()) {
      if (out.length >= limit) {
        break;
      }
      if (batch.routingContextId === id) {
        out.push(batch);
      }
    }

    return Promise.resolve(out);
  }

  /**
   * Counts one context's stored batches. The context id isn't in the key, so every entry is
   * read.
   * @param id Delivery context id.
   * @returns A promise that resolves to this context's batch count.
   */
  countContext(id: string): Promise<number> {
    let count = 0;

    for (const batch of this.batches()) {
      if (batch.routingContextId === id) {
        count++;
      }
    }

    return Promise.resolve(count);
  }

  /**
   * Reads the valid batches one at a time, oldest first, and removes any corrupt entry.
   * @yields Each valid batch.
   */
  private *batches(): Generator<LogBatch> {
    for (const key of this.keys()) {
      const batch = this.read(key);
      if (batch === null) {
        this.removeKey(key);
        continue;
      }
      yield batch;
    }
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
   * Sets a stored batch's delivery attempt count. The key doesn't change.
   * @param id Batch identifier.
   * @param attempts The new absolute attempt count.
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
   * Deletes expired batches, then the oldest batches above the capacity limit.
   * @returns A promise that resolves to the prune summary metrics.
   */
  prune(): Promise<PruneResult> {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };
    const expired: string[] = [];
    const alive: string[] = [];

    for (const key of this.keys()) {
      const createdAt = createdAtOf(key, this.prefix);
      // A key with no readable time has no place in the sort order either.
      if (createdAt === null || createdAt < cutoff) {
        expired.push(key);
        continue;
      }
      alive.push(key);
    }

    // The record count is the one field the key doesn't hold, so parse only the deleted batches.
    this.drop(result, "expired", [...this.entries(expired)]);

    const excess = alive.length - this.limits.maxBatches;
    if (excess > 0) {
      this.drop(result, "over_capacity", this.evictable(alive, excess));
    }

    return Promise.resolve(result);
  }

  /**
   * Returns the number of stored batch keys without deserializing the batches.
   * @returns A promise that resolves to the batch count.
   */
  count(): Promise<number> {
    return Promise.resolve(this.keys().length);
  }

  /** Deletes every batch key from localStorage. */
  clear(): Promise<void> {
    this.evict(this.keys());
    return Promise.resolve();
  }

  /** Does nothing. localStorage has no connection to close. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Writes a batch to localStorage.
   * @param batch The batch to store.
   * @param context The text diagnostics reports if the write fails.
   * @returns True if the write succeeded.
   */
  private write(batch: LogBatch, context: string): boolean {
    const written = this.diagnostics.guard("storage.quota_exceeded", context, () => {
      localStorage.setItem(batchKey(this.prefix, batch), JSON.stringify(batch));
      return true;
    });

    return written === true;
  }

  /** Removes a quarter of the store to free quota, and counts the loss. */
  private evictForQuota(): void {
    const keys = this.keys();
    const result: PruneResult = { batches: 0, records: 0, reason: "quota" };
    const howMany = Math.ceil(keys.length / QUOTA_EVICTION_DIVISOR);

    this.drop(result, "quota", this.evictable(keys, howMany));
  }

  /**
   * Picks the entries to evict. Entries without an action go first, because an action is an
   * audit fact. A corrupt entry has no action, so it goes first too.
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
   * Reads the entries one at a time. The eviction walk stops early, so later entries are
   * never parsed.
   * @param keys Batch keys.
   * @yields Each key with its batch.
   */
  private *entries(keys: string[]): Generator<Entry> {
    for (const key of keys) {
      yield { key, batch: this.read(key) };
    }
  }

  /**
   * Removes entries and reports them under their own reason.
   * @param result The prune result across all rules.
   * @param reason The rule that removes the entries.
   * @param entries The entries to remove.
   */
  private drop(result: PruneResult, reason: PruneResult["reason"], entries: Entry[]): void {
    if (entries.length === 0) {
      return;
    }

    const dropped: LogBatch[] = [];

    for (const { key, batch } of entries) {
      this.removeKey(key);
      if (batch) {
        dropped.push(batch);
      }
    }

    // A corrupt entry counts as a batch with no records.
    const gap = addDrop(result, reason, entries.length, countRecords(dropped));
    reportEviction(this.diagnostics, this.onGap, gap, dropped);
  }

  /**
   * Reads and validates the stored batch at a key.
   * @param key The storage key to read.
   * @returns The validated LogBatch, or null if it is missing or malformed.
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
    // The guard above already reported a parse failure. A second report would count one
    // corrupt entry twice.
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
   * @returns The matching storage key, or null.
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
   * Returns every batch storage key, sorted.
   * @returns The sorted storage keys.
   */
  private keys(): string[] {
    return keysWithPrefix(this.prefix, this.diagnostics);
  }
}

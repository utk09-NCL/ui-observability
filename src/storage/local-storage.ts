// src/storage/local-storage.ts
//
// The fallback when IndexedDB is missing: a webview, a sandboxed frame, or a
// browser in private mode.
//
// Everything here is synchronous and small on purpose. localStorage blocks the
// main thread, so the store is read by key rather than by parsing its contents,
// and a batch is deserialized only when something actually needs it.

import {
  BATCH_KEY_TIME_WIDTH,
  BATCH_STORAGE_KEY_PREFIX,
  QUOTA_EVICTION_DIVISOR,
  STORAGE_NAME_LOCAL,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { GapReporter, PruneResult, StorageAdapter, StorageLimits } from "../models/storage";

/**
 * The key carries the creation time, and it has to.
 *
 * localStorage has no index and no ordering, so the key string is the only sort
 * key available. Keying on the batch id alone, which is random, makes
 * `keys().sort()` a sort by random hex: `take` stops returning oldest first and
 * the over-capacity prune evicts whatever sorts low. Both are silent, and
 * `MemoryStorage` behaves correctly, so it only shows up on the machines that
 * fell back to this adapter.
 *
 * The alternative, parsing every batch to sort by `createdAt`, makes `count()`
 * deserialize hundreds of blobs to answer "how many".
 */
function keyFor(batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${BATCH_STORAGE_KEY_PREFIX}${at}.${batch.id}`;
}

/** Batches parked in localStorage, one key each. */
export class LocalStorageStorage implements StorageAdapter {
  /** The adapter name, which is also the strategy that selects it. */
  readonly name = STORAGE_NAME_LOCAL;

  /**
   * @param limits Age and count ceilings.
   * @param diagnostics Where a refused write, a blocked store and a corrupt entry are reported.
   * @param onGap Told when a prune drops records.
   */
  constructor(
    private readonly limits: StorageLimits,
    private readonly diagnostics: Diagnostics,
    private readonly onGap?: GapReporter,
  ) {}

  /**
   * Write one batch, then prune.
   *
   * A refused write is nearly always a full store, so a share of the oldest
   * goes and the batch that triggered it is dropped. Retrying it here would
   * mean writing during the eviction it caused.
   *
   * @param batch The batch to keep.
   */
  async save(batch: LogBatch): Promise<void> {
    const written = this.diagnostics.guard(
      "storage.quota_exceeded",
      "localStorage refused a batch, evicting the oldest",
      () => {
        localStorage.setItem(keyFor(batch), JSON.stringify(batch));
        return true;
      },
    );

    if (written !== true) {
      const keys = this.keys();
      this.evict(keys.slice(0, Math.ceil(keys.length / QUOTA_EVICTION_DIVISOR)));
      return;
    }

    await this.prune();
  }

  /**
   * @param limit How many to hand back, oldest first.
   * @returns The batches that parsed. A corrupt entry is removed rather than returned.
   */
  take(limit: number): Promise<LogBatch[]> {
    const out: LogBatch[] = [];

    for (const key of this.keys().slice(0, limit)) {
      const batch = this.read(key);
      if (batch === null) {
        this.removeKey(key);
        continue;
      }
      out.push(batch);
    }

    return Promise.resolve(out);
  }

  /** @param id The batch that was delivered, or given up on. */
  remove(id: string): Promise<void> {
    const key = this.keyOf(id);
    if (key !== null) {
      this.removeKey(key);
    }
    return Promise.resolve();
  }

  /**
   * @param id The batch that was tried.
   * @param attempts Its new attempt count.
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
    // The key encodes createdAt, which an attempt does not change, so the same
    // key is still the right one. Never re-derive it from Date.now().
    this.diagnostics.guard("storage.degraded", "updating attempts", () => {
      localStorage.setItem(key, JSON.stringify(batch));
    });

    return Promise.resolve();
  }

  /** Drop what is too old, then what is over capacity. Oldest first in both passes. */
  prune(): Promise<PruneResult> {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    const result: PruneResult = { batches: 0, records: 0, reason: "expired" };

    const drop = (key: string, records: number) => {
      this.removeKey(key);
      result.batches++;
      result.records += records;
    };

    // Read once, carrying the record counts forward. Re-reading below to count
    // what is being evicted would mean handling an unreadable entry that this
    // pass has already dropped, which is a branch nothing can take.
    const alive: { key: string; records: number }[] = [];

    for (const key of this.keys()) {
      const batch = this.read(key);
      if (batch === null) {
        // Corrupt and unrecoverable, so it is dropped but not a countable gap.
        drop(key, 0);
        continue;
      }
      if (batch.createdAt < cutoff) {
        drop(key, batch.records.length);
        continue;
      }
      alive.push({ key, records: batch.records.length });
    }

    const excess = alive.length - this.limits.maxBatches;
    if (excess > 0) {
      result.reason = "over_capacity";
      for (const entry of alive.slice(0, excess)) {
        drop(entry.key, entry.records);
      }
    }

    if (result.batches > 0) {
      this.diagnostics.report(
        "storage.evicted",
        `dropped ${String(result.batches)} stored batches (${String(result.records)} records)`,
        { ...result },
      );
      this.onGap?.(result);
    }

    return Promise.resolve(result);
  }

  /** How many batches are waiting. Counts keys, so nothing is deserialized. */
  count(): Promise<number> {
    return Promise.resolve(this.keys().length);
  }

  /** Forget every batch, leaving anything else on the origin alone. */
  clear(): Promise<void> {
    this.evict(this.keys());
    return Promise.resolve();
  }

  /** Nothing to release. localStorage is not a connection. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /** One stored batch, or null when the value is missing, unparseable or not a batch. */
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
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    // Written by an earlier version of this library, or by anything else on the
    // origin, so the two fields the callers read are checked rather than assumed.
    const createdAt: unknown = Reflect.get(parsed, "createdAt");
    const records: unknown = Reflect.get(parsed, "records");
    if (typeof createdAt !== "number" || !Array.isArray(records)) {
      return null;
    }

    return parsed as LogBatch;
  }

  /** The key holding a given id. Not derivable, so it is found: a few hundred string compares. */
  private keyOf(id: string): string | null {
    return this.keys().find((key) => key.endsWith(`.${id}`)) ?? null;
  }

  /** Delete several keys. */
  private evict(keys: string[]): void {
    for (const key of keys) {
      this.removeKey(key);
    }
  }

  /** Delete one key. Separate from `remove`, which takes a batch id rather than a key. */
  private removeKey(key: string): void {
    this.diagnostics.guard("storage.degraded", "removing a stored batch", () => {
      localStorage.removeItem(key);
    });
  }

  /** Every batch key, oldest first. The key embeds a fixed-width `createdAt`, so sorting is chronological. */
  private keys(): string[] {
    const out: string[] = [];

    this.diagnostics.guard("storage.unavailable", "enumerating localStorage", () => {
      for (let i = 0; i < localStorage.length; i++) {
        // Stringified rather than null-checked: an index below `length` always
        // names a key, so the null branch is one nothing can take.
        const key = String(localStorage.key(i));
        if (key.startsWith(BATCH_STORAGE_KEY_PREFIX)) {
          out.push(key);
        }
      }
    });

    return out.sort();
  }
}

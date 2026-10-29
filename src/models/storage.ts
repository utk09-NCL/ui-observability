// src/models/storage.ts
//
// Storage interface for undelivered batches, with adapters for IndexedDB,
// localStorage, memory, and a fallback that does nothing.

import type { LogBatch } from "./batch";
import type { RetentionOptions } from "./config";

/** Persistent batch storage interface. All methods must resolve and never throw. */
export interface StorageAdapter {
  /** Adapter identifier name. */
  readonly name: string;

  /**
   * Persists a batch to storage.
   * @param batch The batch to store.
   */
  save(batch: LogBatch): Promise<void>;

  /**
   * Reads up to `limit` batches in FIFO order without removing them.
   * @param limit Maximum number of batches to retrieve.
   * @returns Oldest persisted batches.
   */
  take(limit: number): Promise<LogBatch[]>;

  /**
   * Removes a batch by ID. A call with an unknown ID resolves without error.
   * @param id Batch identifier.
   */
  remove(id: string): Promise<void>;

  /**
   * Updates the total delivery attempts for a batch.
   * @param id Batch identifier.
   * @param attempts Absolute attempt count.
   */
  bumpAttempts(id: string, attempts: number): Promise<void>;

  /**
   * Deletes expired and over-capacity batches.
   * @returns Prune summary metrics.
   */
  prune(): Promise<PruneResult>;

  /** Returns the total number of stored batches. */
  count(): Promise<number>;

  /** Deletes all batches in storage. */
  clear(): Promise<void>;

  /** Closes storage connections and releases resources. */
  close(): Promise<void>;
}

/** Capacity and retention thresholds enforced by a storage adapter. */
export interface StorageLimits {
  /** Maximum batch capacity before FIFO eviction. */
  maxBatches: number;
  /** Maximum time-to-live for a stored batch in milliseconds. */
  maxAgeMs: number;
  /** Maximum delivery attempts before dead-letter drop. */
  maxAttempts: number;
}

/**
 * Gives the storage limits of a retention setting. "until-delivered" has no age limit and no
 * attempt limit. The batch cap still applies.
 * @param retention Retention setting from the config.
 * @returns The limits for the storage adapters and the retry engine.
 */
export function storageLimits(retention: RetentionOptions): StorageLimits {
  const { maxBatches } = retention;

  if (retention.mode === "until-delivered") {
    return { maxBatches, maxAgeMs: Infinity, maxAttempts: Infinity };
  }

  return { maxBatches, maxAgeMs: retention.maxAgeMs, maxAttempts: retention.maxAttempts };
}

/** Metrics for batches and records dropped during storage pruning. */
export interface PruneResult {
  /** Total batches dropped. */
  batches: number;
  /** Total records dropped within evicted batches. */
  records: number;
  /**
   * Cause of the drop. If more than one rule applies, this is the last rule. "not_stored" means
   * that storage did not keep a batch after a failed send.
   */
  reason: "expired" | "over_capacity" | "quota" | "not_stored";
}

/**
 * Callback invoked when dropped records create a telemetry gap.
 * @param result Summary of evicted data.
 * @param dropped The dropped batches. A corrupt entry has no batch. The list then has none for it.
 */
export type GapReporter = (result: PruneResult, dropped: readonly LogBatch[]) => void;

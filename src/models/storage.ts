// src/models/storage.ts
//
// Storage interface for undelivered batches, with adapters for IndexedDB,
// localStorage, memory, and a fallback that does nothing.

import type { LogBatch } from "./batch";
import type { RetentionOptions } from "./config";

/**
 * State of the request for persistent storage. "off" means no request was made and "pending"
 * is waiting for the browser. "unsupported" means the browser has no
 * `navigator.storage.persist()`.
 */
export type StoragePersistence = "off" | "pending" | "granted" | "denied" | "unsupported";

/** Persistent batch storage interface. All methods must resolve and never throw. */
export interface StorageAdapter {
  /** Adapter name. */
  readonly name: string;

  /**
   * Persists a batch to storage.
   * @param batch The batch to store.
   * @returns True if the batch is in storage when the save ends. A save's own prune can remove
   * it, and the second write after a quota error runs no prune. False means nothing sends it again.
   */
  save(batch: LogBatch): Promise<boolean>;

  /**
   * Reads up to `limit` batches in FIFO order without removing them.
   * @param limit Maximum number of batches to retrieve.
   * @returns Oldest persisted batches.
   */
  take(limit: number): Promise<LogBatch[]>;
  /**
   * Reads one context's batches without loading those of other contexts.
   * @param id Delivery context id.
   * @param limit Maximum batches to return.
   * @returns This context's batches, oldest first.
   */
  takeContext?(id: string, limit: number): Promise<LogBatch[]>;
  /**
   * Counts one context's batches without loading them.
   * @param id Delivery context id.
   * @returns Number of batches in this context.
   */
  countContext?(id: string): Promise<number>;

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
 * Returns the storage limits for a retention setting. A null age or attempt limit becomes
 * Infinity, so a batch stays until it's delivered, but the batch cap still applies.
 * @param retention Retention setting from the config.
 * @returns The limits for the storage adapters and the retry engine.
 */
export function storageLimits(retention: RetentionOptions): StorageLimits {
  return {
    maxBatches: retention.maxBatches,
    maxAgeMs: retention.maxAgeMs ?? Infinity,
    maxAttempts: retention.maxAttempts ?? Infinity,
  };
}

/** Metrics for batches and records dropped during storage pruning. */
export interface PruneResult {
  /** Total batches dropped. */
  batches: number;
  /** Total records dropped within evicted batches. */
  records: number;
  /**
   * Cause of the drop. If more than one rule applied, this is the last one. "not_stored" means
   * storage did not keep a batch after a failed send.
   */
  reason: "expired" | "over_capacity" | "quota" | "not_stored";
}

/**
 * Callback invoked when dropped records create a telemetry gap.
 * @param result Summary of evicted data.
 * @param dropped The dropped batches. A corrupt entry has no batch, so the list omits it.
 */
export type GapReporter = (result: PruneResult, dropped: readonly LogBatch[]) => void;

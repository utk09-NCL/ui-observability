// src/models/storage.ts
//
// Storage interface for undelivered batches, with adapters for IndexedDB,
// localStorage, memory, and a no-op fallback.

import type { LogBatch } from "./batch";

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
   * Removes a batch by ID. Non-existent IDs resolve without error.
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

/** Metrics for batches and records dropped during storage pruning. */
export interface PruneResult {
  /** Total batches dropped. */
  batches: number;
  /** Total records dropped within evicted batches. */
  records: number;
  /** Eviction reason that triggered the prune. If more than one rule fired, this is the last one. */
  reason: "expired" | "over_capacity" | "quota";
}

/**
 * Callback invoked when dropped records create a telemetry gap.
 * @param result Summary of evicted data.
 */
export type GapReporter = (result: PruneResult) => void;

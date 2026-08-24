// src/models/storage.ts
//
// Where undelivered batches wait, behind one interface with four
// implementations.
//
// The obvious shape, a `drainBatches(sender)` that takes a callback, is not
// this one: it couples storage to transport, hides the attempt counter, and
// makes a poison batch impossible to detect. Separate `take`, `remove` and
// `bumpAttempts` are what let the retry engine give up on a batch the server
// will never accept.

import type { LogBatch } from "./batch";

/** One place undelivered batches wait. Every method resolves; none throws. */
export interface StorageAdapter {
  /** Which implementation this is. Reported, and asserted on in tests. */
  readonly name: string;
  /** Persist a batch that failed to send. */
  save(batch: LogBatch): Promise<void>;
  /** Oldest first. Does not remove; the caller removes on success. */
  take(limit: number): Promise<LogBatch[]>;
  /** Forget one batch, by id. Removing an id that is not there is not an error. */
  remove(id: string): Promise<void>;
  /** Record a failed delivery attempt, so an attempt limit can be enforced across reloads. */
  bumpAttempts(id: string, attempts: number): Promise<void>;
  /** Drop batches that are too old or over the count limit. */
  prune(): Promise<PruneResult>;
  /** How many batches are waiting. */
  count(): Promise<number>;
  /** Forget everything. */
  clear(): Promise<void>;
  /** Release the underlying store. Called on shutdown. */
  close(): Promise<void>;
}

/** The subset of `storage` config an adapter enforces, so it need not read the whole config. */
export interface StorageLimits {
  /** How many batches may wait at once. The oldest go first past this. */
  maxBatches: number;
  /** How old a batch may get before it is dropped rather than retried. */
  maxAgeMs: number;
  /** How many delivery attempts one batch gets before the retry engine dead-letters it. */
  maxAttempts: number;
}

/** What a prune threw away. Turned into a gap record, so the backend sees the hole. */
export interface PruneResult {
  /** How many batches were dropped. */
  batches: number;
  /** How many records went with them. */
  records: number;
  /** Which rule fired. A mixed prune reports the last one, since one label has to cover the lot. */
  reason: "expired" | "over_capacity" | "quota";
}

/** Told whenever records are thrown away, so the hole becomes visible downstream. */
export type GapReporter = (result: PruneResult) => void;

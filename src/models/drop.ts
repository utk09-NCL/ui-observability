// src/models/drop.ts
//
// Types of the onDrop report. The library calls onDrop when it loses records that it built.
// A record that sampling, minLevel or redact drops is not a loss.

import type { LogRecord } from "./log-record";

/**
 * Cause of a loss.
 * - "buffer_full": a hold buffer before startup or before the sender loads is full.
 * - "expired", "over_capacity", "quota": storage removed stored batches. The reasons are
 *   `retention.maxAgeMs`, `retention.maxBatches` and the storage quota of the browser.
 * - "max_attempts": a stored batch reached `retention.maxAttempts`.
 * - "rejected": the server refused the batch permanently, or one record is too large for it.
 * - "unserializable": the serializer threw on the batch.
 * - "exit_queue_full": the exit queue in localStorage is full. It drops its oldest batch.
 * - "load_failed": the delivery code did not load, or shutdown() came first. The held records are
 *   lost.
 * - "not_stored": storage did not keep a batch after a failed send. The cause is a write error or
 *   `storage: "none"`.
 */
export type LossReason =
  | "buffer_full"
  | "expired"
  | "over_capacity"
  | "quota"
  | "max_attempts"
  | "rejected"
  | "unserializable"
  | "exit_queue_full"
  | "load_failed"
  | "not_stored";

/**
 * One report of lost records. The library joins the losses of one reason in one task.
 * Each list holds at most 20 different values.
 */
export interface DropSummary {
  /** Cause of the loss. */
  reason: LossReason;
  /** Number of lost records. */
  records: number;
  /** Ids of the lost batches. A hold buffer loses records, not batches. Its list is empty. */
  batchIds: string[];
  /** Journey ids of the lost records. */
  journeyIds: string[];
  /** Names of the lost action records. An action is an audit fact. */
  actions: string[];
}

/**
 * Receives lost records. The runtime adds them to the onDrop report.
 * @param reason Cause of the loss.
 * @param records Lost records.
 * @param batchIds Ids of the lost batches.
 */
export type LossReporter = (
  reason: LossReason,
  records: readonly LogRecord[],
  batchIds?: readonly string[],
) => void;

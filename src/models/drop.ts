// src/models/drop.ts
//
// Types for the onDrop report. The library calls onDrop when it loses records it has already
// built. A record dropped by sampling, minLevel or redact is not a loss.

import type { LogRecord } from "./log-record";

/**
 * Why records were lost.
 * - "security_context": the delivery identity changed. The old identity's undelivered records
 *   are removed unless the rotation keeps them, and so are records forwarded during the change.
 * - "buffer_full": a hold buffer filled up before startup or before the sender loaded.
 * - "expired", "over_capacity", "quota": storage removed stored batches because of
 *   `retention.maxAgeMs`, `retention.maxBatches` or the browser's storage quota.
 * - "max_attempts": a stored batch reached `retention.maxAttempts`.
 * - "rejected": the server refused the batch permanently, or one record is too large for it.
 * - "partially_rejected": an OTLP server accepted the batch but rejected some records in it. The
 *   server gives only a count, so `journeyIds` and `actions` stay empty.
 * - "unserializable": the serializer threw on the batch.
 * - "exit_queue_full": the exit queue in localStorage is full, so it drops its oldest batch.
 * - "load_failed": the delivery code failed to load, or shutdown() came first. The held records
 *   are lost.
 * - "not_stored": storage did not keep a batch after a failed send, because of a write error or
 *   `storage: "none"`.
 * - "disabled": `enabled` is false, so nothing sends these records. They are a record that a
 *   child context forwards to a paused sender or a paused forwarder, and a record that a log
 *   call held before the first `configure()` call when that call sets `enabled: false` and its
 *   levels and sampling keep the record. At a pagehide or a `shutdown()` during a pause, they
 *   are also the records that wait for the sender, and the ones in its buffers, its queue and
 *   its requests. Each record is reported once, whatever comes later.
 * - "discarded": `shutdown()` with `pending: "discard"` or `clearStorage` dropped the records in
 *   memory without a send. A record in a request that is in flight isn't counted, because the
 *   request can still reach the server.
 */
export type LossReason =
  | "security_context"
  | "buffer_full"
  | "expired"
  | "over_capacity"
  | "quota"
  | "max_attempts"
  | "rejected"
  | "partially_rejected"
  | "unserializable"
  | "exit_queue_full"
  | "load_failed"
  | "not_stored"
  | "disabled"
  | "discarded";

/**
 * One report of lost records. Losses with the same reason in the same task are merged into one
 * report. Each list holds at most 20 distinct values.
 */
export interface DropSummary {
  /** Cause of the loss. */
  reason: LossReason;
  /** Number of lost records. */
  records: number;
  /** Ids of the lost batches. Empty for a hold buffer, which loses records, not batches. */
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
 * @param count Number of lost records when the caller can't name them. Defaults to the length
 * of `records`.
 */
export type LossReporter = (
  reason: LossReason,
  records: readonly LogRecord[],
  batchIds?: readonly string[],
  count?: number,
) => void;

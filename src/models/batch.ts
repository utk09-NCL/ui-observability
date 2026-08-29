// src/models/batch.ts
//
// A batch of log records for delivery to the ingest endpoint.

import { newId } from "../utils/identity";
import type { LogRecord } from "./log-record";

/**
 * A batch of records with a stable id used for server-side deduplication across retries.
 * @see {@link splitBatch}
 */
export interface LogBatch {
  /** Deduplication key. Stable across retries and reloads. */
  id: string;
  /** Records to deliver, in log order. */
  records: LogRecord[];
  /** Batch creation time, in epoch milliseconds. */
  createdAt: number;
  /** Delivery attempts so far. */
  attempts: number;
}

/**
 * Splits a batch the server rejected as too large into two halves.
 * Each half gets a fresh id; age and attempts carry over unchanged.
 * @param batch The rejected batch.
 * @returns Two batches, or `null` if a single record is already over the limit.
 */
export function splitBatch(batch: LogBatch): [LogBatch, LogBatch] | null {
  if (batch.records.length < 2) {
    return null;
  }

  const middle = Math.floor(batch.records.length / 2);
  const halve = (records: LogRecord[]): LogBatch => ({
    id: newId(),
    records,
    createdAt: batch.createdAt,
    attempts: batch.attempts,
  });

  return [halve(batch.records.slice(0, middle)), halve(batch.records.slice(middle))];
}

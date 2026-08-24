// src/models/batch.ts
//
// The unit of delivery: records that travel, persist and are acknowledged
// together.

import { newId } from "../utils/identity";
import type { LogRecord } from "./log-record";

/**
 * A batch carries its own id from creation through every retry, including
 * through storage and across a page reload. The server deduplicates on it,
 * which is what makes at-least-once delivery safe.
 */
export interface LogBatch {
  /** The server's deduplication key. Stable for the life of the batch, reload included. */
  id: string;
  /** The records to deliver, in the order they were logged. */
  records: LogRecord[];
  /** When the batch was formed, in milliseconds. What an age limit is measured against. */
  createdAt: number;
  /** Delivery attempts so far. What an attempt limit counts. */
  attempts: number;
}

/**
 * Halve a batch the server rejected as too large. Returns null when there is
 * nothing left to halve, meaning one record is over the limit and no amount of
 * splitting will help.
 *
 * Both halves get fresh ids, because they are different payloads and the id is
 * the server's deduplication key. Age and attempts carry over: a split is not a
 * second chance.
 *
 * Splitting lives here, with whoever owns the queue, rather than in the
 * transport. A transport that splits and re-sends recursively cannot report
 * that the first half succeeded and the second did not: the error propagates,
 * the caller stores the whole original batch, and the delivered half arrives
 * again under an id the server has never seen and cannot deduplicate.
 *
 * @param batch The rejected batch.
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

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
 * Whether a value parsed out of storage carries the whole batch contract. An entry
 * missing `id` is never matched by `keyOf` after delivery, so it is retried forever
 * and blocks every batch behind it. One missing `attempts` counts as NaN, never
 * reaches `maxAttempts`, and is never dead-lettered.
 * @param value Parsed storage entry.
 * @returns True when every required field is present and correctly typed.
 */
export function isLogBatch(value: unknown): value is LogBatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const id: unknown = Reflect.get(value, "id");
  const createdAt: unknown = Reflect.get(value, "createdAt");
  const attempts: unknown = Reflect.get(value, "attempts");
  const records: unknown = Reflect.get(value, "records");

  return (
    typeof id === "string" &&
    typeof createdAt === "number" &&
    typeof attempts === "number" &&
    Array.isArray(records)
  );
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

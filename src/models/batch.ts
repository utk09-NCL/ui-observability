// src/models/batch.ts
//
// A batch of log records for delivery to the ingest endpoint.

import { ATTR_LOG_TYPE, LOG_TYPE_ACTION } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { newId } from "../utils/identity";
import type { LogRecord } from "./log-record";

/**
 * A batch of records with a stable id used for server-side deduplication across retries.
 * @see {@link splitBatch}
 */
export interface LogBatch {
  /** Deduplication key. It stays the same across retries and reloads. */
  id: string;
  /** Records to deliver, in log order. */
  records: LogRecord[];
  /** Batch creation time, in epoch milliseconds. */
  createdAt: number;
  /** Delivery attempts so far. */
  attempts: number;
}

/**
 * Tells if a value from storage has all fields of a batch. `keyOf` cannot match
 * an entry without `id` after delivery. The library then retries that entry with no
 * end, and the entry blocks each batch behind it. An entry without `attempts` counts
 * as NaN. That count never reaches `maxAttempts`. Thus the library never drops the
 * entry as a dead letter.
 * @param value Parsed storage entry.
 * @returns True when each required field is present and has the correct type.
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
 * Splits a batch that the server rejected as too large into two halves.
 * Each half gets a new id. Each half keeps the age and attempts of the original batch.
 * @param batch The rejected batch.
 * @param diagnostics Diagnostics reporter for the new batch ids.
 * @returns Two batches, or `null` if a single record is already over the limit.
 */
export function splitBatch(batch: LogBatch, diagnostics: Diagnostics): [LogBatch, LogBatch] | null {
  if (batch.records.length < 2) {
    return null;
  }

  const middle = Math.floor(batch.records.length / 2);
  const halve = (records: LogRecord[]): LogBatch => ({
    id: newId(diagnostics),
    records,
    createdAt: batch.createdAt,
    attempts: batch.attempts,
  });

  return [halve(batch.records.slice(0, middle)), halve(batch.records.slice(middle))];
}

/**
 * Reads one attribute of a record. A record from storage can be corrupt. It can be null or have
 * no attributes.
 * @param record Record to read.
 * @param key Attribute key.
 * @returns The attribute value, or undefined for a corrupt record.
 */
export function attributeOf(record: LogRecord, key: string): unknown {
  const value: unknown = record;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const attributes: unknown = Reflect.get(value, "attributes");
  if (typeof attributes !== "object" || attributes === null) {
    return undefined;
  }

  return Reflect.get(attributes, key);
}

/**
 * Tests if a record is an action. A corrupt record from storage is not an action.
 * @param record Record to test.
 * @returns True for an action record.
 */
export function isActionRecord(record: LogRecord): boolean {
  return attributeOf(record, ATTR_LOG_TYPE) === LOG_TYPE_ACTION;
}

/**
 * Returns the total record count of the batches.
 * @param batches Batches to measure.
 * @returns Total record count.
 */
export function countRecords(batches: readonly LogBatch[]): number {
  return batches.reduce((total, batch) => total + batch.records.length, 0);
}

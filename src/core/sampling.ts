// src/core/sampling.ts
//
// Whether a record is kept. Keyed on the journey, so a sampled journey arrives
// whole rather than as scattered records.

import {
  ATTR_APP_NAMESPACE,
  ATTR_JOURNEY_ID,
  ATTR_LOG_TYPE,
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
  UINT32_MAX,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogRecord } from "../models/log-record";

/**
 * FNV-1a, 32 bit. Spreads ids evenly. Not a security hash.
 *
 * @param value The key to hash.
 * @returns An unsigned 32 bit integer.
 */
function hash(value: string): number {
  let h = FNV_OFFSET_BASIS;

  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }

  return h >>> 0;
}

/**
 * One attribute as a string. Absent and non-string both read as empty: a
 * forwarded record has only passed a shape check.
 *
 * @param record The record being sampled.
 * @param key Which attribute to read.
 */
function readAttr(record: LogRecord, key: string): string {
  const value: unknown = record.attributes[key];
  return typeof value === "string" ? value : "";
}

/**
 * The rate for a namespace. Longest matching prefix wins, so `trading.ticks`
 * overrides `trading`.
 *
 * @param namespace The record's `app.namespace`.
 * @param config The live config.
 * @returns The matching rate, or `defaultRate`.
 */
function rateFor(namespace: string, config: ResolvedConfig): number {
  const { rates, defaultRate } = config.sampling;
  let best: number | undefined;
  let bestLength = -1;

  for (const [prefix, rate] of Object.entries(rates)) {
    const matches = namespace === prefix || namespace.startsWith(`${prefix}.`);

    if (matches && prefix.length > bestLength) {
      best = rate;
      bestLength = prefix.length;
    }
  }

  return best ?? defaultRate;
}

/**
 * Whether this record is kept. Deterministic per journey, across windows and
 * reloads.
 *
 * @param record The record to judge.
 * @param config The live config, read through so a reconfigure applies.
 */
export function shouldSample(record: LogRecord, config: ResolvedConfig): boolean {
  // Errors bypass sampling.
  if (record.severityText === "ERROR" || record.severityText === "FATAL") {
    return true;
  }

  if (config.sampling.alwaysSampleTypes.includes(readAttr(record, ATTR_LOG_TYPE))) {
    return true;
  }

  const rate = rateFor(readAttr(record, ATTR_APP_NAMESPACE), config);
  if (rate >= SAMPLING_RATE_MAX) {
    return true;
  }
  if (rate <= SAMPLING_RATE_MIN) {
    return false;
  }

  // No journey: the trace still groups one operation.
  const key = readAttr(record, ATTR_JOURNEY_ID) || record.traceId;

  return hash(key) / UINT32_MAX < rate;
}

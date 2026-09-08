// src/core/sampling.ts
//
// Deterministic record sampling based on namespace rules, journey IDs, and trace
// IDs. Keyed on the journey, so one journey is kept or dropped whole. Stable
// across windows and reloads.

import {
  ATTR_APP_NAMESPACE,
  ATTR_JOURNEY_ID,
  ATTR_LOG_TYPE,
  ERROR_CEILING_MAX_PER_WINDOW,
  ERROR_STORM_WINDOW_MS,
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
  UINT32_MAX,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogRecord } from "../models/log-record";

/**
 * Computes 32-bit FNV-1a hash of a string value. Not a security hash.
 * @param value Key string to hash.
 * @returns Unsigned 32-bit integer hash.
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
 * Safely extracts a string attribute value from a log record. Absent and non-string
 * both read as empty. A forwarded record has only passed a shape check.
 * @param record Log record being evaluated.
 * @param key Attribute key.
 * @returns String attribute value, or empty string if missing or non-string.
 */
function readAttr(record: LogRecord, key: string): string {
  const value: unknown = record.attributes[key];
  return typeof value === "string" ? value : "";
}

/**
 * Resolves sampling rate for a namespace using longest-prefix matching, so
 * trading.ticks overrides trading.
 * @param namespace Target application namespace.
 * @param config Active configuration instance.
 * @returns Matched namespace sampling rate or default rate.
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
 * Evaluates whether a log record should be sampled for retention.
 * @param record Record to evaluate.
 * @param config Active configuration instance.
 * @returns True if the record should be retained and transmitted.
 */
export function shouldSample(record: LogRecord, config: ResolvedConfig): boolean {
  // Errors and fatal records bypass sampling filters.
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

  // Falls back to trace ID when journey ID is absent. The trace still groups one
  // operation.
  const key = readAttr(record, ATTR_JOURNEY_ID) || record.traceId;

  return hash(key) / UINT32_MAX < rate;
}

/**
 * Fixed-window ceiling on the ERROR and FATAL records that bypass sampling.
 *
 * Auto-captured errors are already limited inside ErrorCapture. This covers the
 * case nothing else does: application code calling logger.error in a render loop.
 */
export class ErrorCeiling {
  /** Start of the window currently counting, in epoch milliseconds. */
  private windowStart = 0;

  /** ERROR and FATAL records admitted in the current window. */
  private count = 0;

  /**
   * Admits a record against the ceiling, counting only ERROR and FATAL.
   * @param record Record about to enter a stream.
   * @returns False when the window is spent and the record must be dropped.
   */
  allow(record: LogRecord): boolean {
    if (record.severityText !== "ERROR" && record.severityText !== "FATAL") {
      return true;
    }

    const now = Date.now();
    // Fixed window, not a sliding one: a quiet spell banks no allowance.
    if (now - this.windowStart > ERROR_STORM_WINDOW_MS) {
      this.windowStart = now;
      this.count = 0;
    }

    this.count++;

    return this.count <= ERROR_CEILING_MAX_PER_WINDOW;
  }
}

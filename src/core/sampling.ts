// src/core/sampling.ts
//
// This module samples records by namespace rule, journey ID and trace ID.
// The journey ID is the sampling key. The module keeps or drops a full journey.
// The result is the same across windows and reloads.

import {
  ATTR_APP_NAMESPACE,
  ATTR_JOURNEY_ID,
  ATTR_LOG_TYPE,
  ERROR_CEILING_MAX_PER_WINDOW,
  ERROR_STORM_WINDOW_MS,
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  LEVEL_BYPASS_TYPES,
  LEVEL_ORDER,
  METRIC_KEYS,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
  UINT32_MAX,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogLevel, LogRecord, LogType } from "../models/log-record";
import type { RemoteRules } from "./remote-sampling";

/**
 * Computes the 32-bit FNV-1a hash of a string. Do not use it as a security hash.
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
 * Reads a string attribute from a log record. It returns an empty string for an absent
 * or non-string value. A forwarded record has passed only a shape check.
 * @param record Log record to test.
 * @param key Attribute key.
 * @returns String attribute value, or empty string if missing or non-string.
 */
function readAttr(record: LogRecord, key: string): string {
  const value: unknown = record.attributes[key];
  return typeof value === "string" ? value : "";
}

/** Rate of the longest prefix that matches a namespace. */
interface PrefixMatch {
  /** Sampling rate of the prefix. */
  rate: number;
  /** Length of the prefix. */
  length: number;
}

/**
 * Finds the longest prefix in a rate map that matches a namespace.
 * For example, trading.ticks overrides trading.
 * @param namespace Target application namespace.
 * @param rates Rate for each namespace prefix.
 * @returns The match, or undefined if no prefix matches.
 */
function longestPrefix(namespace: string, rates: Record<string, number>): PrefixMatch | undefined {
  let best: PrefixMatch | undefined;

  for (const [prefix, rate] of Object.entries(rates)) {
    const matches = namespace === prefix || namespace.startsWith(`${prefix}.`);

    if (matches && prefix.length > (best?.length ?? -1)) {
      best = { rate, length: prefix.length };
    }
  }

  return best;
}

/**
 * Finds the sampling rate for a namespace. The longest matching prefix wins.
 * A remote prefix wins over a config prefix of the same length.
 * @param namespace Target application namespace.
 * @param config Active configuration instance.
 * @param remote Remote rules in force, or null.
 * @returns Matched namespace sampling rate or default rate.
 */
function rateFor(namespace: string, config: ResolvedConfig, remote: RemoteRules | null): number {
  const { rates, defaultRate, remoteMaxRate } = config.sampling;
  const local = longestPrefix(namespace, rates);
  const fromRemote = remote ? longestPrefix(namespace, remote.rates) : undefined;

  // Cap a remote rate when sampling reads it. A configure() that lowers the cap then applies
  // immediately.
  if (fromRemote && fromRemote.length >= (local?.length ?? -1)) {
    return Math.min(fromRemote.rate, remoteMaxRate);
  }

  if (local) {
    return local.rate;
  }

  return remote?.defaultRate === undefined
    ? defaultRate
    : Math.min(remote.defaultRate, remoteMaxRate);
}

/** Fields that sampling reads. The caller knows all of them before it builds a record. */
export interface SampleInput {
  /** Severity level of the entry. */
  level: string;
  /** Telemetry type classification. */
  type: string;
  /** Originating application namespace. */
  namespace: string;
  /** Active journey ID. It is empty when no journey runs. */
  journeyId: string;
  /** Trace ID. It is the sampling key when no journey runs. */
  traceId: string;
  /** True for a point of a counter or histogram. A sample of a sum gives a false sum. */
  aggregated?: boolean;
}

/**
 * Decides if sampling keeps an entry. It reads fields, not a record.
 * This lets the caller drop an entry before the attribute walk runs.
 * @param input Fields the sampling decision reads.
 * @param config Active configuration instance.
 * @param remote Remote rules in force, or null.
 * @returns True if the runtime keeps and sends the entry.
 */
export function shouldSampleInput(
  input: SampleInput,
  config: ResolvedConfig,
  remote: RemoteRules | null,
): boolean {
  // Errors, fatal records and aggregated points bypass sampling filters.
  if (input.aggregated === true || input.level === "ERROR" || input.level === "FATAL") {
    return true;
  }

  if (config.sampling.alwaysSampleTypes.includes(input.type)) {
    return true;
  }

  let rate = rateFor(input.namespace, config, remote);

  // A remote minLevel adds the records below minLevel. Cap them too, or they ship at the config rate.
  // minLevel does not apply to an action or a metric. Do not cap them.
  const belowMinLevel = LEVEL_ORDER[input.level as LogLevel] < LEVEL_ORDER[config.minLevel];
  if (remote && belowMinLevel && !LEVEL_BYPASS_TYPES.includes(input.type as LogType)) {
    rate = Math.min(rate, config.sampling.remoteMaxRate);
  }

  if (rate >= SAMPLING_RATE_MAX) {
    return true;
  }
  if (rate <= SAMPLING_RATE_MIN) {
    return false;
  }

  // Use the trace ID when the journey ID is absent. The trace ID still groups one
  // operation.
  const key = input.journeyId || input.traceId;

  return hash(key) / UINT32_MAX < rate;
}

/**
 * Decides if sampling keeps a built log record. The runtime uses it for records
 * that a child context sends over the bus.
 * @param record Record to evaluate.
 * @param config Active configuration instance.
 * @param remote Remote rules in force, or null.
 * @returns True if the runtime keeps and sends the record.
 */
export function shouldSample(
  record: LogRecord,
  config: ResolvedConfig,
  remote: RemoteRules | null = null,
): boolean {
  return shouldSampleInput(
    {
      level: record.severityText,
      type: readAttr(record, ATTR_LOG_TYPE),
      namespace: readAttr(record, ATTR_APP_NAMESPACE),
      journeyId: readAttr(record, ATTR_JOURNEY_ID),
      traceId: record.traceId,
      aggregated:
        readAttr(record, ATTR_LOG_TYPE) === "metric" && readAttr(record, METRIC_KEYS.start) !== "",
    },
    config,
    remote,
  );
}

/**
 * Sets a fixed-window limit on the ERROR and FATAL records that bypass sampling.
 *
 * ErrorCapture already limits auto-captured errors. This class limits the remaining case.
 * An example is application code that calls logger.error in a render loop.
 */
export class ErrorCeiling {
  /** Start of the current window, in epoch milliseconds. */
  private windowStart = 0;

  /** ERROR and FATAL records admitted in the current window. */
  private count = 0;

  /**
   * Checks a record against the limit. It counts only ERROR and FATAL records.
   * @param record Record about to enter a stream.
   * @returns False when the window has no allowance left. The caller must drop the record.
   */
  allow(record: LogRecord): boolean {
    if (record.severityText !== "ERROR" && record.severityText !== "FATAL") {
      return true;
    }

    const now = Date.now();
    // Use a fixed window, not a sliding window. A quiet period adds no allowance.
    if (now - this.windowStart > ERROR_STORM_WINDOW_MS) {
      this.windowStart = now;
      this.count = 0;
    }

    this.count++;

    return this.count <= ERROR_CEILING_MAX_PER_WINDOW;
  }
}

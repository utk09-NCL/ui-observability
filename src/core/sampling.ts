// src/core/sampling.ts
//
// Samples records by namespace rule, journey ID and trace ID.
// The journey ID is the sampling key, so a whole journey is kept or dropped together and
// the result is the same across windows and reloads.

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
  LOG_TYPE_SPAN,
  METRIC_KEYS,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
  UINT32_MAX,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogLevel, LogRecord, LogType } from "../models/log-record";
import { countInWindow, type StormWindow } from "../utils/fixed-window";
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
 * Reads a string attribute from a log record. Returns an empty string for an absent
 * or non-string value, because a forwarded record has only passed a shape check.
 * @param record Log record to read from.
 * @param key Attribute key.
 * @returns String attribute value, or empty string if missing or non-string.
 */
function readAttr(record: LogRecord, key: string): string {
  const value: unknown = record.attributes[key];
  return typeof value === "string" ? value : "";
}

/** Value of the longest prefix that matches a namespace. */
interface PrefixMatch<T> {
  /** The prefix's value, for example a rate or a level. */
  value: T;
  /** Length of the prefix. */
  length: number;
}

/**
 * Finds the longest prefix in a map that matches a namespace.
 * For example, trading.ticks overrides trading.
 * @param namespace Target application namespace.
 * @param values Value for each namespace prefix.
 * @returns The match, or undefined if no prefix matches.
 */
export function longestPrefix<T>(
  namespace: string,
  values: Record<string, T>,
): PrefixMatch<T> | undefined {
  let best: PrefixMatch<T> | undefined;

  for (const [prefix, value] of Object.entries(values)) {
    const matches = namespace === prefix || namespace.startsWith(`${prefix}.`);

    if (matches && prefix.length > (best?.length ?? -1)) {
      best = { value, length: prefix.length };
    }
  }

  return best;
}

/**
 * Finds a namespace's minimum level in the config. The longest matching prefix in
 * `minLevels` wins, and a namespace with no match uses `minLevel`.
 * @param namespace Target application namespace.
 * @param config Active configuration instance.
 * @returns The namespace's minimum level.
 */
export function levelFor(namespace: string, config: ResolvedConfig): LogLevel {
  return longestPrefix(namespace, config.minLevels)?.value ?? config.minLevel;
}

/**
 * Finds the sampling rate for a namespace. The longest matching prefix wins.
 * A remote prefix wins over a config prefix of the same length.
 * @param namespace Target application namespace.
 * @param config Active configuration instance.
 * @param remote Current remote rules, or null.
 * @returns Matched namespace sampling rate or default rate.
 */
function rateFor(namespace: string, config: ResolvedConfig, remote: RemoteRules | null): number {
  const { rates, defaultRate, remoteMaxRate } = config.sampling;
  const local = longestPrefix(namespace, rates);
  const fromRemote = remote ? longestPrefix(namespace, remote.rates) : undefined;

  // Cap a remote rate at the point where sampling reads it, so a configure() that lowers the
  // cap takes effect immediately.
  if (fromRemote && fromRemote.length >= (local?.length ?? -1)) {
    return Math.min(fromRemote.value, remoteMaxRate);
  }

  if (local) {
    return local.value;
  }

  return remote?.defaultRate === undefined
    ? defaultRate
    : Math.min(remote.defaultRate, remoteMaxRate);
}

/**
 * Checks whether a level is at or above a threshold level.
 * @param level The record's level. A forwarded record can hold any string.
 * @param from Threshold level.
 * @returns True for a known level that isn't below the threshold.
 */
function atOrAbove(level: string, from: LogLevel): boolean {
  return LEVEL_ORDER[level as LogLevel] >= LEVEL_ORDER[from];
}

/**
 * Decides whether sampling keeps a key at a rate. The same key always gets the same result.
 * @param key Journey ID or trace ID.
 * @param rate Sampling rate, 0..1.
 * @returns True if sampling keeps the key.
 */
export function sampleKey(key: string, rate: number): boolean {
  if (rate >= SAMPLING_RATE_MAX) {
    return true;
  }
  if (rate <= SAMPLING_RATE_MIN) {
    return false;
  }

  return hash(key) / UINT32_MAX < rate;
}

/** Fields that sampling reads. The caller knows all of them before it builds a record. */
export interface SampleInput {
  /** Severity level of the entry. */
  level: string;
  /** Telemetry type classification. */
  type: string;
  /** Originating application namespace. */
  namespace: string;
  /** Active journey ID. Empty when no journey is running. */
  journeyId: string;
  /** Trace ID. Used as the sampling key when no journey is running. */
  traceId: string;
  /** True for a counter or histogram point. Sampling a sum would give a false sum. */
  aggregated?: boolean;
}

/**
 * Decides whether sampling keeps an entry. Reads fields, not a record, so the caller can
 * drop an entry before the attribute walk runs.
 * @param input Fields the sampling decision reads.
 * @param config Active configuration instance.
 * @param remote Current remote rules, or null.
 * @returns True if the runtime keeps and sends the entry.
 */
export function shouldSampleInput(
  input: SampleInput,
  config: ResolvedConfig,
  remote: RemoteRules | null,
): boolean {
  // Records at or above alwaysSampleFrom and aggregated points bypass sampling filters. The
  // runtime samples a span by its trace before it records the span.
  if (
    input.aggregated === true ||
    input.type === LOG_TYPE_SPAN ||
    atOrAbove(input.level, config.sampling.alwaysSampleFrom)
  ) {
    return true;
  }

  if (config.sampling.alwaysSampleTypes.includes(input.type as LogType)) {
    return true;
  }

  let rate = rateFor(input.namespace, config, remote);

  // A remote level lets in records below the namespace's config level. Cap those too, or they
  // ship at the config rate. The level doesn't apply to an action or a metric, so don't cap
  // them.
  const configLevel = levelFor(input.namespace, config);
  const belowMinLevel = LEVEL_ORDER[input.level as LogLevel] < LEVEL_ORDER[configLevel];
  if (remote && belowMinLevel && !LEVEL_BYPASS_TYPES.includes(input.type as LogType)) {
    rate = Math.min(rate, config.sampling.remoteMaxRate);
  }

  // Fall back to the trace ID when there is no journey ID. It still groups one operation.
  return sampleKey(input.journeyId || input.traceId, rate);
}

/**
 * Decides whether sampling keeps a built log record. The runtime uses it for records
 * that a child context sends over the bus.
 * @param record Record to evaluate.
 * @param config Active configuration instance.
 * @param remote Current remote rules, or null.
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
 * Puts a fixed-window limit on the records that bypass sampling because of their level.
 *
 * ErrorCapture already limits auto-captured errors. This class covers what is left, for
 * example application code that calls logger.error in a render loop.
 */
export class ErrorCeiling {
  /** Records at or above the threshold level admitted in the current window. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /**
   * Checks a record against the limit. Only records at or above `from` are counted.
   * @param record Record about to enter a stream.
   * @param limit Maximum records in one window. 0 allows none, and null means no limit.
   * @param windowMs Rate limit window, in milliseconds.
   * @param from Lowest level that bypasses sampling.
   * @returns False when the window has no allowance left. The caller must drop the record.
   */
  allow(
    record: LogRecord,
    limit: number | null = ERROR_CEILING_MAX_PER_WINDOW,
    windowMs = ERROR_STORM_WINDOW_MS,
    from: LogLevel = "ERROR",
  ): boolean {
    if (!atOrAbove(record.severityText, from)) {
      return true;
    }

    // Use a fixed window, not a sliding one, so a quiet period adds no allowance.
    return limit === null || countInWindow(this.window, limit, windowMs);
  }
}

// src/models/log-record.ts
//
// Shape of one log record, plus helpers for building and validating it.
//
// The severity tables live in `src/constants.ts`.

import { LEVEL_ORDER } from "../constants";

/** OpenTelemetry severity levels, in ascending order. */
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/**
 * What a record is about. `action` is something a person did, `event` is something the
 * application did, and `metric` is a measurement. `log` is an application log call,
 * `system` is this library's own output and `span` is one span of a trace.
 */
export type LogType = "action" | "event" | "metric" | "log" | "system" | "span";

/** Metric value type: level, running total, or distribution. */
export type MetricType = "gauge" | "counter" | "histogram";

/** Internal record shape. A serializer converts it to the payload format. */
export interface LogRecord {
  /**
   * Event time, nanoseconds since epoch, as a decimal string.
   * @see {@link nowUnixNano}
   */
  timeUnixNano: string;
  /**
   * When this library received the event, if that differs from `timeUnixNano`. A forwarded
   * record, for example, can have a different time.
   */
  observedTimeUnixNano?: string;
  /** Distributed trace id. */
  traceId: string;
  /** Span id within the trace. */
  spanId: string;
  /** OpenTelemetry trace flags. The library uses only the sampled bit. */
  traceFlags: number;
  /** OpenTelemetry severity number for `severityText`. */
  severityNumber: number;
  /** Log level. */
  severityText: LogLevel;
  /** Log message. */
  body: string;
  /** Structured attributes, sanitized and size-capped. */
  attributes: Record<string, unknown>;
  /** Resource attributes, shared by every record from one context. */
  resource: Record<string, unknown>;
}

/**
 * Returns the current time as a Unix nanosecond timestamp. Appends zeros instead of
 * multiplying, because `Date.now() * 1e6` exceeds `Number.MAX_SAFE_INTEGER` and corrupts
 * digits without an error. The trailing zeros mean unknown precision, not measured digits.
 * @returns Epoch timestamp in nanoseconds, as a decimal string.
 */
export function nowUnixNano(): string {
  return `${String(Date.now())}000000`;
}

/**
 * Checks whether a value is a known log level. The own-key check rejects "toString".
 * @param value The value to check.
 * @returns True if `value` is a key of the severity table.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LEVEL_ORDER, value);
}

/**
 * Checks whether a value has the shape `LogRecord` requires. Use it to validate records from
 * another realm, because a malformed record throws during serialization. Any string is
 * accepted as `severityText`, not only a known level, so an unknown level from a newer
 * version still passes.
 * @param value The value to check.
 * @returns True if `value` has the shape `LogRecord` requires.
 */
export function isLogRecord(value: unknown): value is LogRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Cast to `Record<string, unknown>`, not `Partial<LogRecord>`. With the partial type the
  // compiler treats these fields as never null, so the checks below would look unnecessary.
  const record = value as Record<string, unknown>;
  return (
    typeof record.body === "string" &&
    typeof record.severityText === "string" &&
    typeof record.timeUnixNano === "string" &&
    typeof record.attributes === "object" &&
    record.attributes !== null &&
    typeof record.resource === "object" &&
    record.resource !== null
  );
}

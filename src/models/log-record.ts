// src/models/log-record.ts
//
// Shape of one log record, plus helpers for building and validating it.
//
// Severity tables live in `src/constants.ts`.

/** OpenTelemetry severity levels, in ascending order. */
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/**
 * Kind of thing a record describes: `action` (something a person did),
 * `event` (something the application did), `metric` (a measurement), or
 * `system` (this library's own diagnostic output).
 */
export type LogType = "action" | "event" | "metric" | "system";

/** Metric value type: level, running total, or distribution. */
export type MetricType = "gauge" | "counter" | "histogram";

/** Internal record shape, converted to wire format by a serializer. */
export interface LogRecord {
  /**
   * Event time, nanoseconds since epoch, as a decimal string.
   * @see {@link nowUnixNano}
   */
  timeUnixNano: string;
  /** Time this library received the event, if different from `timeUnixNano` (e.g. on a forwarded record). */
  observedTimeUnixNano?: string;
  /** Distributed trace id. */
  traceId: string;
  /** Span id within the trace. */
  spanId: string;
  /** OpenTelemetry trace flags. Only the sampled bit is used. */
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
 * Returns the current time as a Unix nanosecond timestamp.
 * Concatenates rather than multiplies: `Date.now() * 1e6` overflows
 * `Number.MAX_SAFE_INTEGER` and silently corrupts digits. Trailing zeros are
 * unknown precision, not real.
 * @returns Epoch timestamp in nanoseconds, as a decimal string.
 */
export function nowUnixNano(): string {
  return `${String(Date.now())}000000`;
}

/**
 * Checks whether a value has the shape `LogRecord` requires.
 * Used to validate records arriving from another realm, since a malformed
 * one throws during serialization. `severityText` is checked as a string,
 * not a known level, so an unrecognised level from a newer version still
 * passes.
 * @param value The value to check.
 * @returns Whether `value` has the shape `LogRecord` requires.
 */
export function isLogRecord(value: unknown): value is LogRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Widened to `unknown` rather than asserted as `Partial<LogRecord>`, which
  // would tell the compiler these fields are never null and make the checks
  // below look unnecessary.
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

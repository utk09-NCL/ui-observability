// src/models/log-record.ts
//
// Shape of one log record, plus helpers for building and validating it.
//
// `src/constants.ts` contains the severity tables.

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

/** Internal record shape. A serializer converts it to the payload format. */
export interface LogRecord {
  /**
   * Event time, nanoseconds since epoch, as a decimal string.
   * @see {@link nowUnixNano}
   */
  timeUnixNano: string;
  /**
   * Time when this library received the event, if it differs from `timeUnixNano`.
   * For example, a forwarded record can have a different time.
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
 * Returns the current time as a Unix nanosecond timestamp.
 * The function appends zeros and does not multiply. `Date.now() * 1e6` is larger
 * than `Number.MAX_SAFE_INTEGER` and corrupts digits without an error. The trailing
 * zeros show unknown precision. They are not measured digits.
 * @returns Epoch timestamp in nanoseconds, as a decimal string.
 */
export function nowUnixNano(): string {
  return `${String(Date.now())}000000`;
}

/**
 * Checks whether a value has the shape `LogRecord` requires.
 * Use it to validate records from another realm. A malformed record throws
 * during serialization. The check accepts any string as `severityText`, not only
 * a known level. Thus an unknown level from a newer version passes.
 * @param value The value to check.
 * @returns Whether `value` has the shape `LogRecord` requires.
 */
export function isLogRecord(value: unknown): value is LogRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Cast to `Record<string, unknown>`, not to `Partial<LogRecord>`. With `Partial<LogRecord>`,
  // the compiler treats these fields as never null. The checks below then look unnecessary.
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

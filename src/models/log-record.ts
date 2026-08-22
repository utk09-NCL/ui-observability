// src/models/log-record.ts
//
// The shape of one record, and for now nothing else.
//
// Only the two declarations the configuration model needs exist yet. The
// severity tables, the timestamp helper and the cross-realm shape check arrive
// with the record builder, which is the first code that has something to number
// and something to validate. Those are runtime values rather than types, and
// shipping them ahead of the code that exercises them would put unreachable
// statements in front of a coverage gate that admits no exceptions. Types alone
// compile to an empty module, so this file costs nothing in the meantime.
//
// Final form: adds `LogType`, `MetricType`, `nowUnixNano()` and `isLogRecord()`
// beside the declarations below. The two tables that go with them,
// `SEVERITY_NUMBER` and `LEVEL_ORDER`, are constants and belong in
// `src/constants.ts` with everything else of that kind.

/**
 * Severity, from the OpenTelemetry set.
 * Ordered, so a configured minimum can be a comparison rather
 * than a lookup.
 */
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/**
 * The internal record. Flat and easy to work with.
 *
 * A serializer converts it to the wire format at the transport boundary, so
 * changing the wire format never touches the pipeline.
 */
export interface LogRecord {
  /**
   * When the event happened, in nanoseconds since the epoch. A string, because the number exceeds
   * what a double holds exactly.
   */
  timeUnixNano: string;
  /** When this library saw the event, where that differs from when it happened. */
  observedTimeUnixNano?: string;
  /** Correlates this record with the rest of one distributed operation. */
  traceId: string;
  /** The span within that trace this record belongs to. */
  spanId: string;
  /** OpenTelemetry trace flags, of which only the sampled bit is in use. */
  traceFlags: number;
  /** `severityText` as its OpenTelemetry number, which is what backends sort and filter on. */
  severityNumber: number;
  /** The level this record was logged at. */
  severityText: LogLevel;
  /** The message. */
  body: string;
  /** Everything structured about this one record. Sanitized and size-capped before it gets here. */
  attributes: Record<string, unknown>;
  /** identical for every record from one context, hoisted by the serializer */
  resource: Record<string, unknown>;
}

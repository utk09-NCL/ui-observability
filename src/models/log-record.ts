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
// Final form: adds `LogType`, `MetricType`, `SEVERITY_NUMBER`, `LEVEL_ORDER`,
// `nowUnixNano()` and `isLogRecord()` beside the declarations below.

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/**
 * The internal record. Flat and easy to work with.
 *
 * A serializer converts it to the wire format at the transport boundary, so
 * changing the wire format never touches the pipeline.
 */
export interface LogRecord {
  timeUnixNano: string;
  observedTimeUnixNano?: string;
  traceId: string;
  spanId: string;
  traceFlags: number;
  severityNumber: number;
  severityText: LogLevel;
  body: string;
  attributes: Record<string, unknown>;
  /** identical for every record from one context, hoisted by the serializer */
  resource: Record<string, unknown>;
}

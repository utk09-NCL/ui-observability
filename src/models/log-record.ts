// src/models/log-record.ts
//
// The shape of one record, plus the runtime that is a fact about that shape
// rather than about any component: how a timestamp is spelled, and how to tell
// a record from anything else claiming to be one.
//
// The severity tables live in `src/constants.ts` with every other constant.

/** Severity, from the OpenTelemetry set. Ordered, so a configured minimum is a comparison. */
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/**
 * What kind of thing a record describes. Sampling rates are keyed by it and
 * dashboards split on it.
 *
 * `action` is something a person did, `event` something the application did,
 * `metric` a measurement, and `system` this library talking about itself.
 */
export type LogType = "action" | "event" | "metric" | "system";

/** How a metric's value should be read: a level, a running total, or a distribution. */
export type MetricType = "gauge" | "counter" | "histogram";

/**
 * The internal record. Flat and easy to work with. A serializer converts it to
 * the wire format at the transport boundary, so the format never touches the
 * pipeline.
 */
export interface LogRecord {
  /**
   * When the event happened, in nanoseconds since the epoch. A string, because the number exceeds
   * what a double holds exactly.
   */
  timeUnixNano: string;
  /**
   * When this library saw the event, where that differs from when it happened.
   *
   * Set by whichever context puts the record into its own pipeline, never by
   * the emitter, and never in the same statement as `timeUnixNano`. The two
   * differ on a forwarded record, and that difference is the only measure of
   * forwarding lag there is.
   */
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

/**
 * The current time as every record timestamp is spelled: nanoseconds since the
 * epoch, as a decimal string.
 *
 * Concatenated, not multiplied. `Date.now() * 1e6` prints the right digits only
 * because milliseconds leave 13 significant digits, and any decimal of 15 or
 * fewer round-trips through a double; a source with microsecond precision would
 * start rounding silently. The same arithmetic is why the field is a string at
 * every hop: 19 digits cannot survive a `Number`.
 *
 * The six zeros say the finer digits are unknown. Do not fill them with
 * `performance.now()` fractions.
 */
export function nowUnixNano(): string {
  return `${String(Date.now())}000000`;
}

/**
 * A cheap shape check for a record that arrived from another realm.
 *
 * Forwarded records are structured clones built by code this process does not
 * control, and the bus checks its own envelope and not the cargo. One record
 * missing `attributes` makes `Object.entries(undefined)` throw in the
 * serializer, the transport calls the whole batch unserializable, and a hundred
 * good records die with it. One bad record must poison one record.
 *
 * In the model rather than the bus because it is a fact about the type, which
 * both the runtime and its tests want.
 *
 * Loose about `severityText` on purpose: it is checked as a string, not as a
 * known level. An unrecognised level from a newer version still carries its own
 * `severityNumber` and still serializes, so rejecting it would drop real
 * records on a version skew.
 */
export function isLogRecord(value: unknown): value is LogRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Widened to unknown values rather than asserted as a `Partial<LogRecord>`,
  // which would promise the compiler these fields are never null and make the
  // checks below lint as unnecessary conditions. The declared type is the claim
  // being tested, and this value was built where this code has no say.
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

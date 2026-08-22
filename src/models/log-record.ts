// src/models/log-record.ts
//
// The shape of one record, plus the small amount of runtime that is a fact
// about that shape rather than about any component: how a timestamp is spelled,
// and how to tell a record from anything else that arrives claiming to be one.
//
// The severity tables that go with these types are constants, so they live in
// `src/constants.ts` with everything else of that kind rather than here.

/**
 * Severity, from the OpenTelemetry set.
 * Ordered, so a configured minimum can be a comparison rather
 * than a lookup.
 */
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/**
 * What kind of thing a record describes, which is what sampling rates are keyed
 * by and what dashboards split on.
 *
 * `action` is something a person did, `event` something the application did,
 * `metric` a measurement, and `system` this library talking about itself.
 */
export type LogType = "action" | "event" | "metric" | "system";

/** How a metric's value should be read: a level, a running total, or a distribution. */
export type MetricType = "gauge" | "counter" | "histogram";

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
  /**
   * When this library saw the event, where that differs from when it happened.
   *
   * Set by whichever context puts the record into its own pipeline, never by
   * the emitter, and never in the same statement as `timeUnixNano`. On a record
   * forwarded from a frame or a worker the two genuinely differ, and that
   * difference is the only measure of forwarding lag there is. Setting both at
   * once makes the field say nothing.
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
 * The current time in the spelling every record timestamp uses: nanoseconds
 * since the epoch, as a decimal string.
 *
 * Built by concatenation rather than by multiplying. `Date.now() * 1e6` does
 * print the right digits today, but only by accident: it lands around 1.8e18,
 * two hundred times past the largest integer a double holds exactly, and it
 * survives solely because milliseconds leave just 13 significant digits and any
 * decimal of 15 or fewer round-trips through a double. That is a property of
 * the current clock resolution, not of the format. Give this a source with
 * microsecond precision and the same multiplication starts rounding silently,
 * with nothing to notice it by. Concatenation is exact by construction, so it
 * cannot acquire that failure later.
 *
 * The same arithmetic is why `timeUnixNano` is a string at every hop rather than
 * a number: a full-precision nanosecond value is 19 digits and cannot survive a
 * `Number` at all.
 *
 * Millisecond precision is all a browser reliably offers, so the six appended
 * zeros are honest: they say the finer digits are unknown rather than measured.
 * Do not fill them with `performance.now()` fractions to look more precise.
 */
export function nowUnixNano(): string {
  return `${String(Date.now())}000000`;
}

/**
 * A cheap shape check for a record that arrived from another realm.
 *
 * Records forwarded from a frame or a worker are structured clones built by
 * code this process does not control, and nothing on the way in inspects the
 * cargo: the bus checks its own envelope and no more. One record missing
 * `attributes` reaching the serializer means `Object.entries(undefined)` throws,
 * the transport classifies the whole batch as unserializable, and a hundred
 * good records from other contexts die with it. So one bad record has to poison
 * exactly one record, which is the same rule payload sanitizing already
 * enforces on the way in.
 *
 * This lives in the model rather than in the bus because it is a fact about the
 * type, and both the runtime and its tests want it.
 *
 * Deliberately loose about `severityText`, which is checked as a string and not
 * as a known level. An unrecognised level from a newer version of this library
 * still carries its own `severityNumber` and still serializes, so passing it
 * through costs a slightly optimistic type predicate, while rejecting it would
 * silently drop real records on a version skew.
 */
export function isLogRecord(value: unknown): value is LogRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Widened to unknown values rather than asserted as a `Partial<LogRecord>`.
  // That shape would promise the compiler these fields are never null, and the
  // null checks below would then lint as unnecessary conditions. They are not
  // unnecessary: this value was built somewhere this code does not control, and
  // the declared type is exactly the claim being tested.
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

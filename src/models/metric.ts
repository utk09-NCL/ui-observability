// src/models/metric.ts
//
// Types for the counter and histogram instruments.

/** Attribute set of a metric point. Keep it small, because every set is a series in the backend. */
export type MetricAttributes = Record<string, string | number | boolean>;

/** Instrument options. */
export interface InstrumentOptions {
  /**
   * Unit of the values, for example "ms" or "By".
   * @default "count"
   */
  unit?: string;
}

/** Histogram options. */
export interface HistogramOptions extends InstrumentOptions {
  /**
   * Ascending bucket boundaries, at most 50. A value goes into the first bucket whose boundary
   * is greater than or equal to it.
   * @default [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]
   */
  boundaries?: readonly number[];
}

/** Counter that sums its values in memory. The library sends one point every interval. */
export interface Counter {
  /**
   * Adds a value to an attribute set's sum.
   * @param value Finite number, 0 or larger.
   * @param attributes The point's attribute set.
   */
  add(value: number, attributes?: MetricAttributes): void;
}

/** Histogram that counts its values into buckets in memory. Sends one point every interval. */
export interface Histogram {
  /**
   * Adds a value to an attribute set's buckets.
   * @param value Finite number.
   * @param attributes The point's attribute set.
   */
  record(value: number, attributes?: MetricAttributes): void;
}

/** Handle for one timed operation. */
export interface Measure {
  /**
   * Closes the open phase and starts the next one. Does nothing after `end()`.
   * @param name Phase name. Every name creates its own series.
   */
  phase(name: string): void;
  /**
   * Closes the open phase and records the total. A second call does nothing.
   * @param outcome Result of the operation. `"error"` marks its span as failed. @default "ok"
   */
  end(outcome?: string): void;
}

/** Probe options. */
export interface ProbeOptions {
  /**
   * Record one span out of every `sampleEvery`. An integer from 1 to 2147483647.
   * @default 1
   */
  sampleEvery?: number;
  /**
   * A span that runs longer than this many milliseconds leaves a breadcrumb. Must be a finite
   * number, 0 or more. Unset by default, which means no breadcrumbs.
   */
  slowMs?: number;
  /**
   * Set to true when an `await` splits the probe's spans. Those spans report total time only:
   * they have no self time, and they don't eat into the self time of other spans.
   * @default false
   */
  async?: boolean;
}

/**
 * Times one span of app code. Every member is a function property rather than a method, so you
 * can destructure them and unbound-method lint rules stay quiet.
 */
export interface Probe {
  /**
   * Starts a span.
   * @returns A token to pass to `end()`, or -1 if the profiler isn't measuring this span.
   */
  begin: () => number;
  /**
   * Ends a span.
   * @param token The token `begin()` returned.
   */
  end: (token: number) => void;
  /**
   * Ends a span after the page's next paint, so the duration includes style, layout and paint.
   * Where there is no frame callback, or the page is hidden, the span ends right away.
   * @param token The token `begin()` returned.
   */
  endAfterPaint: (token: number) => void;
  /**
   * Adds a duration you measured some other way.
   * @param durationMs Duration in milliseconds. A finite number, 0 or larger.
   */
  record: (durationMs: number) => void;
}

/** Creates the app's probes. `probe` is a function property, so destructuring it works. */
export interface Profiler {
  /**
   * Returns the probe for a name. The same name always gives the same probe, and only the
   * options from the first call count.
   * @param name Probe name. A non-empty string.
   * @param options Probe options.
   * @returns The probe.
   */
  probe: (name: string, options?: ProbeOptions) => Probe;
  /**
   * Calls a function and times it with the named probe. If the result has a `then` function,
   * the span ends when it settles. Errors from the function go to the caller.
   * @param name Probe name. A non-empty string.
   * @param fn The function to call.
   * @returns Whatever `fn` returned, or the result of its `then` call.
   */
  time: <T>(name: string, fn: () => T) => T;
}

/** Instrument kind. */
export type InstrumentKind = "counter" | "histogram";

/** Instrument definition. A handle passes it to the meter on every call. */
export interface InstrumentDef {
  /** Metric name. */
  name: string;
  /** Instrument kind. */
  kind: InstrumentKind;
  /** Unit of the values. */
  unit: string;
  /** A histogram's bucket boundaries. A counter has none. */
  boundaries: readonly number[];
}

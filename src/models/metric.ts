// src/models/metric.ts
//
// Types of the counter and histogram instruments.

/** Attribute set of a metric point. Keep it small. Each set is one series in the backend. */
export type MetricAttributes = Record<string, string | number | boolean>;

/** Options of an instrument. */
export interface InstrumentOptions {
  /**
   * Unit of the values, for example "ms" or "By".
   * @default "count"
   */
  unit?: string;
}

/** Options of a histogram. */
export interface HistogramOptions extends InstrumentOptions {
  /**
   * Ascending bucket boundaries, at most 50. A value goes into the first bucket whose boundary
   * is equal to or larger than the value.
   * @default [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]
   */
  boundaries?: readonly number[];
}

/** Counter that sums its values in memory. The library sends one point at each interval. */
export interface Counter {
  /**
   * Adds a value to the sum of an attribute set.
   * @param value Finite number, 0 or larger.
   * @param attributes Attribute set of the point.
   */
  add(value: number, attributes?: MetricAttributes): void;
}

/** Histogram that counts its values in buckets in memory. It sends one point at each interval. */
export interface Histogram {
  /**
   * Adds a value to the buckets of an attribute set.
   * @param value Finite number.
   * @param attributes Attribute set of the point.
   */
  record(value: number, attributes?: MetricAttributes): void;
}

/** Handle of one timed operation. */
export interface Measure {
  /**
   * Closes the open phase and starts the next phase. A call after `end()` does nothing.
   * @param name Phase name. Each name makes one series.
   */
  phase(name: string): void;
  /**
   * Closes the open phase and records the total. A second call does nothing.
   * @param outcome Result of the operation. `"error"` marks its span as failed. @default "ok"
   */
  end(outcome?: string): void;
}

/** Options of a probe. */
export interface ProbeOptions {
  /**
   * The probe records one span of each `sampleEvery` spans. It is an integer from 1 to
   * 2147483647.
   * @default 1
   */
  sampleEvery?: number;
}

/**
 * Probe that times one code span of the app. Each member is a function property, not a method.
 * A destructured member then works, and a lint rule for unbound methods accepts it.
 */
export interface Probe {
  /**
   * Starts one span.
   * @returns A token for `end()`, or -1 for a span that the profiler does not measure.
   */
  begin: () => number;
  /**
   * Ends one span.
   * @param token The token that `begin()` returned.
   */
  end: (token: number) => void;
  /**
   * Adds a duration from another source.
   * @param durationMs Duration in milliseconds. It is a finite number, 0 or larger.
   */
  record: (durationMs: number) => void;
}

/** Makes the probes of the app. `probe` is a function property. A destructured `probe` works. */
export interface Profiler {
  /**
   * Gives the probe of a name. The same name gives the same probe. The first options of a
   * name stay.
   * @param name Probe name. It is a string that is not empty.
   * @param options Sampling of the probe.
   * @returns The probe.
   */
  probe: (name: string, options?: ProbeOptions) => Probe;
}

/** Kind of an instrument. */
export type InstrumentKind = "counter" | "histogram";

/** Definition of an instrument. A handle gives it to the meter at each call. */
export interface InstrumentDef {
  /** Metric name. */
  name: string;
  /** Kind of the instrument. */
  kind: InstrumentKind;
  /** Unit of the values. */
  unit: string;
  /** Bucket boundaries of a histogram. A counter has none. */
  boundaries: readonly number[];
}

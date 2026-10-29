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

// src/core/meter.ts
//
// Sums counter and histogram values and keeps the last gauge value in memory. At every interval
// it emits one point per instrument and attribute set, so a thousand adds produce one record.

import {
  ATTR_APP_NAMESPACE,
  ATTR_JOURNEY_ID,
  ATTR_JOURNEY_NAME,
  ATTR_JOURNEY_PARENT_ID,
  ATTR_LOG_SEQ,
  ATTR_LOG_TYPE,
  ATTR_METRIC_OVERFLOW,
  ATTR_PAGE_URL,
  DEFAULT_METRIC_UNIT,
  METRIC_DEFAULT_BOUNDARIES,
  METRIC_KEYS,
} from "../constants";
import type { MetricsOptions } from "../models/config";
import type {
  Counter,
  Gauge,
  Histogram,
  HistogramOptions,
  InstrumentDef,
  InstrumentOptions,
  MetricAttributes,
} from "../models/metric";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";

/** One attribute set's sums in the current interval. */
interface Series {
  /** The series' attribute set. */
  attributes: MetricAttributes;
  /** Number of values. */
  count: number;
  /** Sum of the values. */
  sum: number;
  /** Smallest value. */
  min: number;
  /** Largest value. */
  max: number;
  /** Last value. A gauge sends it. */
  last: number;
  /** Count per histogram bucket. A counter and a gauge have none. */
  buckets: number[];
}

/** One instrument's series in the current interval. */
interface Instrument {
  /** Definition taken from the interval's first value. */
  def: InstrumentDef;
  /** Series by attribute set key. */
  series: Map<string, Series>;
}

/** Key of the overflow series. An attribute set's key is JSON text, which starts with "{". */
const OVERFLOW_KEY = "overflow";

/** Keys the record builder sets. It overwrites a call attribute with the same name. */
const RECORD_KEYS = new Set<string>([
  ATTR_LOG_TYPE,
  ATTR_LOG_SEQ,
  ATTR_APP_NAMESPACE,
  ATTR_PAGE_URL,
  ATTR_JOURNEY_ID,
  ATTR_JOURNEY_NAME,
  ATTR_JOURNEY_PARENT_ID,
]);

/**
 * Keeps the string, finite number and boolean attributes, in key order. Two calls with the same
 * set in a different key order then share one series.
 * @param attributes The call's attribute set.
 * @returns The clean attribute set.
 */
function cleanAttributes(attributes: MetricAttributes = {}): MetricAttributes {
  const clean: MetricAttributes = {};

  for (const key of Object.keys(attributes).sort()) {
    // The builder replaces the metric fields, so keeping one would give every value its own
    // series with the same output. An app's other metric. keys stay reserved for the library.
    if (key.startsWith("metric.") || RECORD_KEYS.has(key)) {
      continue;
    }

    const value: unknown = attributes[key];
    const finite = typeof value === "number" && Number.isFinite(value);
    if (typeof value === "string" || typeof value === "boolean" || finite) {
      clean[key] = value;
    }
  }

  return clean;
}

/**
 * Copies a list of boundaries by index, so a custom iterator on the app's array has no effect.
 * @param bounds Value of the boundaries option.
 * @param limit Maximum number of boundaries. null means no limit.
 * @returns A plain array with at most one value more than the limit, or null if the value
 * isn't an array.
 */
function copyBounds(bounds: unknown, limit: number | null): unknown[] | null {
  if (!Array.isArray(bounds)) {
    return null;
  }

  // One more than the limit, so isAscending rejects a list that is too long.
  const count = limit === null ? bounds.length : Math.min(bounds.length, limit + 1);
  return Array.from({ length: count }, (_unused, i): unknown => bounds[i]);
}

/**
 * Checks a list of histogram boundaries.
 * @param bounds Value of the boundaries option.
 * @param limit Maximum number of boundaries. null means no limit.
 * @returns True for finite numbers in ascending order, no more of them than the limit.
 */
function isAscending(bounds: unknown, limit: number | null): bounds is number[] {
  return (
    Array.isArray(bounds) &&
    (limit === null || bounds.length <= limit) &&
    bounds.every(
      (bound: unknown, i) =>
        typeof bound === "number" &&
        Number.isFinite(bound) &&
        (i === 0 || bound > (bounds[i - 1] as number)),
    )
  );
}

/**
 * Builds the metric fields for one point. The call's attributes stay out.
 * @param def The instrument's definition.
 * @param series The attribute set's sums.
 * @param start Start of the interval, in Unix nanoseconds.
 * @returns The point's metric fields.
 */
function fieldsOf(def: InstrumentDef, series: Series, start: string): Record<string, unknown> {
  const point: Record<string, unknown> = {
    "metric.name": def.name,
    "metric.unit": def.unit,
    "metric.type": def.kind,
    [METRIC_KEYS.start]: start,
    [METRIC_KEYS.attributeKeys]: Object.keys(series.attributes),
  };

  if (def.kind !== "histogram") {
    point["metric.value"] = def.kind === "gauge" ? series.last : series.sum;
    return point;
  }

  return {
    ...point,
    [METRIC_KEYS.count]: series.count,
    [METRIC_KEYS.sum]: series.sum,
    [METRIC_KEYS.min]: series.min,
    [METRIC_KEYS.max]: series.max,
    [METRIC_KEYS.bounds]: def.boundaries,
    [METRIC_KEYS.buckets]: series.buckets,
  };
}

/** Adds a value to one of the runtime's instruments. */
export type RecordMetric = (
  def: InstrumentDef,
  value: number,
  attributes?: MetricAttributes,
) => void;

/** Called with whatever reading an options object threw. */
export type OptionsFault = (error: unknown) => void;

/**
 * Reads an instrument's options. A getter or a Proxy trap on them can throw, and a JavaScript
 * caller can pass null.
 * @param options Options from the app.
 * @param fault Reports options that couldn't be read.
 * @returns The unit and the boundaries. Anything the app didn't set is undefined.
 */
function readOptions(
  options: HistogramOptions,
  fault: OptionsFault,
): { unit: string | undefined; boundaries: readonly number[] | undefined } {
  try {
    return { unit: options.unit, boundaries: options.boundaries };
  } catch (error) {
    fault(error);
    return { unit: undefined, boundaries: undefined };
  }
}

/**
 * Builds the definition of an instrument with one value per point.
 * @param name Metric name.
 * @param kind "counter" or "gauge".
 * @param options Unit for the values.
 * @param fault Reports options that couldn't be read.
 * @returns The definition.
 */
function scalarDef(
  name: string,
  kind: "counter" | "gauge",
  options: InstrumentOptions,
  fault: OptionsFault,
): InstrumentDef {
  return {
    name,
    kind,
    unit: readOptions(options, fault).unit ?? DEFAULT_METRIC_UNIT,
    boundaries: [],
  };
}

/**
 * Creates a counter handle. Never throws into the app.
 * @param name Metric name.
 * @param options Unit for the values.
 * @param record Adds a value to the instrument.
 * @param fault Reports options that couldn't be read.
 * @returns The counter.
 */
export function makeCounter(
  name: string,
  options: InstrumentOptions,
  record: RecordMetric,
  fault: OptionsFault,
): Counter {
  const def = scalarDef(name, "counter", options, fault);

  return {
    add: (value, attributes) => {
      record(def, value, attributes);
    },
  };
}

/**
 * Creates a gauge handle. Never throws into the app.
 * @param name Metric name.
 * @param options Unit for the values.
 * @param record Sets the instrument's value.
 * @param fault Reports options that couldn't be read.
 * @returns The gauge.
 */
export function makeGauge(
  name: string,
  options: InstrumentOptions,
  record: RecordMetric,
  fault: OptionsFault,
): Gauge {
  const def = scalarDef(name, "gauge", options, fault);

  return {
    set: (value, attributes) => {
      record(def, value, attributes);
    },
  };
}

/**
 * Creates a histogram handle. Never throws into the app.
 * @param name Metric name.
 * @param options Unit for the values, and the bucket boundaries.
 * @param record Adds a value to the instrument.
 * @param fault Reports options that couldn't be read.
 * @returns The histogram.
 */
export function makeHistogram(
  name: string,
  options: HistogramOptions,
  record: RecordMetric,
  fault: OptionsFault,
): Histogram {
  const { unit, boundaries } = readOptions(options, fault);
  const def: InstrumentDef = {
    name,
    kind: "histogram",
    unit: unit ?? DEFAULT_METRIC_UNIT,
    boundaries: boundaries ?? METRIC_DEFAULT_BOUNDARIES,
    fromApp: boundaries !== undefined,
  };

  return {
    record: (value, attributes) => {
      record(def, value, attributes);
    },
  };
}

/** Sums the counter and histogram values and keeps the gauge values of one interval. */
export class Meter {
  /** Instruments with a value in the current interval. */
  private readonly instruments = new Map<string, Instrument>();

  /** Timer for the current interval. Runs only while a value is waiting. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Time of the interval's first value, in epoch milliseconds. */
  private startedAt = 0;

  /**
   * @param intervalMs Returns the interval length, in milliseconds.
   * @param emit Builds and sends the record for one point from the call attributes and the
   * metric fields.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly intervalMs: () => number,
    private readonly emit: (
      name: string,
      attributes: MetricAttributes,
      fields: Record<string, unknown>,
    ) => void,
    private readonly diagnostics: Diagnostics,
    private readonly policy: Omit<MetricsOptions, "intervalMs"> = {
      maxSeries: 100,
      maxInstruments: 1000,
      maxHistogramBoundaries: 50,
    },
  ) {}

  /**
   * Adds a value to the series for its attribute set. Never throws into the app.
   * @param def The instrument's definition.
   * @param value Value to add.
   * @param attributes The value's attribute set.
   */
  record(def: InstrumentDef, value: number, attributes?: MetricAttributes): void {
    // NaN and Infinity become null in JSON, and a negative add breaks a counter's sum.
    if (!Number.isFinite(value) || (def.kind === "counter" && value < 0)) {
      this.diagnostics.report(
        "record.dropped_malformed",
        `The value of the metric ${def.name} is not valid. The library dropped it.`,
        { "metric.name": def.name },
      );
      return;
    }

    // A getter or a Proxy trap on the attributes can throw.
    this.diagnostics.guard(
      "record.sanitize_failed",
      `The library could not read the attributes of the metric ${def.name}.`,
      () => {
        const instrument = this.instrumentOf(def);
        if (instrument) {
          this.add(instrument, value, cleanAttributes(attributes));
          this.arm();
        }
      },
    );
  }

  /** Sends one point per series in the interval, then starts a new interval. */
  collect(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const start = `${String(this.startedAt)}000000`;
    const instruments = [...this.instruments.values()];
    this.instruments.clear();

    for (const { def, series } of instruments) {
      for (const one of series.values()) {
        this.emit(def.name, one.attributes, fieldsOf(def, one, start));
      }
    }
  }

  /**
   * Finds the interval's instrument. The first value of the interval sets its definition.
   * @param def The call's definition.
   * @returns The instrument, or null when the name has another kind.
   */
  private instrumentOf(def: InstrumentDef): Instrument | null {
    const found = this.instruments.get(def.name);

    if (found) {
      if (found.def.kind === def.kind) {
        return found;
      }

      this.diagnostics.report(
        "record.dropped_malformed",
        `The metric ${def.name} is a ${found.def.kind} and a ${def.kind}. The library dropped the value.`,
        { "metric.name": def.name },
      );
      return null;
    }

    const { maxInstruments } = this.policy;
    if (maxInstruments !== null && this.instruments.size >= maxInstruments) {
      this.diagnostics.count("record.dropped_by_ceiling");
      return null;
    }
    // Copy before the check, so a later change to the app's array can't change the buckets. The
    // limit is for the app's lists. The library's own lists always fit, or a low limit would
    // report every histogram without custom boundaries.
    const limit = def.fromApp === true ? this.policy.maxHistogramBoundaries : null;
    const copy = copyBounds(def.boundaries, limit);
    const valid = isAscending(copy, limit);
    if (def.kind === "histogram" && !valid) {
      this.diagnostics.report(
        "config.invalid",
        `The boundaries of the metric ${def.name} must meet metrics.maxHistogramBoundaries and contain finite numbers in ascending order. The library uses the default boundaries.`,
      );
    }

    const instrument: Instrument = {
      def: { ...def, boundaries: valid ? copy : [...METRIC_DEFAULT_BOUNDARIES] },
      series: new Map(),
    };
    this.instruments.set(def.name, instrument);
    return instrument;
  }

  /**
   * Adds a value to an attribute set's series.
   * @param instrument The value's instrument.
   * @param value Value to add.
   * @param attributes Clean attribute set.
   */
  private add(instrument: Instrument, value: number, attributes: MetricAttributes): void {
    let key = JSON.stringify(attributes);
    let series = instrument.series.get(key);
    let set = attributes;

    // Cap the series, or a storm of attribute sets grows memory and the payload without limit.
    const { maxSeries } = this.policy;
    if (!series && maxSeries !== null && instrument.series.size >= maxSeries) {
      key = OVERFLOW_KEY;
      series = instrument.series.get(key);
      set = { [ATTR_METRIC_OVERFLOW]: true };
    }

    if (!series) {
      // A histogram has one more bucket than it has boundaries. The last has no upper bound.
      const size = instrument.def.kind === "histogram" ? instrument.def.boundaries.length + 1 : 0;
      const buckets = new Array<number>(size).fill(0);
      series = { attributes: set, count: 0, sum: 0, min: value, max: value, last: value, buckets };
      instrument.series.set(key, series);
    }

    series.count += 1;
    series.sum += value;
    series.min = Math.min(series.min, value);
    series.max = Math.max(series.max, value);
    series.last = value;

    if (series.buckets.length > 0) {
      const index = instrument.def.boundaries.findIndex((bound) => value <= bound);
      series.buckets[index === -1 ? series.buckets.length - 1 : index] += 1;
    }
  }

  /** Starts the interval's timer on its first value. An idle meter has no timer. */
  private arm(): void {
    if (this.timer !== null) {
      return;
    }

    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.collect();
    }, this.intervalMs());
    unrefTimer(this.timer);
  }
}

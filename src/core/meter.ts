// src/core/meter.ts
//
// This module sums counter and histogram values in memory. At each interval, it gives one point
// for each instrument and attribute set. A thousand adds then give one record, not a thousand.

import {
  ATTR_METRIC_OVERFLOW,
  METRIC_DEFAULT_BOUNDARIES,
  METRIC_KEYS,
  METRIC_MAX_BOUNDARIES,
  METRIC_MAX_SERIES,
} from "../constants";
import type { InstrumentDef, MetricAttributes } from "../models/metric";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";

/** Sums of one attribute set in the current interval. */
interface Series {
  /** Attribute set of the series. */
  attributes: MetricAttributes;
  /** Number of values. */
  count: number;
  /** Sum of the values. */
  sum: number;
  /** Smallest value. */
  min: number;
  /** Largest value. */
  max: number;
  /** Count of each histogram bucket. A counter has none. */
  buckets: number[];
}

/** Series of one instrument in the current interval. */
interface Instrument {
  /** Definition from the first value of the interval. */
  def: InstrumentDef;
  /** Series by attribute set key. */
  series: Map<string, Series>;
}

/** Key of the overflow series. The key of an attribute set is JSON text. It starts with "{". */
const OVERFLOW_KEY = "overflow";

/**
 * Keeps the string, finite number and boolean attributes in key order. Two calls with one set in
 * another key order then share one series.
 * @param attributes Attribute set of the call.
 * @returns The clean attribute set.
 */
function cleanAttributes(attributes: MetricAttributes = {}): MetricAttributes {
  const clean: MetricAttributes = {};

  for (const key of Object.keys(attributes).sort()) {
    const value: unknown = attributes[key];
    const finite = typeof value === "number" && Number.isFinite(value);
    if (typeof value === "string" || typeof value === "boolean" || finite) {
      clean[key] = value;
    }
  }

  return clean;
}

/**
 * Tests a list of histogram boundaries.
 * @param bounds Value of the boundaries option.
 * @returns True for at most 50 finite numbers in ascending order.
 */
function isAscending(bounds: unknown): boolean {
  return (
    Array.isArray(bounds) &&
    bounds.length <= METRIC_MAX_BOUNDARIES &&
    bounds.every(
      (bound: unknown, i) =>
        typeof bound === "number" &&
        Number.isFinite(bound) &&
        (i === 0 || bound > (bounds[i - 1] as number)),
    )
  );
}

/**
 * Builds the attributes of one point.
 * @param def Definition of the instrument.
 * @param series Sums of the attribute set.
 * @param start Start of the interval, in Unix nanoseconds.
 * @returns The point attributes. The metric fields win over a key of the same name.
 */
function pointOf(def: InstrumentDef, series: Series, start: string): Record<string, unknown> {
  const point: Record<string, unknown> = {
    ...series.attributes,
    "metric.name": def.name,
    "metric.unit": def.unit,
    "metric.type": def.kind,
    [METRIC_KEYS.start]: start,
    [METRIC_KEYS.attributeKeys]: Object.keys(series.attributes),
  };

  if (def.kind === "counter") {
    point["metric.value"] = series.sum;
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

/** Sums the values of the counter and histogram instruments for one interval. */
export class Meter {
  /** Instruments with a value in the current interval. */
  private readonly instruments = new Map<string, Instrument>();

  /** Timer of the current interval. It runs only while a value waits. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Time of the first value of the interval, in epoch milliseconds. */
  private startedAt = 0;

  /**
   * @param intervalMs Gives the interval length, in milliseconds.
   * @param emit Builds and sends the record of one point.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly intervalMs: () => number,
    private readonly emit: (name: string, point: Record<string, unknown>) => void,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Adds a value to the series of its attribute set. It never throws into the call of the app.
   * @param def Definition of the instrument.
   * @param value Value to add.
   * @param attributes Attribute set of the value.
   */
  record(def: InstrumentDef, value: number, attributes?: MetricAttributes): void {
    // NaN and Infinity become null in JSON. A negative add breaks the sum of a counter.
    if (!Number.isFinite(value) || (def.kind === "counter" && value < 0)) {
      this.diagnostics.report(
        "record.dropped_malformed",
        `The value of the metric ${def.name} is not valid. The library dropped it.`,
        { "metric.name": def.name },
      );
      return;
    }

    // A getter or a Proxy trap of the attributes can throw.
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

  /** Sends one point for each series of the interval. It then starts a new interval. */
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
        this.emit(def.name, pointOf(def, one, start));
      }
    }
  }

  /**
   * Finds the instrument of the interval. The first value of the interval sets its definition.
   * @param def Definition of the call.
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
        `The metric ${def.name} is a counter and a histogram. The library dropped the value.`,
        { "metric.name": def.name },
      );
      return null;
    }

    let boundaries = def.boundaries;
    if (def.kind === "histogram" && !isAscending(boundaries)) {
      this.diagnostics.report(
        "config.invalid",
        `The boundaries of the metric ${def.name} must be at most 50 finite numbers in ascending order. The library uses the default boundaries.`,
      );
      boundaries = METRIC_DEFAULT_BOUNDARIES;
    }

    // Copy the boundaries. A later change of the array of the app must not change the buckets.
    const instrument: Instrument = {
      def: { ...def, boundaries: [...boundaries] },
      series: new Map(),
    };
    this.instruments.set(def.name, instrument);
    return instrument;
  }

  /**
   * Adds a value to the series of an attribute set.
   * @param instrument Instrument of the value.
   * @param value Value to add.
   * @param attributes Clean attribute set.
   */
  private add(instrument: Instrument, value: number, attributes: MetricAttributes): void {
    let key = JSON.stringify(attributes);
    let series = instrument.series.get(key);
    let set = attributes;

    // A storm of attribute sets cannot grow the memory and the payload without a limit.
    if (!series && instrument.series.size >= METRIC_MAX_SERIES) {
      key = OVERFLOW_KEY;
      series = instrument.series.get(key);
      set = { [ATTR_METRIC_OVERFLOW]: true };
    }

    if (!series) {
      // A histogram has one bucket more than boundaries. The last bucket has no upper bound.
      const size = instrument.def.kind === "histogram" ? instrument.def.boundaries.length + 1 : 0;
      const buckets = new Array<number>(size).fill(0);
      series = { attributes: set, count: 0, sum: 0, min: value, max: value, buckets };
      instrument.series.set(key, series);
    }

    series.count += 1;
    series.sum += value;
    series.min = Math.min(series.min, value);
    series.max = Math.max(series.max, value);

    if (series.buckets.length > 0) {
      const index = instrument.def.boundaries.findIndex((bound) => value <= bound);
      series.buckets[index === -1 ? series.buckets.length - 1 : index] += 1;
    }
  }

  /** Starts the timer of the interval at its first value. An idle meter has no timer. */
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

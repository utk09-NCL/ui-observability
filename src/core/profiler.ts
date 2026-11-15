// src/core/profiler.ts
//
// This module times code spans of the app with probes. It sums the durations in typed arrays.
// At each interval, it gives one histogram summary record for each probe with data.

import {
  METRIC_KEYS,
  PROFILE_BUCKETS,
  PROFILE_KEYS,
  PROFILE_METRIC_NAME,
  PROFILER_CALIBRATION_MS,
  PROFILER_CALIBRATION_PAIRS,
  PROFILER_GLOBAL_KEY,
  PROFILER_PROBE_LIMIT,
  TELEMETRY_SDK_VERSION,
} from "../constants";
import type { MetricAttributes, Probe, ProbeOptions, Profiler } from "../models/metric";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";
import { bucketOf, percentileOf, pointBuckets } from "./profile-buckets";

/** Values in one stats row. */
const STATS_WIDTH = 4;

/** Offset of the value count in a stats row. */
const COUNT = 0;

/** Offset of the sum in a stats row, in milliseconds. */
const SUM = 1;

/** Offset of the smallest value in a stats row, in milliseconds. */
const MIN = 2;

/** Offset of the largest value in a stats row, in milliseconds. */
const MAX = 3;

/** Values in one sampling row. The countdown is at offset 0 and the period at offset 1. */
const SAMPLING_WIDTH = 2;

/** Largest sampling period. The period is an Int32Array value. */
const MAX_PERIOD = 2 ** 31 - 1;

/** Global symbol of the core of this library version. */
const CORE_KEY = Symbol.for(`${PROFILER_GLOBAL_KEY}@${TELEMETRY_SDK_VERSION}`);

/** Probe of a name that the profiler refuses. It reads no clock. */
const NOOP_PROBE: Probe = {
  begin: () => -1,
  end: () => undefined,
  record: () => undefined,
};

/** Services that the runtime gives to the core at attach. */
export interface ProfilerSink {
  /** Maximum probes. It is profiler.maxProbes. */
  capacity: number;
  /** Gives the interval length, in milliseconds. */
  intervalMs(): number;
  /**
   * Builds and sends the record of one point.
   * @param name Metric name.
   * @param attributes Record attributes of the point.
   * @param fields Metric fields of the point.
   */
  emit(name: string, attributes: MetricAttributes, fields: Record<string, unknown>): void;
  /** Diagnostics reporter of the runtime. */
  diagnostics: Diagnostics;
  /** Returns false while the runtime cannot accept a record. */
  ready(): boolean;
}

/** One registered probe. */
interface ProbeEntry {
  /** Handle of the probe. Each call with the same name gives this handle. */
  probe: Probe;
  /** Row of the probe in the typed arrays. It is the registration index plus 1. */
  slot: number;
  /** Sampling period from the first options of the name. */
  period: number;
}

/** Keeps the probe names and the durations of all probes. One library version has one core. */
export class ProfilerCore implements Profiler {
  /** Probes by name. The core never removes a name, so the insertion order is the slot order. */
  private readonly registry = new Map<string, ProbeEntry>();

  /** Rows in use. It is 0 while detached. One compare then covers "off" and "above the limit". */
  private limit = 0;

  // Each typed array starts empty, never null. The hypothesis, not measured, is that one fixed
  // field type keeps the V8 inline caches of the hot path monomorphic.

  /**
   * Count, sum, min and max of each slot. The 4 values of one row are 32 adjacent bytes. The
   * hypothesis, not measured, is that one add then touches one cache line.
   */
  private stats = new Float64Array(0);

  /** Bucket counts of each slot. Each slot has PROFILE_BUCKETS values. */
  private hist = new Uint32Array(0);

  /** Countdown and period of each slot. */
  private sampling = new Int32Array(0);

  /**
   * Clock value of the last detach() or reset(). The core drops a span that starts at or before
   * it. A coarse clock gives the same value to a span that starts in the tick of the reset.
   */
  private floor = -1;

  /** Timer of the current interval. It runs only while a value waits. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Time of the first value of the interval, in epoch milliseconds. */
  private startedAt = 0;

  /** Tokens that are not valid, while on, since the last collect(). end() reports nothing. */
  private badTokens = 0;

  /** Cost of one sampled begin() and end() pair, in nanoseconds. */
  private overhead: number | undefined = undefined;

  /** True after the one calibration run. A clock that is too coarse then blocks one time only. */
  private calibrated = false;

  /** Sink of the runtime. It is null while detached. */
  private sink: ProfilerSink | null = null;

  /** True after the report of a probe above the limit in this attach. */
  private reported = false;

  /** True while a limit report that the throttle dropped waits for a collect. */
  private limitDue = false;

  /**
   * Gives the probe of a name. It never throws into the call of the app.
   * @param name Probe name. A JavaScript caller can pass another type.
   * @param options Sampling of the probe. The first options of a name stay.
   * @param diagnostics Diagnostics of the current runtime. Without a runtime, the call reports
   * nothing.
   * @returns The probe, or a probe that does nothing for a name that the core refuses.
   */
  probe(name: string, options?: ProbeOptions, diagnostics?: Diagnostics): Probe {
    // The check reads only the type. String() can run a hostile toString().
    if (typeof name !== "string" || name === "") {
      diagnostics?.report(
        "config.invalid",
        "The probe name must be a string that is not empty. The probe does nothing.",
      );
      return NOOP_PROBE;
    }

    const known = this.registry.get(name);
    if (known) {
      return known.probe;
    }

    if (this.registry.size >= PROFILER_PROBE_LIMIT) {
      diagnostics?.report(
        "config.invalid",
        `The profiler keeps at most ${String(PROFILER_PROBE_LIMIT)} probe names. The probe ${name} does nothing.`,
      );
      return NOOP_PROBE;
    }

    const period = this.periodOf(name, options, diagnostics);

    // A getter of the options can register probes. Without the checks, two names share a slot.
    if (this.registry.has(name) || this.registry.size >= PROFILER_PROBE_LIMIT) {
      return this.probe(name, undefined, diagnostics);
    }

    const slot = this.registry.size + 1;
    const probe = this.makeProbe(name, slot);
    this.registry.set(name, { probe, slot, period });

    if (slot < this.limit) {
      this.prime(slot, period);
    } else if (this.limit > 0 && !this.reported) {
      this.reported = true;
      // The limit belongs to the attached runtime. A call with no diagnostics still reports it.
      const sent = this.sink?.diagnostics.report(
        "config.invalid",
        `The probe ${name} is above the profiler.maxProbes limit of ${String(this.limit - 1)}. The probe does nothing.`,
      );

      if (sent === false) {
        this.limitDue = true;
      }
    }

    return probe;
  }

  /**
   * Turns the profiler on with the sink of a runtime. A second call replaces the sink.
   * @param sink Sink of the runtime.
   */
  attach(sink: ProfilerSink): void {
    const limit = sink.capacity + 1;
    this.sink = sink;

    // A second attach with the same capacity keeps the data.
    if (this.stats.length !== limit * STATS_WIDTH) {
      this.stats = new Float64Array(limit * STATS_WIDTH);
      this.hist = new Uint32Array(limit * PROFILE_BUCKETS);
      this.sampling = new Int32Array(limit * SAMPLING_WIDTH);
    }

    this.limit = limit;
    this.reported = false;
    this.limitDue = false;
    this.prime(0, 1);
    for (const entry of this.registry.values()) {
      if (entry.slot < limit) {
        this.prime(entry.slot, entry.period);
      }
    }

    if (this.registry.size > sink.capacity) {
      this.reported = true;
      this.reportLimit(sink);
    }
  }

  /** Turns the profiler off and drops the data. The runtime calls collect(false) before it. */
  detach(): void {
    this.limit = 0;
    this.sink = null;
    this.clearTimer();
    this.floor = performance.now();
    this.stats.fill(0);
    this.hist.fill(0);
  }

  /**
   * Sends one summary record for each probe with data. It then starts a new interval. It does
   * nothing while the sink is not ready.
   * @param timed True when the interval timer calls it. Only a timed collect calibrates.
   */
  collect(timed: boolean): void {
    const { sink } = this;

    // A runtime that is not ready refuses the record. The data and the timer stay for a later
    // collect. Without the check, the collect zeroes the slots and the points are lost.
    if (!sink?.ready()) {
      return;
    }

    // The throttle of diagnostics dropped the limit report of this attach.
    // Without a new report, the app gets no message about probes that do nothing.
    if (this.limitDue) {
      this.reportLimit(sink);
    }

    this.clearTimer();

    // The calibration blocks the thread for 2 to 3 ms, and longer on a clock that is too coarse.
    // flush() and the exit path must not wait.
    if (timed && !this.calibrated && this.hasData()) {
      this.calibrate();
    }

    const start = `${String(this.startedAt)}000000`;
    for (const [name, entry] of this.registry) {
      // A probe above the limit has no row. After a detach() inside an emit, no probe has one.
      if (entry.slot < this.limit && this.stats[entry.slot * STATS_WIDTH + COUNT] > 0) {
        this.emitSlot(sink, name, entry, start);
      }
    }

    if (this.badTokens > 0) {
      sink.diagnostics.count("record.dropped_malformed", this.badTokens);
      this.badTokens = 0;
    }
  }

  /** Drops the data of the interval. The profiler stays on. */
  reset(): void {
    this.clearTimer();
    this.floor = performance.now();
    this.badTokens = 0;
    this.stats.fill(0);
    this.hist.fill(0);
  }

  /**
   * Reads the sampling period of a new probe. It never throws into the call of the app.
   * @param name Probe name.
   * @param options Options of the app.
   * @param diagnostics Diagnostics of the current runtime, if one exists.
   * @returns The period, or 1 for options that are not valid.
   */
  private periodOf(
    name: string,
    options: ProbeOptions | undefined,
    diagnostics: Diagnostics | undefined,
  ): number {
    let value: unknown;

    // A getter or a Proxy trap of the options can throw.
    try {
      value = options?.sampleEvery;
    } catch (error) {
      diagnostics?.report(
        "config.invalid",
        `The library could not read the sampleEvery option of the probe ${name}. The library uses 1.`,
        undefined,
        error,
      );
      return 1;
    }

    if (value === undefined) {
      return 1;
    }

    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PERIOD) {
      return value;
    }

    diagnostics?.report(
      "config.invalid",
      `The sampleEvery option of the probe ${name} must be an integer from 1 to ${String(MAX_PERIOD)}. The library uses 1.`,
    );
    return 1;
  }

  /**
   * Makes the closures of one probe, one time for each probe. A destructured member then works.
   * @param name Probe name.
   * @param slot Row of the probe.
   * @returns The probe.
   */
  private makeProbe(name: string, slot: number): Probe {
    return {
      begin: () => {
        // The probe is off, above the limit or sampled out. It then reads no clock.
        if (slot >= this.limit || !this.sampled(slot)) {
          return -1;
        }

        return performance.now();
      },
      end: (token) => {
        // The compare runs only after the type check. A hostile valueOf() then never runs.
        const now = typeof token === "number" && token >= 0 ? performance.now() : -1;
        if (now < 0) {
          // A token of -1 is a span that begin() did not measure. A bad token counts only while on.
          if (token !== -1 && slot < this.limit) {
            this.badTokens++;
          }
          return;
        }

        // Drop the span while off, or when it started at or before a detach() or a reset().
        if (slot >= this.limit || token <= this.floor) {
          return;
        }

        this.add(slot, now - token);
      },
      record: (durationMs) => {
        if (slot >= this.limit) {
          return;
        }

        if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
          this.sink?.diagnostics.report(
            "record.dropped_malformed",
            `The duration of the probe ${name} is not valid. The library dropped it.`,
            { [PROFILE_KEYS.probe]: name },
          );
          return;
        }

        if (this.sampled(slot)) {
          this.add(slot, durationMs);
        }
      },
    };
  }

  /**
   * Writes the sampling row of a slot. The profiler then measures the next span.
   * @param slot Row of the probe.
   * @param period Sampling period.
   */
  private prime(slot: number, period: number): void {
    const at = slot * SAMPLING_WIDTH;
    this.sampling[at] = 1;
    this.sampling[at + 1] = period;
  }

  /**
   * Counts down the sampling of a slot. A countdown, not Math.random(), gives an exact rate.
   * @param slot Row of the probe.
   * @returns True for a span that the profiler measures.
   */
  private sampled(slot: number): boolean {
    const at = slot * SAMPLING_WIDTH;
    const left = this.sampling[at] - 1;

    if (left > 0) {
      this.sampling[at] = left;
      return false;
    }

    this.sampling[at] = this.sampling[at + 1];
    return true;
  }

  /**
   * Adds one duration to a slot. The hot path calls it. It has no Map lookup and no try.
   * @param slot Row of the probe.
   * @param ms Duration in milliseconds.
   */
  private add(slot: number, ms: number): void {
    // A forged token gives a negative duration. A bad clock gives NaN or Infinity.
    if (!(ms >= 0) || ms === Infinity) {
      this.badTokens++;
      return;
    }

    const { stats } = this;
    const row = slot * STATS_WIDTH;
    const count = stats[row + COUNT];
    stats[row + COUNT] = count + 1;
    stats[row + SUM] += ms;

    if (count === 0 || ms < stats[row + MIN]) {
      stats[row + MIN] = ms;
    }

    if (count === 0 || ms > stats[row + MAX]) {
      stats[row + MAX] = ms;
    }

    // A bucket includes its upper bound. Without the round up, a value goes one bucket too low.
    this.hist[slot * PROFILE_BUCKETS + bucketOf(Math.ceil(ms * 1000))]++;

    // Slot 0 is the calibration slot. The calibration must not start an interval.
    if (this.timer === null && slot > 0 && this.sink !== null) {
      this.startedAt = Date.now();
      this.wait(this.sink);
    }
  }

  /**
   * Starts the unreferenced interval timer. A pending timer then does not keep Node.js alive.
   * @param sink Sink of the runtime.
   */
  private wait(sink: ProfilerSink): void {
    this.timer = setTimeout(() => {
      this.tick();
    }, sink.intervalMs());
    unrefTimer(this.timer);
  }

  /** Collects at the end of an interval. While the runtime is not ready, it waits again. */
  private tick(): void {
    const { sink } = this;

    if (sink !== null && !sink.ready()) {
      this.wait(sink);
      return;
    }

    this.collect(true);
  }

  /** Stops the interval timer. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reports that the registry has more probes than the limit.
   * A report that the throttle drops waits for the next collect.
   * @param sink Sink of the runtime.
   */
  private reportLimit(sink: ProfilerSink): void {
    // Clear the flag first. A handler that collects must not start a second report.
    this.limitDue = false;
    const sent = sink.diagnostics.report(
      "config.invalid",
      `The app registered ${String(this.registry.size)} probes. The profiler.maxProbes limit is ${String(sink.capacity)}. The probes above the limit do nothing.`,
    );

    if (!sent) {
      this.limitDue = true;
    }
  }

  /**
   * Tests if a probe has a value in this interval.
   * @returns True when the count of a slot above 0 is not 0.
   */
  private hasData(): boolean {
    for (let slot = 1; slot < this.limit; slot++) {
      if (this.stats[slot * STATS_WIDTH + COUNT] > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Sends the summary record of one slot and zeroes the slot. The countdown stays.
   * @param sink Sink of the runtime.
   * @param name Probe name.
   * @param entry Registry entry of the probe.
   * @param start Start of the interval, in Unix nanoseconds.
   */
  private emitSlot(sink: ProfilerSink, name: string, entry: ProbeEntry, start: string): void {
    const { stats, hist } = this;
    const row = entry.slot * STATS_WIDTH;
    const base = entry.slot * PROFILE_BUCKETS;
    const count = stats[row + COUNT];
    const min = stats[row + MIN];
    const max = stats[row + MAX];

    // A bucket bound can be above the exact max. The clamp keeps each percentile from min to max.
    const quantile = (q: number): number =>
      Math.min(Math.max(percentileOf(hist, base, count, q) / 1000, min), max);

    const attributes: MetricAttributes = {
      [PROFILE_KEYS.probe]: name,
      [PROFILE_KEYS.sampleEvery]: entry.period,
      [PROFILE_KEYS.p50]: quantile(0.5),
      [PROFILE_KEYS.p90]: quantile(0.9),
      [PROFILE_KEYS.p99]: quantile(0.99),
    };
    if (this.overhead !== undefined) {
      attributes[PROFILE_KEYS.overhead] = this.overhead;
    }

    const { bounds, counts } = pointBuckets(hist, base);
    const fields: Record<string, unknown> = {
      "metric.name": PROFILE_METRIC_NAME,
      "metric.unit": "ms",
      "metric.type": "histogram",
      [METRIC_KEYS.start]: start,
      [METRIC_KEYS.attributeKeys]: [PROFILE_KEYS.probe, PROFILE_KEYS.sampleEvery],
      [METRIC_KEYS.count]: count,
      [METRIC_KEYS.sum]: stats[row + SUM],
      [METRIC_KEYS.min]: min,
      [METRIC_KEYS.max]: max,
      [METRIC_KEYS.bounds]: bounds,
      [METRIC_KEYS.buckets]: counts,
    };

    // Zero before the emit. A processor of the app can call end() inside the emit.
    stats.fill(0, row, row + STATS_WIDTH);
    hist.fill(0, base, base + PROFILE_BUCKETS);
    sink.emit(PROFILE_METRIC_NAME, attributes, fields);
  }

  /**
   * Measures the cost of one sampled begin() and end() pair on slot 0. It runs one time. A run
   * with no clock edge or no clock tick sets no value.
   */
  private calibrate(): void {
    this.calibrated = true;
    const probe = this.makeProbe("", 0);

    // A browser rounds performance.now() to 5 us, 100 us or 1 ms. The window runs from clock edge
    // to clock edge, because a window that is not on an edge has an error of up to one tick.
    const first = performance.now();
    let edge = first;
    for (let reads = 0; reads < PROFILER_CALIBRATION_PAIRS && edge === first; reads++) {
      edge = performance.now();
    }

    // No edge in the read limit. The clock is frozen or too coarse. A window with no start edge
    // gives a value that is too large.
    if (edge === first) {
      return;
    }

    // The token of begin() is the clock reading. The loop then adds no third clock read.
    const until = edge + PROFILER_CALIBRATION_MS;
    let tick = edge;
    let pairsAtTick = 0;
    for (let pairs = 0; pairs < PROFILER_CALIBRATION_PAIRS; pairs++) {
      const token = probe.begin();
      probe.end(token);

      if (token !== tick) {
        tick = token;
        pairsAtTick = pairs;

        if (token >= until) {
          break;
        }
      }
    }

    // Whole nanoseconds. The hypothesis is that the noise of one 2 ms run is above 1 ns.
    if (pairsAtTick > 0) {
      this.overhead = Math.round(((tick - edge) * 1e6) / pairsAtTick);
    }
  }
}

/**
 * Returns the profiler core of this library version. Two copies of one version share it.
 * @returns The core.
 */
export function profilerCore(): ProfilerCore {
  // Each copy has its own class. The cast is structural, because instanceof fails for a copy.
  const store = globalThis as Record<symbol, unknown>;
  const pinned = store[CORE_KEY] as ProfilerCore | undefined;
  if (pinned) {
    return pinned;
  }

  const core = new ProfilerCore();
  store[CORE_KEY] = core;
  return core;
}

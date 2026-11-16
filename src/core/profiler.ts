// src/core/profiler.ts
//
// Times spans of app code with probes. Durations accumulate in typed arrays, and once per
// interval every probe that saw data is flushed as one histogram summary record.

import {
  METRIC_KEYS,
  PROFILE_BUCKETS,
  PROFILE_KEYS,
  PROFILE_METRIC_NAME,
  PROFILER_CALIBRATION_MS,
  PROFILER_CALIBRATION_PAIRS,
  PROFILER_GLOBAL_KEY,
  PROFILER_PROBE_LIMIT,
  PROFILER_RING_SPANS,
  PROFILER_STACK_DEPTH,
  TELEMETRY_SDK_VERSION,
} from "../constants";
import type { MetricAttributes, Probe, ProbeOptions, Profiler } from "../models/metric";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";
import { bucketOf, percentileOf, pointBuckets } from "./profile-buckets";

/** One stats row is [count, sum, min, max]. Sum, min and max are in ms. */
const STATS_WIDTH = 4;
const COUNT = 0;
const SUM = 1;
const MIN = 2;
const MAX = 3;

/** One sampling row is [countdown, period]. */
const SAMPLING_WIDTH = 2;

/** The period lives in an Int32Array, so this is as large as it gets. */
const MAX_PERIOD = 2 ** 31 - 1;

/** One span-stack frame is [start, child time, slot]. */
const FRAME_WIDTH = 3;

/** One entry in the recent-span ring is [slot, start, end]. */
const SPAN_WIDTH = 3;

/** Global key for the core, one per library version. */
const CORE_KEY = Symbol.for(`${PROFILER_GLOBAL_KEY}@${TELEMETRY_SDK_VERSION}`);

/** Handed out for names we reject. Never reads the clock. */
const NOOP_PROBE: Probe = {
  begin: () => -1,
  end: () => undefined,
  endAfterPaint: () => undefined,
  record: () => undefined,
};

/** Ends a span that was waiting on a paint or a promise. */
type Settle = (token: number, now: number) => void;

/** The page globals the paint wait needs. Workers and Node.js have none of them. */
interface PaintScope {
  requestAnimationFrame?: (callback: () => void) => unknown;
  document?: {
    /** "hidden" while the page isn't painting. */
    visibilityState?: string;
    addEventListener: (type: string, listener: () => void) => void;
  };
}

/** What the runtime hands the core on attach. */
export interface ProfilerSink {
  /** Max number of probes (profiler.maxProbes). */
  capacity: number;
  /** Interval length in ms. */
  intervalMs(): number;
  /**
   * Builds and sends the record for one point.
   * @param name Metric name.
   * @param attributes Record attributes for the point.
   * @param fields Metric fields for the point.
   */
  emit(name: string, attributes: MetricAttributes, fields: Record<string, unknown>): void;
  /** The runtime's diagnostics reporter. */
  diagnostics: Diagnostics;
  /** False while the runtime can't accept records. */
  ready(): boolean;
  /**
   * Leaves a breadcrumb for a span that ran longer than its probe's threshold.
   * @param name Probe name.
   * @param ms Span duration in ms.
   */
  outlier(name: string, ms: number): void;
}

/** Probe options after validation. */
interface ProbeRules {
  /** Measure one span in every `period`. */
  period: number;
  /** Spans longer than this (ms) leave a breadcrumb. Infinity means never. */
  threshold: number;
  /** True for async probes, whose spans stay off the span stack. */
  loose: boolean;
}

/** A registered probe. */
interface ProbeEntry {
  /** The handle. Every probe() call with the same name returns this one. */
  probe: Probe;
  /** The probe's row in the typed arrays: registration index + 1. */
  slot: number;
  /** Sampling period, from the options passed the first time the name was seen. */
  period: number;
  /** Ends one of this probe's spans that isn't on the span stack. */
  settle: Settle;
  /** Pops a span off the stack without ending it. It ends later. */
  leave: (token: number) => void;
}

/** Holds the probe names and all their timings. There is one core per library version. */
export class ProfilerCore implements Profiler {
  /** Probes by name. Names are never removed, so insertion order is slot order. */
  private readonly registry = new Map<string, ProbeEntry>();

  /** Rows in use. 0 while detached, so one compare covers both "off" and "over the limit". */
  private limit = 0;

  // The typed arrays start empty rather than null. Hypothesis (not measured): a single field
  // type keeps V8's inline caches on the hot path monomorphic.

  /**
   * Count, sum, min and max per slot. A row's four values sit in 32 adjacent bytes, so an add
   * should touch a single cache line (hypothesis, not measured).
   */
  private stats = new Float64Array(0);

  /** Bucket counts, PROFILE_BUCKETS per slot. */
  private hist = new Uint32Array(0);

  /** Self-time bucket counts per slot. Spans without a stack frame don't add to it. */
  private selfHist = new Uint32Array(0);

  /** Frames for the open, nested spans. Each frame adds up the time of the spans inside it. */
  private readonly stack = new Float64Array(PROFILER_STACK_DEPTH * FRAME_WIDTH);

  /** Number of frames in use. */
  private depth = 0;

  /** Recent spans, for linking to long animation frames. Empty until link() turns it on. */
  private ring = new Float64Array(0);

  /** Next write offset in the ring. */
  private ringAt = 0;

  /** Shortest span (ms) that goes into the ring. Infinity keeps the ring off. */
  private linkMs = Infinity;

  /** Spans waiting for the next paint. */
  private painted: ((now: number) => void)[] = [];

  /** Gets us a task right after the paint. Created on the first wait. */
  private channel: MessageChannel | undefined;

  /** Countdown and period per slot. */
  private sampling = new Int32Array(0);

  /**
   * Clock value at the last detach() or reset(). Spans that started at or before it are dropped.
   * "At" matters: on a coarse clock, a span started in the reset's tick reads the same value.
   */
  private floor = -1;

  /** Timer for the current interval. It only runs while there is data waiting. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** When the interval's first value arrived, in epoch ms. */
  private startedAt = 0;

  /** Invalid tokens seen while on, since the last collect(). end() itself reports nothing. */
  private badTokens = 0;

  /** Cost of one sampled begin()/end() pair, in ns. */
  private overhead: number | undefined = undefined;

  /** Set once calibration has run, so a too-coarse clock only blocks us once. */
  private calibrated = false;

  /** The runtime's sink. Null while detached. */
  private sink: ProfilerSink | null = null;

  /** True once this attach has reported a probe over the limit. */
  private reported = false;

  /** True while a limit report the throttle dropped is waiting for the next collect. */
  private limitDue = false;

  /**
   * Returns the probe for a name. Never throws into the app.
   * @param name Probe name. A JavaScript caller can pass anything.
   * @param options Probe options. Only the options from the first call for a name count.
   * @param diagnostics The current runtime's diagnostics. Without a runtime, nothing is reported.
   * @returns The probe, or a no-op probe if the name is rejected.
   */
  probe(name: string, options?: ProbeOptions, diagnostics?: Diagnostics): Probe {
    // Only look at the type. String(name) would run a hostile toString().
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

    const rules = this.rulesOf(name, options, diagnostics);
    const { period } = rules;

    // An options getter can register probes behind our back. Re-check, or two names share a slot.
    if (this.registry.has(name) || this.registry.size >= PROFILER_PROBE_LIMIT) {
      return this.probe(name, undefined, diagnostics);
    }

    const slot = this.registry.size + 1;
    const entry = this.makeProbe(name, slot, rules);
    const { probe } = entry;
    this.registry.set(name, entry);

    if (slot < this.limit) {
      this.prime(slot, period);
    } else if (this.limit > 0 && !this.reported) {
      this.reported = true;
      // The limit belongs to the attached runtime, so report through it even when the caller
      // passed no diagnostics.
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
   * Calls a function and times it. If the result is a thenable, the span ends when it settles.
   * The caller only ever sees errors from its own function.
   * @param name Probe name.
   * @param fn The app's function.
   * @param diagnostics The current runtime's diagnostics, if there is one.
   * @returns Whatever fn returned, or the result of its then() call.
   */
  time<T>(name: string, fn: () => T, diagnostics?: Diagnostics): T {
    this.probe(name, undefined, diagnostics);

    // A rejected name has no entry. Just run the function without a span.
    const entry = this.registry.get(name);
    const token = entry ? entry.probe.begin() : -1;
    let waits = false;

    try {
      const result = fn();

      if (entry && token >= 0) {
        try {
          const then = (result as { then?: unknown } | null | undefined)?.then;

          if (typeof then === "function") {
            const done = (): void => {
              entry.settle(token, performance.now());
            };

            waits = true;
            entry.leave(token);

            // Hand back the chained result, so a rejection has exactly one owner: the caller.
            return (then as PromiseLike<unknown>["then"]).call(
              result,
              (value) => {
                done();
                return value;
              },
              (error: unknown) => {
                done();
                throw error;
              },
            ) as T;
          }
        } catch (error) {
          waits = false;
          diagnostics?.report(
            "capture.record_failed",
            `The library could not read what the function of the probe ${name} returned. The span ends now.`,
            undefined,
            error,
          );
        }
      }

      return result;
    } finally {
      if (!waits) {
        entry?.probe.end(token);
      }
    }
  }

  /**
   * Turns the recent-span ring on or off. The frame phases capture reads from it.
   * @param minMs Shortest span (ms) to keep. Infinity turns the ring off.
   */
  link(minMs: number): void {
    this.linkMs = minMs;

    if (minMs < Infinity && this.ring.length === 0) {
      this.ring = new Float64Array(PROFILER_RING_SPANS * SPAN_WIDTH);
    }
  }

  /**
   * Finds the probes that had a recent span inside a time range.
   * @param from Range start, as a performance.now() value.
   * @param to Range end.
   * @returns The probe names, without duplicates.
   */
  linked(from: number, to: number): string[] {
    const { ring } = this;
    const names = [...this.registry.keys()];
    const found = new Set<string>();

    for (let at = 0; at < ring.length; at += SPAN_WIDTH) {
      // Slot 0 means an empty row or a calibration span.
      if (ring[at] > 0 && ring[at + 1] < to && ring[at + 2] > from) {
        found.add(names[ring[at] - 1]);
      }
    }

    return [...found];
  }

  /**
   * Turns the profiler on with a runtime's sink. Calling it again swaps the sink.
   * @param sink The runtime's sink.
   */
  attach(sink: ProfilerSink): void {
    const limit = sink.capacity + 1;
    this.sink = sink;

    // Re-attaching with the same capacity keeps the data.
    if (this.stats.length !== limit * STATS_WIDTH) {
      this.stats = new Float64Array(limit * STATS_WIDTH);
      this.hist = new Uint32Array(limit * PROFILE_BUCKETS);
      this.selfHist = new Uint32Array(limit * PROFILE_BUCKETS);
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

  /** Turns the profiler off and drops the data. The runtime calls collect(false) first. */
  detach(): void {
    this.limit = 0;
    this.sink = null;
    this.clearTimer();
    this.clear();
  }

  /**
   * Sends one summary record per probe that has data, then starts a new interval. Does nothing
   * while the sink isn't ready.
   * @param timed True when called from the interval timer. Only a timed collect calibrates.
   */
  collect(timed: boolean): void {
    const { sink } = this;

    // A runtime that isn't ready would refuse the records, so keep the data and the timer for a
    // later collect. Zeroing the slots here would lose those points.
    if (!sink?.ready()) {
      return;
    }

    // The diagnostics throttle swallowed this attach's limit report. Try again, otherwise the
    // app never hears that some of its probes do nothing.
    if (this.limitDue) {
      this.reportLimit(sink);
    }

    this.clearTimer();

    // Calibration blocks the thread for 2-3 ms (longer on a too-coarse clock), so flush() and
    // the exit path skip it.
    if (timed && !this.calibrated && this.hasData()) {
      this.calibrate();
    }

    const start = `${String(this.startedAt)}000000`;
    for (const [name, entry] of this.registry) {
      // Probes over the limit have no row. After a detach() from inside an emit, none do.
      if (entry.slot < this.limit && this.stats[entry.slot * STATS_WIDTH + COUNT] > 0) {
        this.emitSlot(sink, name, entry, start);
      }
    }

    if (this.badTokens > 0) {
      sink.diagnostics.count("record.dropped_malformed", this.badTokens);
      this.badTokens = 0;
    }
  }

  /** Drops the interval's data. The profiler stays on. */
  reset(): void {
    this.clearTimer();
    this.badTokens = 0;
    this.clear();
  }

  /** Drops the data and any open spans. Spans started at or before this call add nothing. */
  private clear(): void {
    this.floor = performance.now();
    this.depth = 0;
    this.stats.fill(0);
    this.hist.fill(0);
    this.selfHist.fill(0);
    this.ring.fill(0);
  }

  /**
   * Reads the options for a new probe. Never throws into the app.
   * @param name Probe name.
   * @param options Options from the app.
   * @param diagnostics The current runtime's diagnostics, if there is one.
   * @returns The rules. Any invalid option falls back to its default.
   */
  private rulesOf(
    name: string,
    options: ProbeOptions | undefined,
    diagnostics: Diagnostics | undefined,
  ): ProbeRules {
    const rules: ProbeRules = { period: 1, threshold: Infinity, loose: false };
    let period: unknown;
    let threshold: unknown;
    let loose: unknown;

    // A getter or a Proxy trap on the options can throw.
    try {
      period = options?.sampleEvery;
      threshold = options?.slowMs;
      loose = options?.async;
    } catch (error) {
      diagnostics?.report(
        "config.invalid",
        `The library could not read the options of the probe ${name}. The library uses the defaults.`,
        undefined,
        error,
      );
      return rules;
    }

    if (
      typeof period === "number" &&
      Number.isInteger(period) &&
      period >= 1 &&
      period <= MAX_PERIOD
    ) {
      rules.period = period;
    } else if (period !== undefined) {
      diagnostics?.report(
        "config.invalid",
        `The sampleEvery option of the probe ${name} must be an integer from 1 to ${String(MAX_PERIOD)}. The library uses 1.`,
      );
    }

    if (typeof threshold === "number" && threshold >= 0 && threshold < Infinity) {
      rules.threshold = threshold;
    } else if (threshold !== undefined) {
      diagnostics?.report(
        "config.invalid",
        `The slowMs option of the probe ${name} must be a finite number, 0 or larger. The probe adds no breadcrumb.`,
      );
    }

    if (typeof loose === "boolean") {
      rules.loose = loose;
    } else if (loose !== undefined) {
      diagnostics?.report(
        "config.invalid",
        `The async option of the probe ${name} must be a boolean. The library uses false.`,
      );
    }

    return rules;
  }

  /**
   * Builds a probe's closures, once per probe, so destructured members still work.
   * @param name Probe name.
   * @param slot The probe's row.
   * @param rules Validated probe options.
   * @returns The registry entry, including the probe.
   */
  private makeProbe(name: string, slot: number, rules: ProbeRules): ProbeEntry {
    const { period, threshold, loose } = rules;

    // Records one duration, plus a breadcrumb if it is over the probe's threshold.
    const put = (ms: number): void => {
      this.add(slot, ms);

      if (ms > threshold) {
        this.sink?.outlier(name, ms);
      }
    };

    // Drop the span if we're off, or if it started at or before a detach() or reset().
    const settle: Settle = (token, now) => {
      if (slot < this.limit && token > this.floor) {
        put(now - token);
      }
    };

    const leave = (token: number): void => {
      if (!loose) {
        this.pop(slot, token, performance.now());
      }
    };

    const end = (token: number): void => {
      // Type check first, so the compare can never run a hostile valueOf().
      const now = typeof token === "number" && token >= 0 ? performance.now() : -1;
      if (now < 0) {
        // -1 means begin() didn't measure this span. Other bad tokens only count while we're on.
        if (token !== -1 && slot < this.limit) {
          this.badTokens++;
        }
        return;
      }

      if (loose) {
        settle(token, now);
        return;
      }

      // Drop the span if we're off, or if it started at or before a detach() or reset().
      if (slot >= this.limit || token <= this.floor) {
        return;
      }

      const self = this.pop(slot, token, now);
      put(now - token);

      // No frame means no self time: the frame was lost to a reset or to a full stack.
      if (self >= 0) {
        this.selfHist[slot * PROFILE_BUCKETS + bucketOf(Math.ceil(self * 1000))]++;
      }
    };

    const probe: Probe = {
      begin: () => {
        // Off, over the limit or sampled out: don't even read the clock.
        if (slot >= this.limit || !this.sampled(slot)) {
          return -1;
        }

        const now = performance.now();
        if (!loose) {
          this.push(slot, now);
        }

        return now;
      },
      end,
      endAfterPaint: (token) => {
        const waits =
          typeof token === "number" &&
          token >= 0 &&
          slot < this.limit &&
          this.afterPaint((now) => {
            settle(token, now);
          });

        // Bad token, probe off, or a page that isn't painting: end right away.
        if (!waits) {
          end(token);
          return;
        }

        leave(token);
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
          put(durationMs);
        }
      },
    };

    return { probe, slot, period, settle, leave };
  }

  /**
   * Pushes a frame for a new span.
   * @param slot The probe's row.
   * @param now Span start.
   */
  private push(slot: number, now: number): void {
    const { stack } = this;

    // A full stack is full of frames whose spans never got an end(). Drop them, or no later
    // span gets a self time.
    if (this.depth === PROFILER_STACK_DEPTH) {
      this.depth = 0;
    }

    const at = this.depth++ * FRAME_WIDTH;
    stack[at] = now;
    stack[at + 1] = 0;
    stack[at + 2] = slot;
  }

  /**
   * Pops a span's frame, along with any frames above it, and adds the span's duration to the
   * child time of the frame below.
   * @param slot The probe's row.
   * @param token Span start.
   * @param now Span end, or the time the span leaves the stack.
   * @returns Self time in ms, or -1 if the span had no frame.
   */
  private pop(slot: number, token: number, now: number): number {
    const { stack } = this;
    const ms = now - token;
    let child = 0;

    for (let at = (this.depth - 1) * FRAME_WIDTH; at >= 0; at -= FRAME_WIDTH) {
      // Any frame above ours is a span that never got an end(). Its child time is ours.
      child += stack[at + 1];

      if (stack[at] === token && stack[at + 2] === slot) {
        this.depth = at / FRAME_WIDTH;

        if (at > 0) {
          stack[at - FRAME_WIDTH + 1] += ms;
        }

        if (ms >= this.linkMs) {
          const { ring, ringAt } = this;
          ring[ringAt] = slot;
          ring[ringAt + 1] = token;
          ring[ringAt + 2] = now;
          this.ringAt = (ringAt + SPAN_WIDTH) % ring.length;
        }

        return Math.max(ms - child, 0);
      }
    }

    return -1;
  }

  /**
   * Runs a function in the first task after the next paint.
   * @param done Called with the time after the paint.
   * @returns False where there is no frame callback, or when the page is hidden.
   */
  private afterPaint(done: (now: number) => void): boolean {
    const { requestAnimationFrame: frame, document: page } = globalThis as PaintScope;

    if (
      typeof frame !== "function" ||
      typeof MessageChannel === "undefined" ||
      page?.visibilityState === "hidden"
    ) {
      return false;
    }

    if (!this.channel) {
      const drain = (): void => {
        const now = performance.now();
        const waiting = this.painted;
        this.painted = [];

        for (const end of waiting) {
          end(now);
        }
      };

      this.channel = new MessageChannel();
      this.channel.port1.onmessage = drain;

      // A hidden page gets no frame callbacks. End the spans now, or they include the hidden time.
      page?.addEventListener("visibilitychange", () => {
        if (page.visibilityState === "hidden") {
          drain();
        }
      });
    }

    // rAF callbacks run before the paint. A task posted from one runs after it.
    if (this.painted.push(done) === 1) {
      frame(() => {
        this.channel?.port2.postMessage(0);
      });
    }

    return true;
  }

  /**
   * Writes a slot's sampling row so the next span gets measured.
   * @param slot The probe's row.
   * @param period Sampling period.
   */
  private prime(slot: number, period: number): void {
    const at = slot * SAMPLING_WIDTH;
    this.sampling[at] = 1;
    this.sampling[at + 1] = period;
  }

  /**
   * Counts down a slot's sampling. A countdown gives an exact rate, which Math.random() wouldn't.
   * @param slot The probe's row.
   * @returns True if this span should be measured.
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
   * Adds one duration to a slot. This is the hot path: no Map lookup, no try.
   * @param slot The probe's row.
   * @param ms Duration in ms.
   */
  private add(slot: number, ms: number): void {
    // A forged token gives a negative duration. A broken clock gives NaN or Infinity.
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

    // Buckets include their upper bound, so round up or the value lands one bucket too low.
    this.hist[slot * PROFILE_BUCKETS + bucketOf(Math.ceil(ms * 1000))]++;

    // Slot 0 is the calibration slot, and calibration must not start an interval.
    if (this.timer === null && slot > 0 && this.sink !== null) {
      this.startedAt = Date.now();
      this.wait(this.sink);
    }
  }

  /**
   * Starts the interval timer, unref'd so a pending timer doesn't keep Node.js alive.
   * @param sink The runtime's sink.
   */
  private wait(sink: ProfilerSink): void {
    this.timer = setTimeout(() => {
      this.tick();
    }, sink.intervalMs());
    unrefTimer(this.timer);
  }

  /** Collects at the end of an interval, or waits another one if the runtime isn't ready. */
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
   * Reports that there are more probes than the limit allows. If the throttle drops the report,
   * the next collect tries again.
   * @param sink The runtime's sink.
   */
  private reportLimit(sink: ProfilerSink): void {
    // Clear the flag first, so a handler that collects can't kick off a second report.
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
   * Checks whether any probe recorded a value in this interval.
   * @returns True if a slot above 0 has a non-zero count.
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
   * Sends one slot's summary record and zeroes the slot. The sampling countdown is left alone.
   * @param sink The runtime's sink.
   * @param name Probe name.
   * @param entry The probe's registry entry.
   * @param start Interval start, in Unix nanoseconds.
   */
  private emitSlot(sink: ProfilerSink, name: string, entry: ProbeEntry, start: string): void {
    const { stats, hist } = this;
    const row = entry.slot * STATS_WIDTH;
    const base = entry.slot * PROFILE_BUCKETS;
    const count = stats[row + COUNT];
    const min = stats[row + MIN];
    const max = stats[row + MAX];

    // A bucket bound can be higher than the exact max, so clamp every percentile to [min, max].
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

    // Count the self times here, at collect, so the hot path has no second counter to write.
    const { selfHist } = this;
    let selfCount = 0;
    for (let at = base; at < base + PROFILE_BUCKETS; at++) {
      selfCount += selfHist[at];
    }

    if (selfCount > 0) {
      attributes[PROFILE_KEYS.selfP99] = Math.min(
        percentileOf(selfHist, base, selfCount, 0.99) / 1000,
        max,
      );
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

    // Zero before emitting: an app processor can call end() from inside the emit.
    stats.fill(0, row, row + STATS_WIDTH);
    hist.fill(0, base, base + PROFILE_BUCKETS);
    selfHist.fill(0, base, base + PROFILE_BUCKETS);
    sink.emit(PROFILE_METRIC_NAME, attributes, fields);
  }

  /**
   * Measures what one sampled begin()/end() pair costs, on slot 0. Runs once. If the clock never
   * shows an edge or never ticks, no value is set.
   */
  private calibrate(): void {
    this.calibrated = true;
    const { probe } = this.makeProbe("", 0, { period: 1, threshold: Infinity, loose: false });

    // Browsers round performance.now() to 5 us, 100 us or 1 ms. Measure from clock edge to clock
    // edge: a window that isn't aligned to an edge can be off by up to one tick.
    const first = performance.now();
    let edge = first;
    for (let reads = 0; reads < PROFILER_CALIBRATION_PAIRS && edge === first; reads++) {
      edge = performance.now();
    }

    // No edge within the read limit, so the clock is frozen or too coarse. Without a start edge
    // the result would come out too large.
    if (edge === first) {
      return;
    }

    // begin()'s token is the clock reading, so the loop doesn't need a third clock read.
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

    // Whole nanoseconds. Hypothesis: the noise in a single 2 ms run is more than 1 ns anyway.
    if (pairsAtTick > 0) {
      this.overhead = Math.round(((tick - edge) * 1e6) / pairsAtTick);
    }
  }
}

/**
 * Returns the profiler core for this library version. Two copies of the same version share it.
 * @returns The core.
 */
export function profilerCore(): ProfilerCore {
  // Each copy has its own class, so instanceof fails across copies. Cast structurally instead.
  const store = globalThis as Record<symbol, unknown>;
  const pinned = store[CORE_KEY] as ProfilerCore | undefined;
  if (pinned) {
    return pinned;
  }

  const core = new ProfilerCore();
  store[CORE_KEY] = core;
  return core;
}

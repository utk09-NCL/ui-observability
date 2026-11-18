// src/core/measure.ts
//
// Times one operation with named phases. Every phase and the total go into duration histograms.
// With a span, the operation is that span, with one child span per phase. measure() times a
// single function call with one.

import { METRIC_DEFAULT_BOUNDARIES } from "../constants";
import type { InstrumentDef, Measure, MetricAttributes } from "../models/metric";
import { type ClientSpan, newSpanId } from "../utils/tracing";
import type { Diagnostics } from "./diagnostics";
import type { SpanData } from "./spans";

/** Total duration of each measure, in milliseconds. */
const TOTAL_DURATION: InstrumentDef = {
  name: "ui.measure.duration",
  kind: "histogram",
  unit: "ms",
  boundaries: METRIC_DEFAULT_BOUNDARIES,
};

/** Duration of each phase, in milliseconds. */
const PHASE_DURATION: InstrumentDef = {
  name: "ui.measure.phase.duration",
  kind: "histogram",
  unit: "ms",
  boundaries: METRIC_DEFAULT_BOUNDARIES,
};

/** Where the values of one measure go. */
export interface MeasureSinks {
  /** Adds a value to a histogram. */
  metric(def: InstrumentDef, value: number, attributes: MetricAttributes): void;
  /** Records one span. */
  span(span: SpanData): void;
}

/**
 * Starts the clock for one operation.
 * @param name Operation name. A JavaScript caller can pass any type.
 * @param attributes Copy of the app's attribute set.
 * @param span The operation's span, or undefined when spans are off or the trace was dropped.
 * @param sinks Where the values go.
 * @returns The operation's handle.
 */
export function createMeasure(
  name: unknown,
  attributes: MetricAttributes,
  span: ClientSpan | undefined,
  sinks: MeasureSinks,
): Measure {
  // The record builder needs text.
  const label = String(name);
  const startMs = Date.now();
  const startedAt = performance.now();
  let open: { name: string; at: number } | undefined;
  let ended = false;

  // The histograms use the monotonic clock, but a span needs epoch times.
  const epoch = (at: number): number => startMs + at - startedAt;

  const closePhase = (now: number, error: boolean): void => {
    if (!open) {
      return;
    }

    sinks.metric(PHASE_DURATION, now - open.at, {
      ...attributes,
      "measure.name": label,
      "measure.phase": open.name,
    });
    if (span) {
      sinks.span({
        name: open.name,
        kind: "internal",
        traceId: span.traceId,
        spanId: newSpanId(),
        parentSpanId: span.spanId,
        startMs: epoch(open.at),
        endMs: epoch(now),
        error,
        attributes: { "measure.name": label },
      });
    }
    open = undefined;
  };

  return {
    phase: (next: unknown) => {
      if (ended) {
        return;
      }

      const now = performance.now();
      closePhase(now, false);
      open = { name: String(next), at: now };
    },
    end: (outcome = "ok") => {
      if (ended) {
        return;
      }

      ended = true;
      const now = performance.now();
      const error = outcome === "error";
      closePhase(now, error);
      const fields = { ...attributes, "measure.outcome": outcome };
      sinks.metric(TOTAL_DURATION, now - startedAt, { ...fields, "measure.name": label });
      if (span) {
        sinks.span({
          ...span,
          name: label,
          kind: "internal",
          startMs,
          endMs: epoch(now),
          error,
          attributes: fields,
        });
      }
    },
  };
}

/**
 * Calls a function and ends the measure when the call returns. If the result has a `then`
 * function, the measure ends when it settles. A throw or a rejection ends it with the outcome
 * "error" and goes to the caller.
 * @param handle The measure of the call.
 * @param fn The app's function.
 * @param diagnostics Reports a result whose `then` can't be read.
 * @returns Whatever fn returned, or the result of its then() call.
 */
export function measureCall<T>(handle: Measure, fn: () => T, diagnostics: Diagnostics): T {
  // finally sees a throw from fn or from the result's then(), so the error goes to the caller
  // unchanged and the measure still ends.
  let outcome: string | undefined = "error";
  try {
    const result = fn();
    // A hostile result can throw from its then getter. The measure then ends now.
    const then = diagnostics.guard(
      "record.sanitize_failed",
      "The library could not read what the function of the measure returned. The measure ends now.",
      (): unknown => (result as { then?: unknown } | null | undefined)?.then,
    );

    if (typeof then !== "function") {
      outcome = "ok";
      return result;
    }

    // Hand back the chained result, so a rejection has exactly one owner: the caller.
    const chained = (then as PromiseLike<unknown>["then"]).call(
      result,
      (value) => {
        handle.end();
        return value;
      },
      (error: unknown) => {
        handle.end("error");
        throw error;
      },
    ) as T;
    // The settle ends the measure from here.
    outcome = undefined;
    return chained;
  } finally {
    if (outcome !== undefined) {
      handle.end(outcome);
    }
  }
}

// src/core/spans.ts
//
// Builds the span data for a root span and the span fields for a span record. The runtime
// builds every span as a record of type "span", and the traces serializer reads the span fields.

import { SPAN_KEYS } from "../constants";
import type { EndedTrace, RotateReason } from "../utils/tracing";

/** Microseconds in one millisecond. */
const US_PER_MS = 1000;

/** Root span name for each reason a trace can start. */
const ROOT_NAMES: Record<RotateReason, string> = {
  start: "ui.start",
  interaction: "ui.interaction",
  navigation: "ui.navigation",
  explicit: "ui.trace",
  maxAge: "ui.trace",
};

/** One span recorded by the runtime. */
export interface SpanData {
  /** Span name. */
  name: string;
  /** "internal" for a root span, "client" for a request. */
  kind: "internal" | "client";
  /** Trace ID. */
  traceId: string;
  /** Span ID. */
  spanId: string;
  /** The parent's span ID, or "" for a root span. */
  parentSpanId: string;
  /** Start time in epoch milliseconds. */
  startMs: number;
  /** End time in epoch milliseconds. */
  endMs: number;
  /** True for a failed operation. */
  error: boolean;
  /** The span's attributes. */
  attributes: Record<string, unknown>;
  /** Server span linked through a response traceparent entry. */
  link?: { traceId: string; spanId: string };
}

/**
 * Converts epoch milliseconds to nanoseconds as a decimal string, keeping microseconds.
 * @param ms Epoch time in milliseconds. May have a fraction.
 * @returns Epoch time in nanoseconds.
 */
function unixNano(ms: number): string {
  return `${String(Math.round(ms * US_PER_MS))}000`;
}

/**
 * Builds the root span for an ambient trace that has ended.
 * @param ended The trace.
 * @returns The span data.
 */
export function rootSpan(ended: EndedTrace): SpanData {
  return {
    name: ROOT_NAMES[ended.reason],
    kind: "internal",
    traceId: ended.traceId,
    spanId: ended.spanId,
    parentSpanId: "",
    startMs: ended.startedAt,
    endMs: ended.endedAt,
    error: false,
    attributes: {},
  };
}

/**
 * Builds the span fields for a span record. The record limits don't trim them.
 * @param span The span data.
 * @returns The fields.
 */
export function spanFields(span: SpanData): Record<string, unknown> {
  return {
    [SPAN_KEYS.kind]: span.kind,
    [SPAN_KEYS.parentId]: span.parentSpanId,
    [SPAN_KEYS.start]: unixNano(span.startMs),
    [SPAN_KEYS.end]: unixNano(span.endMs),
    [SPAN_KEYS.status]: span.error ? "error" : "unset",
    ...(span.link
      ? {
          [SPAN_KEYS.linkTraceId]: span.link.traceId,
          [SPAN_KEYS.linkSpanId]: span.link.spanId,
        }
      : {}),
  };
}

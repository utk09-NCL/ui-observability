// src/core/spans.ts
//
// Builds the span data of a root span and the span fields of a span record. The runtime builds
// each span as a record with the type "span". The traces serializer reads the span fields.

import { SPAN_KEYS } from "../constants";
import type { EndedTrace, RotateReason } from "../utils/tracing";

/** Microseconds in one millisecond. */
const US_PER_MS = 1000;

/** Name of the root span for each cause of the start of a trace. */
const ROOT_NAMES: Record<RotateReason, string> = {
  start: "ui.start",
  interaction: "ui.interaction",
  navigation: "ui.navigation",
  explicit: "ui.trace",
  maxAge: "ui.trace",
};

/** One span that the runtime records. */
export interface SpanData {
  /** Span name. */
  name: string;
  /** "internal" for a root span, "client" for a request. */
  kind: "internal" | "client";
  /** Trace ID. */
  traceId: string;
  /** Span ID. */
  spanId: string;
  /** Span ID of the parent, or "" for a root span. */
  parentSpanId: string;
  /** Start time in epoch milliseconds. */
  startMs: number;
  /** End time in epoch milliseconds. */
  endMs: number;
  /** True for a failed operation. */
  error: boolean;
  /** Attributes of the span. */
  attributes: Record<string, unknown>;
}

/**
 * Converts epoch milliseconds to nanoseconds, as a decimal string. It keeps microseconds.
 * @param ms Epoch time in milliseconds. It can have a fraction.
 * @returns Epoch time in nanoseconds.
 */
function unixNano(ms: number): string {
  return `${String(Math.round(ms * US_PER_MS))}000`;
}

/**
 * Builds the root span of an ambient trace that ended.
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
 * Builds the span fields of a span record. The record limits do not cut them.
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
  };
}

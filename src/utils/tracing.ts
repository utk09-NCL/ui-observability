// src/utils/tracing.ts
//
// Manages ambient distributed tracing contexts, OpenTelemetry span integration, and W3C traceparent headers.
// One trace id spans consecutive records. Minting one per record gives every
// trace exactly one span.

import {
  isSpanContextValid,
  context as otelContext,
  trace as otelTrace,
  propagation,
} from "@opentelemetry/api";
import {
  SPAN_ID_BYTES,
  TRACE_FLAGS_MASK,
  TRACE_FLAGS_SAMPLED,
  TRACE_ID_BYTES,
  TRACE_MAX_AGE_MS,
  TRACEPARENT_VERSION,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { randomHex } from "./identity";

/** W3C trace context fields attached to log records and network headers. */
export interface TraceContext {
  /** Hexadecimal 32-character W3C trace identifier. */
  traceId: string;
  /** Hexadecimal 16-character W3C span identifier. */
  spanId: string;
  /** Bitfield byte containing W3C trace flags. */
  traceFlags: number;
}

/** Trigger classification for rotating the ambient trace context. */
export type RotateReason = "start" | "interaction" | "navigation" | "explicit" | "maxAge";

/** Internal trace context tracking creation timestamp for expiration. */
interface AmbientTrace extends TraceContext {
  /** Creation timestamp in epoch milliseconds. */
  startedAt: number;
}

/**
 * Generates a random 32-character hex string conforming to W3C trace ID format.
 * Exported for callers starting their own trace. A wrong-width id is dropped by
 * the backend without a word.
 * @returns 32-character hexadecimal trace ID.
 */
export function newTraceId(): string {
  return randomHex(TRACE_ID_BYTES);
}

/**
 * Generates a random 16-character hex string conforming to W3C span ID format.
 * @returns 16-character hexadecimal span ID.
 */
export function newSpanId(): string {
  return randomHex(SPAN_ID_BYTES);
}

/**
 * Creates a new AmbientTrace instance with sampled trace flag enabled. Set
 * unconditionally: sampling runs before the record is built.
 * @returns Initialized AmbientTrace object.
 */
function mintAmbient(): AmbientTrace {
  return {
    traceId: newTraceId(),
    spanId: newSpanId(),
    traceFlags: TRACE_FLAGS_SAMPLED,
    startedAt: Date.now(),
  };
}

/**
 * Creates a defensive copy of a TraceContext from an AmbientTrace.
 * @param ambient Source ambient trace object.
 * @returns Defensive copy of TraceContext.
 */
function toTraceContext(ambient: AmbientTrace): TraceContext {
  return {
    traceId: ambient.traceId,
    spanId: ambient.spanId,
    traceFlags: ambient.traceFlags,
  };
}

/** Manages ambient distributed trace contexts and resolves active OpenTelemetry spans. */
export class TraceEngine {
  /**
   * Active ambient trace context. Instance state, never module state. Two runtimes
   * in one document must not share a trace id.
   */
  private ambient: AmbientTrace = mintAmbient();

  /**
   * @param diagnostics Diagnostics reporter.
   * @param maxAgeMs Maximum lifetime of an un-rotated ambient trace in milliseconds.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly maxAgeMs = TRACE_MAX_AGE_MS,
  ) {}

  /**
   * Resolves trace context, prioritizing active OpenTelemetry spans over the ambient trace.
   * @returns Active TraceContext.
   */
  resolve(): TraceContext {
    const fromOtel = this.diagnostics.guard(
      "trace.otel_failed",
      "reading the active OpenTelemetry span",
      (): TraceContext | undefined => {
        const span = otelTrace.getActiveSpan();
        if (span === undefined) {
          return undefined;
        }
        const spanContext = span.spanContext();
        if (!isSpanContextValid(spanContext)) {
          return undefined;
        }
        return {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          traceFlags: spanContext.traceFlags,
        };
      },
    );
    if (fromOtel !== undefined) {
      return fromOtel;
    }

    // Rotates ambient trace if age exceeds maxAgeMs. Checked on read, not on a
    // timer. A timer holds this instance alive for the life of the document.
    if (Date.now() - this.ambient.startedAt > this.maxAgeMs) {
      this.rotate("maxAge");
    }
    return toTraceContext(this.ambient);
  }

  /**
   * Rotates the ambient trace context to mark the start of a new logical operation.
   * @param _reason Event reason triggering the rotation.
   * @returns Newly created TraceContext.
   */
  rotate(_reason: RotateReason): TraceContext {
    this.ambient = mintAmbient();
    return toTraceContext(this.ambient);
  }

  /**
   * Generates W3C traceparent headers using registered OpenTelemetry propagators or ambient fallback.
   * @returns Header map containing traceparent.
   */
  headers(): Record<string, string> {
    const carrier: Record<string, string> = {};
    this.diagnostics.guard("trace.otel_failed", "injecting OpenTelemetry headers", () => {
      propagation.inject(otelContext.active(), carrier);
    });
    if (!carrier.traceparent) {
      const ctx = this.resolve();
      // Masks trace flags to 2-digit hex byte per W3C specification. trace-flags is
      // a bitfield, not a boolean. 00 or 01 discards what an upstream tracer set.
      const flags = (ctx.traceFlags & TRACE_FLAGS_MASK).toString(16).padStart(2, "0");
      carrier.traceparent = `${TRACEPARENT_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
    }
    return carrier;
  }
}

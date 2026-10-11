// src/utils/tracing.ts
//
// Manages ambient distributed trace contexts, OpenTelemetry span integration, and W3C
// traceparent headers. Consecutive records share one trace id. A new trace id for each
// record gives each trace only one span.

import {
  SPAN_ID_BYTES,
  TRACE_FLAGS_MASK,
  TRACE_FLAGS_SAMPLED,
  TRACE_ID_BYTES,
  TRACE_MAX_AGE_MS,
  TRACEPARENT_HEADER,
  TRACEPARENT_VERSION,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { OtelApi, OtelLoader, OtelSpanContext } from "../models/config";
import { randomHex } from "./identity";

/** The W3C format sets these hex widths. A span context with a different width is not usable. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Matches a digit that is not zero. A span that has not started reports an all-zero id. */
const NON_ZERO = /[1-9a-f]/;

/**
 * Evaluates whether a span context can carry correlation. It replaces isSpanContextValid
 * from the peer package. That function is not available when the peer is not installed.
 * @param context Span context reported by the host.
 * @returns True if both ids have the W3C width and neither is all zeros.
 */
function isUsableSpanContext(context: OtelSpanContext): boolean {
  return (
    TRACE_ID_PATTERN.test(context.traceId) &&
    NON_ZERO.test(context.traceId) &&
    SPAN_ID_PATTERN.test(context.spanId) &&
    NON_ZERO.test(context.spanId)
  );
}

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
 * Generates a random 32-character hex string in the W3C trace ID format.
 * Use it to start your own trace. The backend drops an id with the wrong width
 * and reports no error.
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
 * Creates a new AmbientTrace instance with the sampled trace flag set. It always sets
 * the flag. Sampling runs before the library builds the record.
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
   * Active ambient trace context. The instance keeps this state, not the module. Two
   * runtimes in one document must not share a trace id.
   */
  private ambient: AmbientTrace = mintAmbient();

  /** The optional peer after it loads. It is undefined while it loads or when it is absent. */
  private otel: OtelApi | undefined;

  /**
   * @param diagnostics Diagnostics reporter.
   * @param maxAgeMs Maximum lifetime of an un-rotated ambient trace in milliseconds.
   * @param load Loader for the OpenTelemetry API. If it is not set, OTel is off.
   * Do not import the peer by name. The Vite dev server fails if the peer is not installed.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly maxAgeMs = TRACE_MAX_AGE_MS,
    private readonly load?: OtelLoader,
  ) {}

  /**
   * Loads the OpenTelemetry API. Until the load completes, records use the ambient trace.
   * If there is no loader or the load fails, all records use the ambient trace.
   * @returns Promise resolving once the attempt has settled.
   */
  async loadOtel(): Promise<void> {
    if (!this.load) {
      return;
    }

    try {
      this.otel = await this.load();
    } catch (error) {
      this.diagnostics.report(
        "trace.otel_failed",
        "The library could not load @opentelemetry/api. Records use the trace ids of the library.",
        undefined,
        error,
      );
    }
  }

  /**
   * Resolves trace context, prioritizing active OpenTelemetry spans over the ambient trace.
   * @returns Active TraceContext.
   */
  resolve(): TraceContext {
    const fromOtel = this.activeSpanContext();
    if (fromOtel !== undefined) {
      return fromOtel;
    }

    // Rotate the ambient trace when its age exceeds maxAgeMs. The check runs on read,
    // not on a timer. A timer keeps this instance alive for the life of the document.
    if (Date.now() - this.ambient.startedAt > this.maxAgeMs) {
      this.rotate("maxAge");
    }
    return toTraceContext(this.ambient);
  }

  /**
   * Reads the host's active span, if the peer is loaded and a span is running.
   * @returns Trace context of the active span, or undefined.
   */
  private activeSpanContext(): TraceContext | undefined {
    const otel = this.otel;
    if (!otel) {
      return undefined;
    }

    return this.diagnostics.guard(
      "trace.otel_failed",
      "The library could not read the active OpenTelemetry span.",
      (): TraceContext | undefined => {
        const span = otel.trace.getActiveSpan();
        if (span === undefined) {
          return undefined;
        }
        const spanContext = span.spanContext();
        if (!isUsableSpanContext(spanContext)) {
          return undefined;
        }
        return {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          traceFlags: spanContext.traceFlags,
        };
      },
    );
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
   * Generates W3C traceparent headers with the registered OpenTelemetry propagators.
   * Without a traceparent from OpenTelemetry, it uses the ambient trace.
   * @returns Header map containing traceparent.
   */
  headers(): Record<string, string> {
    const carrier: Record<string, string> = {};
    const otel = this.otel;
    if (otel) {
      this.diagnostics.guard(
        "trace.otel_failed",
        "The library could not add the OpenTelemetry headers.",
        () => {
          otel.propagation.inject(otel.context.active(), carrier);
        },
      );
    }
    if (!carrier[TRACEPARENT_HEADER]) {
      const ctx = this.resolve();
      // Mask the trace flags to a 2-digit hex byte, as the W3C specification requires.
      // trace-flags is a bitfield, not a boolean. A fixed 00 or 01 discards upstream flags.
      const flags = (ctx.traceFlags & TRACE_FLAGS_MASK).toString(16).padStart(2, "0");
      carrier[TRACEPARENT_HEADER] = `${TRACEPARENT_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
    }
    return carrier;
  }
}

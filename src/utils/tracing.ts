// src/utils/tracing.ts
//
// Manages ambient distributed trace contexts, OpenTelemetry span integration, and W3C
// traceparent headers. Consecutive records share one trace id, because a new trace id for
// every record would give each trace only one span.

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

/** The W3C format fixes these hex widths. A span context with any other width is unusable. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Matches a digit that isn't zero. A span that hasn't started reports an all-zero id. */
const NON_ZERO = /[1-9a-f]/;

/**
 * Checks whether a span context can carry correlation. Replaces isSpanContextValid from the
 * peer package, which isn't available when the peer isn't installed.
 * @param context The span context reported by the host.
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

/** Why the ambient trace context rotated. */
export type RotateReason = "start" | "interaction" | "navigation" | "explicit" | "maxAge";

/** An ambient trace that ended. Its root span covers it. */
export interface EndedTrace {
  /** Trace ID. */
  traceId: string;
  /** Span ID of the root span. */
  spanId: string;
  /** Why the trace started. */
  reason: RotateReason;
  /** Start time in epoch milliseconds. */
  startedAt: number;
  /** End time in epoch milliseconds. */
  endedAt: number;
}

/** The client span that a traceparent header names. */
export interface ClientSpan {
  /** Trace ID. */
  traceId: string;
  /** Span ID of the client span. */
  spanId: string;
  /** Span ID of the trace's root span. */
  parentSpanId: string;
}

/** One request's headers, and the client span they name. */
export interface RequestTrace {
  /** Header map containing traceparent. */
  headers: Record<string, string>;
  /** The request's client span. Undefined when the library records no span for it. */
  span?: ClientSpan;
}

/** The runtime's span decisions. */
export interface SpanHooks {
  /**
   * Checks whether the library records spans.
   * @returns True when there is a traces endpoint.
   */
  enabled(): boolean;
  /**
   * Checks whether sampling keeps a trace's spans.
   * @param traceId Trace ID.
   * @returns True if the library sends the trace's spans.
   */
  keeps(traceId: string): boolean;
  /**
   * Receives an ambient trace that ended.
   * @param ended The trace.
   */
  onEnd(ended: EndedTrace): void;
}

/** Internal trace context tracking creation timestamp for expiration. */
interface AmbientTrace extends TraceContext {
  /** Creation timestamp in epoch milliseconds. */
  startedAt: number;
  /** Why the trace started. */
  reason: RotateReason;
  /** True once the root span has ended. It ends only once. */
  ended: boolean;
}

/**
 * Generates a random 32-character hex string in the W3C trace ID format. Use it to start
 * your own trace. The backend drops an id with the wrong width without reporting an error.
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
 * Creates a new AmbientTrace with the sampled trace flag set. The flag is always set, because
 * sampling runs before the library builds the record.
 * @param reason Why the trace starts.
 * @returns The initialized AmbientTrace.
 */
function mintAmbient(reason: RotateReason): AmbientTrace {
  return {
    traceId: newTraceId(),
    spanId: newSpanId(),
    traceFlags: TRACE_FLAGS_SAMPLED,
    startedAt: Date.now(),
    reason,
    ended: false,
  };
}

/**
 * Formats a W3C traceparent value.
 * @param traceId Trace ID.
 * @param spanId The caller's span ID.
 * @param traceFlags Trace flags.
 * @returns The traceparent value.
 */
function traceparent(traceId: string, spanId: string, traceFlags: number): string {
  // Mask the trace flags to a 2-digit hex byte, as the W3C specification requires.
  // trace-flags is a bitfield, not a boolean, and a fixed 00 or 01 would discard upstream flags.
  const flags = (traceFlags & TRACE_FLAGS_MASK).toString(16).padStart(2, "0");
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${flags}`;
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
   * The active ambient trace context. This state lives on the instance, not the module,
   * because two runtimes in one document must not share a trace id.
   */
  private ambient: AmbientTrace = mintAmbient("start");

  /** The optional peer, once loaded. Undefined while it loads or when it is absent. */
  private otel: OtelApi | undefined;

  /**
   * @param diagnostics Diagnostics reporter.
   * @param maxAgeMs Maximum lifetime of an un-rotated ambient trace in milliseconds.
   * @param load Loader for the OpenTelemetry API. If it isn't set, OTel is off.
   * Do not import the peer by name, because the Vite dev server fails if the peer isn't
   * installed.
   * @param spans The runtime's span decisions. Without them, the library records no span.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly maxAgeMs = TRACE_MAX_AGE_MS,
    private readonly load?: OtelLoader,
    private readonly spans?: SpanHooks,
  ) {}

  /**
   * Loads the OpenTelemetry API. Until the load completes, records use the ambient trace.
   * If there is no loader or the load fails, all records use the ambient trace.
   * @returns A promise that resolves when the attempt settles.
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
    return this.activeSpanContext() ?? this.ambientContext();
  }

  /**
   * Reads the ambient trace, rotating it first if it is too old.
   * @returns The ambient TraceContext.
   */
  private ambientContext(): TraceContext {
    // Rotate the ambient trace once it is older than maxAgeMs. This is checked on read, not on
    // a timer, because a timer would keep this instance alive for the life of the document.
    if (Date.now() - this.ambient.startedAt > this.maxAgeMs) {
      this.rotate("maxAge");
    }
    return toTraceContext(this.ambient);
  }

  /**
   * Reads the host's active span, if the peer module loaded and a span is running.
   * @returns The active span's trace context, or undefined.
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
   * Rotates the ambient trace context to mark the start of a new logical operation, and ends
   * the old trace's root span.
   * @param reason The event that triggers the rotation.
   * @returns The newly created TraceContext.
   */
  rotate(reason: RotateReason): TraceContext {
    // Set the new trace first, so a record that a hook makes inside onEnd joins the new trace.
    // Otherwise that record would rotate again, and its trace would get no root span.
    const old = this.ambient;
    this.ambient = mintAmbient(reason);
    const next = toTraceContext(this.ambient);
    this.finish(old);
    return next;
  }

  /**
   * Ends the ambient trace's root span, once. Later records can still use the trace. The exit
   * flush calls this, because a closing document has no later rotation.
   */
  end(): void {
    this.finish(this.ambient);
  }

  /**
   * Ends a trace's root span, once.
   * @param ambient The trace to end.
   */
  private finish(ambient: AmbientTrace): void {
    if (ambient.ended) {
      return;
    }

    ambient.ended = true;
    this.spans?.onEnd({
      traceId: ambient.traceId,
      spanId: ambient.spanId,
      reason: ambient.reason,
      startedAt: ambient.startedAt,
      endedAt: Date.now(),
    });
  }

  /**
   * Generates W3C traceparent headers with the registered OpenTelemetry propagators. Falls
   * back to the ambient trace when OpenTelemetry provides no traceparent.
   * @returns Header map containing traceparent.
   */
  headers(): Record<string, string> {
    return this.trace(false).headers;
  }

  /**
   * Generates the headers for one request from the network capture. With spans on, the
   * traceparent names a new client span of the ambient trace.
   * @returns The headers, and the client span that the library records.
   */
  request(): RequestTrace {
    return this.trace(true);
  }

  /**
   * Generates the trace headers.
   * @param client True to name a new client span in the traceparent.
   * @returns The headers, and the client span that the library records.
   */
  private trace(client: boolean): RequestTrace {
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
    if (carrier[TRACEPARENT_HEADER]) {
      return { headers: carrier };
    }

    // The peer keeps its own spans, so the library records no span for one of the peer's traces.
    const fromOtel = this.activeSpanContext();
    const ctx = fromOtel ?? this.ambientContext();
    const spans = fromOtel ? undefined : this.spans;

    if (!spans?.enabled()) {
      carrier[TRACEPARENT_HEADER] = traceparent(ctx.traceId, ctx.spanId, ctx.traceFlags);
      return { headers: carrier };
    }

    // Clear the sampled flag on a trace that sampling drops, so a downstream service drops its
    // spans too. The whole trace stays or goes.
    const kept = spans.keeps(ctx.traceId);
    const flags = kept ? ctx.traceFlags : ctx.traceFlags & ~TRACE_FLAGS_SAMPLED;
    const spanId = client ? newSpanId() : ctx.spanId;
    carrier[TRACEPARENT_HEADER] = traceparent(ctx.traceId, spanId, flags);

    if (!client || !kept) {
      return { headers: carrier };
    }

    return { headers: carrier, span: { traceId: ctx.traceId, spanId, parentSpanId: ctx.spanId } };
  }
}

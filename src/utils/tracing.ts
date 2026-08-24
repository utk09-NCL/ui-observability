// src/utils/tracing.ts
//
// The ambient trace: one trace id shared by consecutive records, rotated on
// meaningful boundaries.
//
// A trace id is never minted per record. Do that and every trace in the backend
// holds exactly one span, the correlation the field advertises does nothing,
// and nothing in the output looks wrong. The id rotates on a click, a route
// change, an explicit call, and failing all three an age cap, so a tab left
// open all day does not pile a week of records into one trace.
//
// An active OpenTelemetry span outranks the ambient trace: where the host
// application runs an OTel SDK, its span is the real parent of this work.
//
// Every call into the OTel API goes through diagnostics. It is a global
// somebody else registered, running whatever propagator they installed.

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

/** The trace fields a record carries, which are also the variable parts of a `traceparent`. */
export interface TraceContext {
  /** W3C trace id, thirty-two hex characters. The field that groups records into one trace. */
  traceId: string;
  /** W3C span id, sixteen hex characters, naming this operation inside the trace. */
  spanId: string;
  /** W3C trace-flags: one byte of bitfield, not a boolean. Bit zero is sampled. */
  traceFlags: number;
}

/**
 * What ended one logical operation and began the next. Closed, because each
 * boundary has a call site that has to spell it the same way. `maxAge` is the
 * only one raised here; the rest come from capture and from the consumer.
 */
export type RotateReason = "start" | "interaction" | "navigation" | "explicit" | "maxAge";

/** The ambient trace plus the bookkeeping the age cap is measured from. */
interface AmbientTrace extends TraceContext {
  /** Epoch ms at which this trace was minted, never the time it was last used. */
  startedAt: number;
}

/**
 * A fresh W3C trace id. Exported because a caller starting its own trace needs
 * the same format, and a hand-rolled id of the wrong width is dropped by the
 * backend without a word.
 */
export function newTraceId(): string {
  return randomHex(TRACE_ID_BYTES);
}

/** A fresh W3C span id, half the width of a trace id and drawn from the same source. */
export function newSpanId(): string {
  return randomHex(SPAN_ID_BYTES);
}

/**
 * Begin a trace. The sampled bit is set unconditionally: sampling happens before
 * a record is built, so anything that reaches a trace was kept deliberately and
 * must not be thrown away by the backend.
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
 * The wire fields of an ambient trace, as a copy. Nothing outside can age a
 * trace by writing to `startedAt`, and a caller keeps the trace it asked for
 * after a rotation replaces the ambient one.
 */
function toTraceContext(ambient: AmbientTrace): TraceContext {
  return { traceId: ambient.traceId, spanId: ambient.spanId, traceFlags: ambient.traceFlags };
}

/** Owns the ambient trace: what goes on this record, and what goes on this request. */
export class TraceEngine {
  /**
   * The trace every record joins until something rotates it. Instance state,
   * never module state: two runtimes in one document must not share a trace id,
   * and a shared one makes each test depend on the order the files ran in.
   */
  private ambient: AmbientTrace = mintAmbient();

  /**
   * @param diagnostics Where a fault in the OTel API is reported. None of that API is ours, so
   * every call into it is guarded.
   * @param maxAgeMs How long one ambient trace lives before `resolve` rotates it unprompted. The
   * default is the tuned value; an explicit one is for a caller that knows its own cadence.
   */
  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly maxAgeMs = TRACE_MAX_AGE_MS,
  ) {}

  /**
   * The trace to stamp on a record. Called once per record.
   *
   * An active OpenTelemetry span always wins, so records join the host
   * application's traces with no configuration on either side. A span whose
   * context is unusable falls through to the ambient trace rather than shipping
   * an all-zero id. `isSpanContextValid` decides that, being OTel's own
   * definition, and the SDK types every field as present so there is nothing
   * left to hand-check.
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

    // Checked on read, not on a timer. A timer would hold this instance alive
    // for the life of the document and rotate traces in a tab nobody has
    // touched, to change an id no record was going to carry.
    if (Date.now() - this.ambient.startedAt > this.maxAgeMs) {
      this.rotate("maxAge");
    }
    return toTraceContext(this.ambient);
  }

  /**
   * Begin a new logical operation, so that records from here on form a new trace.
   *
   * @param _reason Why the trace rotated. Unused today, and kept: it is the
   * shape every call site already reads by, and what a rotation diagnostic or a
   * rotations-per-reason metric would carry. Dropping it means touching every
   * caller later to recover a fact the caller already knows.
   * @returns The new trace, for a caller that wants to report the id it just started.
   */
  rotate(_reason: RotateReason): TraceContext {
    this.ambient = mintAmbient();
    return toTraceContext(this.ambient);
  }

  /**
   * W3C headers for one outgoing request.
   *
   * Attach these only to targets the consumer controls. An unexpected
   * `traceparent` on a third-party request forces a CORS preflight the third
   * party will not answer, and their API then fails inside the consumer's
   * application.
   *
   * A propagator the host registered gets first refusal, since it knows about
   * tracestate, baggage and vendor headers this library does not. The fallback
   * header is built from `resolve`, so a request and the records describing it
   * name one trace. A fresh id here would match no record ever emitted.
   */
  headers(): Record<string, string> {
    const carrier: Record<string, string> = {};
    this.diagnostics.guard("trace.otel_failed", "injecting OpenTelemetry headers", () => {
      propagation.inject(otelContext.active(), carrier);
    });
    if (!carrier.traceparent) {
      const ctx = this.resolve();
      // trace-flags is a two-hex-digit bitfield, not a boolean. Bit zero is
      // sampled and further bits are already defined, so the field is masked to
      // its byte; collapsing it to 00 or 01 discards what an upstream tracer set.
      const flags = (ctx.traceFlags & TRACE_FLAGS_MASK).toString(16).padStart(2, "0");
      carrier.traceparent = `${TRACEPARENT_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
    }
    return carrier;
  }
}

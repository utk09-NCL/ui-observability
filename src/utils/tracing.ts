// src/utils/tracing.ts
//
// The ambient trace: one trace id, shared by consecutive records, rotated on
// meaningful boundaries.
//
// A trace id is not minted per record. That is the single decision this file
// exists to enforce, and it is the one that is easiest to undo by accident. Give
// every record its own id and every trace in the backend holds exactly one span,
// which answers no question the record had not already answered on its own. The
// correlation the field advertises then silently does nothing, and nothing about
// the output looks wrong while it happens.
//
// So the id is held here and reused, and it rotates when the work genuinely
// changes: a click, a route change, an explicit call from the consumer, and
// failing all three, an age cap, because a tab left open all day would otherwise
// pile a week of records into one trace.
//
// An active OpenTelemetry span outranks all of that. Where the host application
// already runs an OTel SDK, its span is the real parent of this work and the
// ambient trace is only a stand-in for it, so joining the host's trace costs the
// consumer no configuration on either side.
//
// Every call into the OTel API goes through diagnostics. It is a global that
// somebody else's code registered, its propagator is whatever they installed,
// and neither is ours to trust with the consumer's stack.

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
 * What ended one logical operation and began the next.
 *
 * A closed set rather than free-form text, because these are the boundaries the
 * product treats as meaningful and each one has a call site that has to spell it
 * the same way. `maxAge` is the only one this file raises itself; the rest come
 * from capture and from the consumer.
 */
export type RotateReason = "start" | "interaction" | "navigation" | "explicit" | "maxAge";

/** The ambient trace plus the bookkeeping the age cap is measured from. */
interface AmbientTrace extends TraceContext {
  /** Epoch ms at which this trace was minted, never the time it was last used. */
  startedAt: number;
}

/**
 * A fresh W3C trace id.
 *
 * Exported because a caller starting a trace of its own needs an id in the same
 * format, and hand-rolling one is how a twenty-eight character id reaches a
 * backend that silently drops the record.
 */
export function newTraceId(): string {
  return randomHex(TRACE_ID_BYTES);
}

/** A fresh W3C span id, half the width of a trace id and drawn from the same source. */
export function newSpanId(): string {
  return randomHex(SPAN_ID_BYTES);
}

/**
 * Begin a trace.
 *
 * The sampled bit is set unconditionally. Sampling in this library happens
 * before a record is built, so anything that reaches a trace has already been
 * kept deliberately, and shipping it unsampled would ask the backend to throw
 * away the records we chose to pay for.
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
 * The wire fields of an ambient trace, without the bookkeeping.
 *
 * A copy rather than the stored object, so that nothing outside can age a trace
 * by writing to `startedAt`, and so a caller holding a returned context still
 * holds the trace it asked for after a rotation has replaced the ambient one.
 */
function toTraceContext(ambient: AmbientTrace): TraceContext {
  return { traceId: ambient.traceId, spanId: ambient.spanId, traceFlags: ambient.traceFlags };
}

/**
 * Owns the ambient trace and answers the two questions the rest of the library
 * asks about tracing: what goes on this record, and what goes on this request.
 */
export class TraceEngine {
  /**
   * The trace every record joins until something rotates it.
   *
   * Instance state, never module state. Two runtimes in one document must not
   * share a trace id, and a suite whose files share one would have each test
   * depend on the order the files happened to run in.
   */
  private ambient: AmbientTrace = mintAmbient();

  /**
   * @param diagnostics Where a fault in the OTel API is reported. None of that API is ours, so
   * every call into it is guarded rather than trusted.
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
   * An active OpenTelemetry span always wins, so browser records join the host
   * application's traces the moment it runs an SDK, with no configuration on
   * either side.
   *
   * A span whose context is unusable falls through to the ambient trace instead
   * of shipping an all-zero id that correlates with nothing. `isSpanContextValid`
   * makes that judgement rather than a hand-rolled check, because it is OTel's
   * own definition of unusable and because the SDK types every field of a span
   * context as present, leaving nothing here to test for by hand.
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

    // Checked on read rather than on a timer. A timer would hold this instance
    // alive for the life of the document and would rotate traces in a tab
    // nobody has touched for an hour, which is work and wakeups spent to change
    // an id that no record was going to carry.
    if (Date.now() - this.ambient.startedAt > this.maxAgeMs) {
      this.rotate("maxAge");
    }
    return toTraceContext(this.ambient);
  }

  /**
   * Begin a new logical operation, so that records from here on form a new trace.
   *
   * @param _reason Why the trace rotated. Deliberately unused today, and kept
   * anyway: it is the shape every call site already reads by, and it is what a
   * rotation diagnostic or a rotations-per-reason metric would carry the moment
   * either is wanted. Dropping it now would mean touching every caller then, to
   * recover a fact the caller currently knows and this method would not.
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
   * `traceparent` on a third-party request forces a CORS preflight that the
   * third party will not answer, and their API then stops working inside the
   * consumer's application, which is the worst place for a fault of ours to
   * surface.
   *
   * A propagator the host registered gets first refusal, because it knows about
   * tracestate, baggage and vendor headers this library has never heard of. Only
   * when it writes nothing is the header built here, and it is built from
   * `resolve`, which is what keeps the header on a request and the records
   * describing that same request pointing at one trace. Minting a fresh id here
   * instead is the bug this arrangement exists to prevent: the header would
   * match no record ever emitted, and the advertised log-to-backend correlation
   * would quietly do nothing.
   */
  headers(): Record<string, string> {
    const carrier: Record<string, string> = {};
    this.diagnostics.guard("trace.otel_failed", "injecting OpenTelemetry headers", () => {
      propagation.inject(otelContext.active(), carrier);
    });
    if (!carrier.traceparent) {
      const ctx = this.resolve();
      // trace-flags is a two-hex-digit bitfield, not a boolean. Bit zero is
      // sampled, further bits are already defined and more will be added, so the
      // field is masked to its byte and printed as two digits. Collapsing it to
      // 00 or 01 instead silently discards every flag an upstream tracer set.
      const flags = (ctx.traceFlags & TRACE_FLAGS_MASK).toString(16).padStart(2, "0");
      carrier.traceparent = `${TRACEPARENT_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
    }
    return carrier;
  }
}

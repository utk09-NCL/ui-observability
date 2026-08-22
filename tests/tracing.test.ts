import { trace as otelTrace, propagation, type Span, type SpanContext } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import { newSpanId, newTraceId, TraceEngine } from "../src/utils/tracing";

/** Zero throttle, so a count can be read back on the same tick it was reported. */
const diagnostics = (): Diagnostics => new Diagnostics(vi.fn(), 0);

/** Ids the W3C spec would accept, kept here rather than generated so assertions can name them. */
const VALID_TRACE_ID = "a".repeat(32);
const VALID_SPAN_ID = "b".repeat(16);

/**
 * A span that reports the given context. Structurally typed rather than
 * constructed, because the only method under test here is `spanContext`.
 */
const spanReporting = (spanContext: SpanContext): Span =>
  ({ spanContext: () => spanContext }) as unknown as Span;

/** Install an active span for one test. `restoreMocks` in the Vitest config removes it afterwards. */
const activeSpan = (span: Span): void => {
  vi.spyOn(otelTrace, "getActiveSpan").mockReturnValue(span);
};

describe("newTraceId and newSpanId", () => {
  it("mint the widths the W3C format fixes, in lower-case hex", () => {
    // A twenty-eight character trace id is accepted by every type in this
    // library and silently dropped by the backend.
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("mint a different value each time", () => {
    expect(newTraceId()).not.toBe(newTraceId());
    expect(newSpanId()).not.toBe(newSpanId());
  });
});

describe("TraceEngine.resolve", () => {
  it("keeps one trace id across consecutive records, and changes it on rotate", () => {
    // The whole point of the module. One id per record would give every trace
    // in the backend exactly one span, and correlation would silently do
    // nothing while looking entirely healthy.
    const engine = new TraceEngine(diagnostics());
    const first = engine.resolve();
    const second = engine.resolve();

    expect(second.traceId).toBe(first.traceId);
    expect(second.spanId).toBe(first.spanId);

    engine.rotate("interaction");

    expect(engine.resolve().traceId).not.toBe(first.traceId);
  });

  it("prefers an active OpenTelemetry span over the ambient trace", () => {
    const engine = new TraceEngine(diagnostics());
    const ambient = engine.resolve().traceId;
    activeSpan(
      spanReporting({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        traceFlags: 1,
      }),
    );

    const resolved = engine.resolve();

    expect(resolved.traceId).toBe(VALID_TRACE_ID);
    expect(resolved.spanId).toBe(VALID_SPAN_ID);
    expect(resolved.traceId).not.toBe(ambient);
  });

  it("carries the host span's flags through rather than assuming it was sampled", () => {
    const engine = new TraceEngine(diagnostics());
    activeSpan(
      spanReporting({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        traceFlags: 0,
      }),
    );

    expect(engine.resolve().traceFlags).toBe(0);
  });

  it("falls back to the ambient trace when the active span reports an unusable context", () => {
    // An all-zero id is what a span that was never started reports. Passing it
    // through would put records on a trace that correlates with nothing, which
    // is worse than the ambient trace it would have used anyway.
    const engine = new TraceEngine(diagnostics());
    const ambient = engine.resolve().traceId;
    activeSpan(
      spanReporting({
        traceId: "0".repeat(32),
        spanId: VALID_SPAN_ID,
        traceFlags: 1,
      }),
    );

    expect(engine.resolve().traceId).toBe(ambient);
  });

  it("falls back to the ambient trace and reports when reading the span throws", () => {
    // The OTel API is a global somebody else registered. It is guarded rather
    // than trusted, and a fault in it must cost the trace fields, not the record.
    const reporter = diagnostics();
    const engine = new TraceEngine(reporter);
    const ambient = engine.resolve().traceId;
    activeSpan({
      spanContext: () => {
        throw new Error("span context unavailable");
      },
    } as unknown as Span);

    expect(engine.resolve().traceId).toBe(ambient);
    expect(reporter.snapshot()["capture.install_failed"]).toBe(1);
  });

  it("rotates on its own once the ambient trace passes the configured age", () => {
    vi.useFakeTimers();
    const engine = new TraceEngine(diagnostics(), 1000);
    const first = engine.resolve().traceId;

    vi.advanceTimersByTime(999);
    expect(engine.resolve().traceId).toBe(first);

    vi.advanceTimersByTime(2);
    expect(engine.resolve().traceId).not.toBe(first);
  });

  it("hands back a copy, so a caller cannot age or rewrite the ambient trace", () => {
    const engine = new TraceEngine(diagnostics());
    const resolved = engine.resolve();

    resolved.traceId = "tampered";

    expect(engine.resolve().traceId).not.toBe("tampered");
  });
});

describe("TraceEngine.rotate", () => {
  it("returns the trace it just started, and that trace is what the next record joins", () => {
    const engine = new TraceEngine(diagnostics());

    const rotated = engine.rotate("navigation");

    expect(rotated.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(engine.resolve().traceId).toBe(rotated.traceId);
  });

  it("mints a new span id as well as a new trace id", () => {
    const engine = new TraceEngine(diagnostics());
    const before = engine.resolve();

    const after = engine.rotate("explicit");

    expect(after.spanId).not.toBe(before.spanId);
  });
});

describe("TraceEngine.headers", () => {
  it("emits a W3C traceparent matching the context a record would carry", () => {
    // The bug this pins down: an earlier design minted a fresh id here, so the
    // header on the request matched no record ever emitted and the advertised
    // log-to-backend correlation quietly did nothing.
    const engine = new TraceEngine(diagnostics());
    const ctx = engine.resolve();

    expect(engine.headers().traceparent).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it("prints trace-flags as two hex digits, keeping flags a boolean would discard", () => {
    // trace-flags is a bitfield whose further bits are already defined.
    // Collapsing it to sampled or not would pass every other test in this file.
    const engine = new TraceEngine(diagnostics());
    activeSpan(
      spanReporting({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        traceFlags: 0x03,
      }),
    );

    expect(engine.headers().traceparent).toBe(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-03`);
  });

  it("leaves a header a host propagator wrote exactly as it found it", () => {
    // The host's propagator knows about tracestate, baggage and vendor headers
    // this library has never heard of, so it gets first refusal and its answer
    // is never overwritten.
    const fromHost = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;
    vi.spyOn(propagation, "inject").mockImplementation((_context, carrier) => {
      (carrier as Record<string, string>).traceparent = fromHost;
    });
    const engine = new TraceEngine(diagnostics());

    expect(engine.headers().traceparent).toBe(fromHost);
  });

  it("still produces a header when the host propagator throws", () => {
    const reporter = diagnostics();
    vi.spyOn(propagation, "inject").mockImplementation(() => {
      throw new Error("propagator exploded");
    });
    const engine = new TraceEngine(reporter);

    expect(engine.headers().traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(reporter.snapshot()["capture.install_failed"]).toBe(1);
  });
});

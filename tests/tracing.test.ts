import { trace as otelTrace, propagation, type Span, type SpanContext } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import type { OtelApi, OtelSpan } from "../src/models/config";
import { newSpanId, newTraceId, type SpanHooks, TraceEngine } from "../src/utils/tracing";

/** No throttle. A test can read a count back in the same tick as the report. */
const diagnostics = (): Diagnostics => new Diagnostics(vi.fn(), 0);

/** Ids that the W3C specification accepts. They are constants here. Assertions can name them. */
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

/** Makes an engine that loads the real API through an `otelLoader`. */
const loaded = async (
  reporter: Diagnostics = diagnostics(),
  maxAgeMs?: number,
): Promise<TraceEngine> => {
  const engine = new TraceEngine(reporter, maxAgeMs, () => import("@opentelemetry/api"));
  await engine.loadOtel();
  return engine;
};

/** A structural stand-in for the optional peer, so a test needs nothing installed. */
const fakeApi = (span: OtelSpan | undefined): OtelApi => ({
  trace: { getActiveSpan: () => span },
  context: { active: () => ({}) },
  propagation: { inject: () => undefined },
});

describe("newTraceId and newSpanId", () => {
  it("mint the widths the W3C format fixes, in lower-case hex", () => {
    // Each type in this library accepts a trace id of twenty-eight characters. The backend drops it
    // with no message.
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
    // This is the purpose of the module. With one id for each record, each trace in the backend has
    // exactly one span. Correlation then does nothing, but it looks healthy.
    const engine = new TraceEngine(diagnostics());
    const first = engine.resolve();
    const second = engine.resolve();

    expect(second.traceId).toBe(first.traceId);
    expect(second.spanId).toBe(first.spanId);

    engine.rotate("interaction");

    expect(engine.resolve().traceId).not.toBe(first.traceId);
  });

  it("prefers an active OpenTelemetry span over the ambient trace", async () => {
    const engine = await loaded();
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

  it("carries the host span's flags through rather than assuming it was sampled", async () => {
    const engine = await loaded();
    activeSpan(
      spanReporting({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        traceFlags: 0,
      }),
    );

    expect(engine.resolve().traceFlags).toBe(0);
  });

  it("falls back to the ambient trace when the active span reports an unusable context", async () => {
    // A span that never started reports an all-zero id. If the engine passes it on, records go on a
    // trace that correlates with nothing. That is worse than the ambient trace that the engine uses
    // in its place.
    const engine = await loaded();
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

  it("falls back to the ambient trace and reports when reading the span throws", async () => {
    // Another party registered the OTel API as a global. The engine guards it and does not trust
    // it. A fault in it must cost the trace fields, not the record.
    const reporter = diagnostics();
    const engine = await loaded(reporter);
    const ambient = engine.resolve().traceId;
    activeSpan({
      spanContext: () => {
        throw new Error("span context unavailable");
      },
    } as unknown as Span);

    expect(engine.resolve().traceId).toBe(ambient);
    expect(reporter.snapshot()["trace.otel_failed"]).toBe(1);
  });

  it("carries on when the OpenTelemetry package is not installed", async () => {
    // The package is an optional peer. A consumer that did not ask for it must still get trace ids.
    // The library must tell the consumer one time why the ids are its own.
    const reporter = diagnostics();
    const engine = new TraceEngine(reporter, undefined, () =>
      Promise.reject(new Error("Cannot find module '@opentelemetry/api'")),
    );

    await engine.loadOtel();

    expect(engine.resolve().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(engine.headers().traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(reporter.snapshot()["trace.otel_failed"]).toBe(1);
  });

  it("imports nothing and reports nothing without a loader", async () => {
    // The Vite dev server fails on a bare import of a peer that is not installed.
    // OTel loads only through otelLoader.
    const reporter = diagnostics();
    const engine = new TraceEngine(reporter);
    const ambient = engine.resolve().traceId;
    activeSpan(
      spanReporting({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        traceFlags: 1,
      }),
    );

    await engine.loadOtel();

    expect(engine.resolve().traceId).toBe(ambient);
    expect(reporter.snapshot()["trace.otel_failed"]).toBeUndefined();
  });

  it("takes the OpenTelemetry API from a supplied loader", async () => {
    const engine = new TraceEngine(diagnostics(), undefined, () =>
      Promise.resolve(
        fakeApi({
          spanContext: () => ({
            traceId: VALID_TRACE_ID,
            spanId: VALID_SPAN_ID,
            traceFlags: 1,
          }),
        }),
      ),
    );

    await engine.loadOtel();

    expect(engine.resolve().traceId).toBe(VALID_TRACE_ID);
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
    // This test finds this bug. An earlier design made a new id here. The header on the request
    // matched no record. The log-to-backend correlation then did nothing with no sign.
    const engine = new TraceEngine(diagnostics());
    const ctx = engine.resolve();

    expect(engine.headers().traceparent).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it("prints trace-flags as two hex digits, keeping flags a boolean would discard", async () => {
    // trace-flags is a bitfield. Its other bits also have definitions. A change to only sampled or
    // not sampled passes each other test in this file.
    const engine = await loaded();
    activeSpan(
      spanReporting({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        traceFlags: 0x03,
      }),
    );

    expect(engine.headers().traceparent).toBe(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-03`);
  });

  it("leaves a header a host propagator wrote exactly as it found it", async () => {
    // The propagator of the host knows tracestate, baggage and vendor headers that this library
    // does not know. It goes first. The engine never replaces its answer.
    const fromHost = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`;
    vi.spyOn(propagation, "inject").mockImplementation((_context, carrier) => {
      (carrier as Record<string, string>).traceparent = fromHost;
    });
    const engine = await loaded();

    expect(engine.headers().traceparent).toBe(fromHost);
  });

  it("still produces a header when the host propagator throws", async () => {
    const reporter = diagnostics();
    vi.spyOn(propagation, "inject").mockImplementation(() => {
      throw new Error("propagator exploded");
    });
    const engine = await loaded(reporter);

    expect(engine.headers().traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(reporter.snapshot()["trace.otel_failed"]).toBe(1);
  });
});

describe("TraceEngine spans", () => {
  /**
   * Builds span hooks with spies.
   * @param keeps Result of the sampling decision.
   * @returns The hooks.
   */
  const hooks = (keeps = true) => ({
    enabled: () => true,
    keeps: () => keeps,
    onEnd: vi.fn<SpanHooks["onEnd"]>(),
  });

  /**
   * Splits a traceparent value.
   * @param headers Header map.
   * @returns The trace id, the span id and the flags.
   */
  const parts = (headers: Record<string, string>): string[] =>
    headers.traceparent.split("-").slice(1);

  it("ends the root span one time on rotate, with the cause of the start of the trace", () => {
    const spans = hooks();
    const engine = new TraceEngine(diagnostics(), undefined, undefined, spans);
    const first = engine.resolve();

    engine.rotate("interaction");
    engine.end();
    engine.end();
    engine.rotate("explicit");

    expect(spans.onEnd.mock.calls.map(([ended]) => ended)).toEqual([
      expect.objectContaining({ traceId: first.traceId, spanId: first.spanId, reason: "start" }),
      expect.objectContaining({ reason: "interaction" }),
    ]);
  });

  it("names a new client span in the traceparent of a request, with the root span as parent", () => {
    const engine = new TraceEngine(diagnostics(), undefined, undefined, hooks());
    const root = engine.resolve();

    const { headers, span } = engine.request();

    expect(span).toMatchObject({ traceId: root.traceId, parentSpanId: root.spanId });
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span?.spanId).not.toBe(root.spanId);
    expect(parts(headers)).toEqual([root.traceId, span?.spanId, "01"]);
    // getTraceHeaders() names the root span.
    expect(engine.headers().traceparent).toBe(`00-${root.traceId}-${root.spanId}-01`);
  });

  it("clears the sampled flag of a trace that sampling drops, and gives no span", () => {
    const engine = new TraceEngine(diagnostics(), undefined, undefined, hooks(false));
    const root = engine.resolve();

    const { headers, span } = engine.request();

    expect(parts(headers)[0]).toBe(root.traceId);
    expect(parts(headers)[2]).toBe("00");
    expect(span).toBeUndefined();
  });

  it("gives no span without span hooks, or with spans off", () => {
    const off: SpanHooks = { enabled: () => false, keeps: () => true, onEnd: vi.fn() };

    expect(new TraceEngine(diagnostics()).request().span).toBeUndefined();
    expect(
      new TraceEngine(diagnostics(), undefined, undefined, off).request().span,
    ).toBeUndefined();
  });

  it("gives no span for a trace of the OpenTelemetry peer", async () => {
    const engine = new TraceEngine(
      diagnostics(),
      undefined,
      () =>
        Promise.resolve(
          fakeApi({
            spanContext: () => ({ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 }),
          }),
        ),
      hooks(),
    );
    await engine.loadOtel();

    const { headers, span } = engine.request();

    expect(parts(headers)).toEqual([VALID_TRACE_ID, VALID_SPAN_ID, "01"]);
    expect(span).toBeUndefined();
  });
});

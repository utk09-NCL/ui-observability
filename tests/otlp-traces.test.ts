import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { rootSpan, spanFields } from "../src/core/spans";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import { otlpTracesSerializer } from "../src/transport/serializers/otlp-traces";
import { batchKind, endpointFor, serializeBatch } from "../src/transport/serializers/select";

const TIME = "1755543600123000000";

const TRACE_ID = "a".repeat(32);
const ROOT_ID = "b".repeat(16);
const CLIENT_ID = "c".repeat(16);

/**
 * Builds a span record.
 * @param attributes Attributes over the span type.
 * @param over Record fields over the base.
 * @returns The record.
 */
const span = (attributes: Record<string, unknown>, over: Partial<LogRecord> = {}): LogRecord => ({
  timeUnixNano: TIME,
  traceId: TRACE_ID,
  spanId: CLIENT_ID,
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "GET",
  attributes: { "log.type": "span", ...attributes },
  resource: { "service.name": "svc" },
  ...over,
});

/** The spans of the first resource and scope of one serialize call. */
const spans = (records: LogRecord[]): Record<string, unknown>[] =>
  (
    JSON.parse(otlpTracesSerializer.serialize(records).body) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    }
  ).resourceSpans[0].scopeSpans[0].spans;

const config = (over: Partial<ObservabilityConfig> = {}) =>
  resolveConfig(
    { endpoint: "https://x/v1/logs", serviceName: "svc", ...over },
    new Diagnostics(vi.fn(), 0),
  );

const batchOf = (records: LogRecord[]): LogBatch => ({
  id: "b1",
  createdAt: 0,
  attempts: 0,
  records,
});

describe("rootSpan and spanFields", () => {
  it("name the root span by the cause of the start of the trace", () => {
    const ended = { traceId: TRACE_ID, spanId: ROOT_ID, startedAt: 1000, endedAt: 2000 };

    expect(
      (["start", "interaction", "navigation", "explicit", "maxAge"] as const).map(
        (reason) => rootSpan({ ...ended, reason }).name,
      ),
    ).toEqual(["ui.start", "ui.interaction", "ui.navigation", "ui.trace", "ui.trace"]);
    expect(rootSpan({ ...ended, reason: "start" })).toMatchObject({
      kind: "internal",
      traceId: TRACE_ID,
      spanId: ROOT_ID,
      parentSpanId: "",
      startMs: 1000,
      endMs: 2000,
      error: false,
    });
  });

  it("write the times in nanoseconds with microseconds kept, and the status", () => {
    const root = rootSpan({
      traceId: TRACE_ID,
      spanId: ROOT_ID,
      reason: "start",
      startedAt: 0,
      endedAt: 0,
    });

    expect(
      spanFields({ ...root, startMs: 1_755_543_600_123.5, endMs: 1_755_543_600_124, error: true }),
    ).toEqual({
      "span.kind": "internal",
      "span.parent_id": "",
      "span.start_time_unix_nano": "1755543600123500000",
      "span.end_time_unix_nano": "1755543600124000000",
      "span.status": "error",
    });
    expect(spanFields(root)["span.status"]).toBe("unset");
  });
});

describe("otlpTracesSerializer", () => {
  it("writes a client span with its parent, its kind, its times and its status", () => {
    const [client] = spans([
      span({
        "span.kind": "client",
        "span.parent_id": ROOT_ID,
        "span.start_time_unix_nano": "1",
        "span.end_time_unix_nano": "2",
        "span.status": "error",
        "http.request.method": "GET",
      }),
    ]);

    expect(client).toEqual({
      traceId: TRACE_ID,
      spanId: CLIENT_ID,
      parentSpanId: ROOT_ID,
      name: "GET",
      kind: 3,
      startTimeUnixNano: "1",
      endTimeUnixNano: "2",
      attributes: [{ key: "http.request.method", value: { stringValue: "GET" } }],
      status: { code: 2 },
    });
  });

  it("leaves out the parent of a root span, and uses the record time for a lost time field", () => {
    const [root] = spans([
      span(
        { "span.kind": "internal", "span.parent_id": "" },
        { spanId: ROOT_ID, body: "ui.start" },
      ),
    ]);

    expect(root).not.toHaveProperty("parentSpanId");
    expect(root).toMatchObject({
      name: "ui.start",
      kind: 1,
      startTimeUnixNano: TIME,
      endTimeUnixNano: TIME,
      attributes: [],
      status: { code: 0 },
    });
  });
});

describe("batchKind and endpointFor for spans", () => {
  const tracesEndpoint = "https://x/v1/traces";

  it("give a batch of span records the kind traces, with or without tracesEndpoint", () => {
    const log = span({ "log.type": "log" });

    expect(batchKind(batchOf([span({})]), config({ tracesEndpoint }))).toBe("traces");
    expect(batchKind(batchOf([span({})]), config())).toBe("traces");
    expect(batchKind(batchOf([span({}), log]), config({ tracesEndpoint }))).toBe("logs");
  });

  it("give tracesEndpoint for a traces batch, and an empty string without it", () => {
    expect(endpointFor("traces", config({ tracesEndpoint }))).toBe(tracesEndpoint);
    expect(endpointFor("traces", config())).toBe("");
    expect(endpointFor("logs", config())).toBe("https://x/v1/logs");
  });

  it("give a traces batch the OTLP traces format", () => {
    const serialized = serializeBatch(
      config({ tracesEndpoint }),
      batchOf([span({})]),
      new Diagnostics(vi.fn(), 0),
      "failed",
    );

    expect(Object.keys(JSON.parse(serialized?.body ?? "{}"))).toEqual(["resourceSpans"]);
  });
});

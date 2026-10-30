import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import { otlpMetricsSerializer } from "../src/transport/serializers/otlp-metrics";
import { batchKind, serializeBatch } from "../src/transport/serializers/select";

const TIME = "1755543600123000000";
const START = "1755543590123000000";

const record = (attributes: Record<string, unknown>, over: Partial<LogRecord> = {}): LogRecord => ({
  timeUnixNano: TIME,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "orders",
  attributes: { "log.type": "metric", "session.id": "s1", ...attributes },
  resource: { "service.name": "svc" },
  ...over,
});

const counterPoint = (value: number, attributes: Record<string, unknown> = {}): LogRecord =>
  record({
    ...attributes,
    "metric.name": "orders",
    "metric.unit": "count",
    "metric.type": "counter",
    "metric.value": value,
    "metric.start_time_unix_nano": START,
    "metric.attribute_keys": Object.keys(attributes),
  });

const histogramPoint = (over: Record<string, unknown> = {}): LogRecord =>
  record({
    "metric.name": "latency",
    "metric.unit": "ms",
    "metric.type": "histogram",
    "metric.start_time_unix_nano": START,
    "metric.attribute_keys": [],
    "metric.count": 3,
    "metric.sum": 60,
    "metric.min": 5,
    "metric.max": 40,
    "metric.bounds": [10, 100],
    "metric.bucket_counts": [1, 2, 0],
    ...over,
  });

/** The parsed payload of one serialize call. */
const payload = (records: LogRecord[]): any =>
  JSON.parse(otlpMetricsSerializer.serialize(records).body);

/** The metrics of the first resource and scope. */
const metrics = (records: LogRecord[]): any[] =>
  payload(records).resourceMetrics[0].scopeMetrics[0].metrics;

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

describe("otlpMetricsSerializer", () => {
  it("writes a counter as a monotonic delta sum with the attributes of the call only", () => {
    const [metric] = metrics([
      counterPoint(3, { venue: "LSE" }),
      counterPoint(4, { venue: "NYSE" }),
    ]);

    expect(metric).toEqual({
      name: "orders",
      unit: "count",
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [
          {
            attributes: [{ key: "venue", value: { stringValue: "LSE" } }],
            startTimeUnixNano: START,
            timeUnixNano: TIME,
            asDouble: 3,
          },
          {
            attributes: [{ key: "venue", value: { stringValue: "NYSE" } }],
            startTimeUnixNano: START,
            timeUnixNano: TIME,
            asDouble: 4,
          },
        ],
      },
    });
  });

  it("marks a sum with a negative value as not monotonic", () => {
    // A logMetric counter has no check of its sign.
    const [metric] = metrics([counterPoint(-1)]);

    expect(metric.sum.isMonotonic).toBe(false);
  });

  it("writes a histogram with string counts and its boundaries", () => {
    const [metric] = metrics([histogramPoint()]);

    expect(metric.histogram).toEqual({
      aggregationTemporality: 1,
      dataPoints: [
        {
          attributes: [],
          startTimeUnixNano: START,
          timeUnixNano: TIME,
          count: "3",
          sum: 60,
          min: 5,
          max: 40,
          bucketCounts: ["1", "2", "0"],
          explicitBounds: [10, 100],
        },
      ],
    });
  });

  it("sets no sum on a histogram point with a negative value", () => {
    // OTLP: a histogram with a negative value must not set sum.
    const [aggregated] = metrics([histogramPoint({ "metric.min": -5, "metric.sum": 50 })]);
    const [single] = metrics([
      record({ "metric.type": "histogram", "metric.value": -3, "metric.attribute_keys": [] }),
    ]);

    expect(aggregated.histogram.dataPoints[0]).not.toHaveProperty("sum");
    expect(aggregated.histogram.dataPoints[0]).toMatchObject({ count: "3", min: -5 });
    expect(single.histogram.dataPoints[0]).not.toHaveProperty("sum");
    expect(single.histogram.dataPoints[0]).toMatchObject({ count: "1", min: -3 });
  });

  it("writes a logMetric histogram as one value in one bucket, from the time of the record", () => {
    const single = record({
      "metric.name": "load.duration",
      "metric.type": "histogram",
      "metric.value": 12,
      "metric.attribute_keys": ["status"],
      status: "SUCCESS",
    });

    const [metric] = metrics([single]);

    expect(metric.histogram.dataPoints[0]).toMatchObject({
      attributes: [{ key: "status", value: { stringValue: "SUCCESS" } }],
      startTimeUnixNano: TIME,
      count: "1",
      sum: 12,
      bucketCounts: ["1"],
      explicitBounds: [],
    });
  });

  it("writes a gauge, and any unknown type as a gauge", () => {
    const gauge = record({ "metric.name": "rows", "metric.type": "gauge", "metric.value": 42 });
    const odd = record({ "metric.name": "odd", "metric.type": "summary", "metric.value": 1 });

    const written = metrics([gauge, odd]);

    expect(written.map((metric) => Object.keys(metric))).toEqual([
      ["name", "unit", "gauge"],
      ["name", "unit", "gauge"],
    ]);
    expect(written[0].gauge.dataPoints[0].asDouble).toBe(42);
  });

  it("joins the points of one name, type and unit into one metric", () => {
    const written = metrics([
      counterPoint(1),
      histogramPoint(),
      counterPoint(2),
      record({
        "metric.name": "orders",
        "metric.type": "counter",
        "metric.unit": "By",
        "metric.value": 5,
      }),
    ]);

    expect(written.map((metric) => [metric.name, metric.unit])).toEqual([
      ["orders", "count"],
      ["latency", "ms"],
      ["orders", "By"],
    ]);
    expect(written[0].sum.dataPoints).toHaveLength(2);
  });

  it("uses the body as the name and no unit when the record has neither", () => {
    const [metric] = metrics([record({ "metric.type": "gauge", "metric.value": 1 })]);

    expect(metric).toMatchObject({ name: "orders", unit: "" });
  });

  it("drops a point without a valid value, and a histogram with a cut list", () => {
    const written = metrics([
      record({ "metric.type": "gauge", "metric.value": "1" }),
      record({ "metric.type": "histogram" }),
      histogramPoint({ "metric.bucket_counts": [1, 2] }),
      histogramPoint({ "metric.bounds": "10,100" }),
      histogramPoint({ "metric.bucket_counts": [1, Number.NaN, 0] }),
    ]);

    expect(written).toEqual([]);
  });

  it("keeps only string, number and boolean values of the named keys", () => {
    const point = record({
      "metric.type": "gauge",
      "metric.value": 1,
      "metric.attribute_keys": ["a", "b", "c", "d", 7, "missing", "metric.type"],
      a: "x",
      b: 2,
      c: true,
      d: { nested: 1 },
    });

    const keys = metrics([point])[0].gauge.dataPoints[0].attributes.map((one: any) => one.key);

    expect(keys).toEqual(["a", "b", "c"]);
  });

  it("gives a point no attributes when the record names no keys", () => {
    const point = record({ "metric.type": "gauge", "metric.value": 1, venue: "LSE" });

    expect(metrics([point])[0].gauge.dataPoints[0].attributes).toEqual([]);
  });

  it("groups the points by resource, with the scope of the library", () => {
    const child = record(
      { "metric.type": "gauge", "metric.value": 1 },
      { resource: { "service.name": "child" } },
    );

    const written = payload([counterPoint(1), child]);

    expect(written.resourceMetrics).toHaveLength(2);
    expect(written.resourceMetrics[1].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "child" } },
    ]);
    expect(written.resourceMetrics[0].scopeMetrics[0].scope.name).toBe("@utk09/ui-observability");
  });
});

describe("batchKind", () => {
  const metricsEndpoint = "https://x/v1/metrics";

  it("is metrics for a batch of metric records with metricsEndpoint set", () => {
    expect(batchKind(batchOf([counterPoint(1)]), config({ metricsEndpoint }))).toBe("metrics");
  });

  it("is logs without metricsEndpoint, for a mixed batch, for an empty batch and for a corrupt record", () => {
    const log = record({ "log.type": "log" });

    expect(batchKind(batchOf([counterPoint(1)]), config())).toBe("logs");
    expect(batchKind(batchOf([counterPoint(1), log]), config({ metricsEndpoint }))).toBe("logs");
    expect(batchKind(batchOf([]), config({ metricsEndpoint }))).toBe("logs");
    expect(batchKind(batchOf([null as never]), config({ metricsEndpoint }))).toBe("logs");
  });
});

describe("serializeBatch", () => {
  it("gives a metrics batch the OTLP metrics format and a logs batch the log format", () => {
    const resolved = config({ metricsEndpoint: "https://x/v1/metrics" });
    const diagnostics = new Diagnostics(vi.fn(), 0);

    const forMetrics = serializeBatch(resolved, batchOf([counterPoint(1)]), diagnostics, "failed");
    const forLogs = serializeBatch(
      resolved,
      batchOf([record({ "log.type": "log" })]),
      diagnostics,
      "failed",
    );

    expect(Object.keys(JSON.parse(forMetrics?.body ?? "{}"))).toEqual(["resourceMetrics"]);
    expect(Object.keys(JSON.parse(forLogs?.body ?? "{}"))).toEqual(["resourceLogs"]);
  });
});

// src/transport/serializers/otlp-metrics.ts
//
// This module serializes metric records as an OTLP/JSON ExportMetricsServiceRequest. The transport
// uses it only for a batch of metric records when metricsEndpoint is set.

import {
  CONTENT_TYPE_JSON,
  METRIC_KEYS,
  SERIALIZER_NAME_OTLP,
  TELEMETRY_SDK_NAME,
  TELEMETRY_SDK_VERSION,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";
import { groupByResource, toKeyValues } from "./otlp";

/** OTLP AggregationTemporality DELTA. Each point holds the change since the previous point. */
const DELTA = 1;

/** OTLP field of each metric type. A type that is not a counter or a histogram is a gauge. */
type MetricField = "sum" | "histogram" | "gauge";

/** One OTLP data point. */
type DataPoint = Record<string, unknown>;

/** Data points of one metric name, type and unit. */
interface MetricEntry {
  /** Metric name. */
  name: string;
  /** Unit of the values. */
  unit: string;
  /** OTLP field of the type. */
  field: MetricField;
  /** Data points. */
  points: DataPoint[];
}

/**
 * Reads a finite number attribute.
 * @param record Metric record.
 * @param key Attribute key.
 * @returns The number, or undefined.
 */
function numberOf(record: LogRecord, key: string): number | undefined {
  const value: unknown = record.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Tests if a value is a list of finite numbers.
 * @param value Attribute value.
 * @returns True for a list of finite numbers.
 */
function isNumbers(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "number" && Number.isFinite(item))
  );
}

/**
 * Reads the point attributes that the call of the app gave. The context attributes of the record
 * stay out. A session id on each point makes a new series for each session.
 * @param record Metric record.
 * @returns The string, number and boolean attributes that `metric.attribute_keys` names.
 */
function pointAttributes(record: LogRecord): Record<string, unknown> {
  const keys: unknown = record.attributes[METRIC_KEYS.attributeKeys];
  const out: Record<string, unknown> = {};

  if (!Array.isArray(keys)) {
    return out;
  }

  for (const key of keys as unknown[]) {
    // A key of the call can have the name of a metric field. That field holds the value of
    // the library.
    const named = typeof key === "string" && !key.startsWith("metric.");
    const value: unknown = named ? record.attributes[key] : undefined;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key as string] = value;
    }
  }

  return out;
}

/**
 * Builds the histogram fields of a point.
 * @param record Metric record.
 * @returns The fields, or null for a point that a record limit cut.
 */
function histogramOf(record: LogRecord): DataPoint | null {
  const count = numberOf(record, METRIC_KEYS.count);

  // A logMetric histogram holds one value. It has one bucket and no boundaries.
  if (count === undefined) {
    const value = numberOf(record, "metric.value");
    return value === undefined
      ? null
      : {
          count: "1",
          sum: value < 0 ? undefined : value,
          min: value,
          max: value,
          bucketCounts: ["1"],
          explicitBounds: [],
        };
  }

  const bounds: unknown = record.attributes[METRIC_KEYS.bounds];
  const buckets: unknown = record.attributes[METRIC_KEYS.buckets];

  // maxArrayLength can cut a list. A point with a cut list gives false buckets.
  if (!isNumbers(bounds) || !isNumbers(buckets) || buckets.length !== bounds.length + 1) {
    return null;
  }

  // OTLP: a histogram with a negative value sets no sum. A backend reads the sum as a total.
  const min = numberOf(record, METRIC_KEYS.min);

  return {
    count: String(count),
    sum: min !== undefined && min < 0 ? undefined : numberOf(record, METRIC_KEYS.sum),
    min,
    max: numberOf(record, METRIC_KEYS.max),
    // OTLP JSON encodes an int64 as a decimal string.
    bucketCounts: buckets.map(String),
    explicitBounds: bounds,
  };
}

/**
 * Builds the value field of a sum or gauge point.
 * @param record Metric record.
 * @returns The field, or null for a record without a valid value.
 */
function numberPointOf(record: LogRecord): DataPoint | null {
  const value = numberOf(record, "metric.value");
  return value === undefined ? null : { asDouble: value };
}

/**
 * Builds one OTLP data point.
 * @param record Metric record.
 * @param field OTLP field of the type.
 * @returns The point, or null for a record without a valid value.
 */
function pointOf(record: LogRecord, field: MetricField): DataPoint | null {
  const start: unknown = record.attributes[METRIC_KEYS.start];
  const values = field === "histogram" ? histogramOf(record) : numberPointOf(record);

  if (values === null) {
    return null;
  }

  return {
    attributes: toKeyValues(pointAttributes(record)),
    // A logMetric record has no interval. Its point starts and ends at its time.
    startTimeUnixNano: typeof start === "string" ? start : record.timeUnixNano,
    timeUnixNano: record.timeUnixNano,
    ...values,
  };
}

/**
 * Builds the OTLP metric of an entry.
 * @param entry Data points of one name, type and unit.
 * @returns The OTLP metric.
 */
function metricOf({ name, unit, field, points }: MetricEntry): Record<string, unknown> {
  if (field === "gauge") {
    return { name, unit, gauge: { dataPoints: points } };
  }

  const data: Record<string, unknown> = { aggregationTemporality: DELTA, dataPoints: points };

  // A logMetric counter can hold a negative value. A monotonic sum must not decrease.
  if (field === "sum") {
    data.isMonotonic = points.every((point) => (point.asDouble as number) >= 0);
  }

  return { name, unit, [field]: data };
}

/** This serializer writes metric records as an OTLP/JSON ExportMetricsServiceRequest. */
export const otlpMetricsSerializer: LogSerializer = {
  /** This field holds the format name. */
  name: SERIALIZER_NAME_OTLP,

  /**
   * Groups the records by resource, then by metric name, type and unit. It drops a record
   * without a valid value.
   * @param records Metric records to serialize.
   * @returns Serialized JSON payload.
   */
  serialize(records: LogRecord[]): SerializedBatch {
    const resourceMetrics = groupByResource(records).map((group) => {
      const entries = new Map<string, MetricEntry>();

      for (const record of group.records) {
        const type: unknown = record.attributes["metric.type"];
        const field: MetricField =
          type === "counter" ? "sum" : type === "histogram" ? "histogram" : "gauge";
        const point = pointOf(record, field);

        if (point === null) {
          continue;
        }

        const named: unknown = record.attributes["metric.name"];
        const unit: unknown = record.attributes["metric.unit"];
        const entry: MetricEntry = {
          name: typeof named === "string" ? named : record.body,
          unit: typeof unit === "string" ? unit : "",
          field,
          points: [],
        };
        const key = JSON.stringify([entry.field, entry.name, entry.unit]);
        const found = entries.get(key) ?? entry;

        found.points.push(point);
        entries.set(key, found);
      }

      return {
        resource: { attributes: toKeyValues(group.resource) },
        scopeMetrics: [
          {
            scope: { name: TELEMETRY_SDK_NAME, version: TELEMETRY_SDK_VERSION },
            metrics: [...entries.values()].map(metricOf),
          },
        ],
      };
    });

    return {
      body: JSON.stringify({ resourceMetrics }),
      contentType: CONTENT_TYPE_JSON,
    };
  },
};

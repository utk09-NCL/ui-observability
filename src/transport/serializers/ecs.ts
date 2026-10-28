// src/transport/serializers/ecs.ts
//
// This module serializes log batches as Elastic Common Schema (ECS) newline-delimited JSON.

import {
  ATTR_PAGE_URL,
  ATTR_URL_FULL,
  CONTENT_TYPE_NDJSON,
  ECS_LEVEL_NAMES,
  NANOS_PATTERN,
  NANOS_PER_MILLI,
  RESOURCE_BROWSER_USER_AGENT,
  RESOURCE_DEPLOYMENT_ENVIRONMENT,
  RESOURCE_SERVICE_NAME,
  RESOURCE_SERVICE_VERSION,
  SERIALIZER_NAME_ECS,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";

/**
 * Converts a nanosecond epoch string to epoch milliseconds. A record from the
 * bus has passed only a shape check. BigInt throws a SyntaxError on a non-numeric string.
 * That error loses the whole batch, not one record.
 * @param timeUnixNano Nanosecond epoch as decimal digits.
 * @returns Epoch milliseconds, or the current time when the input is not numeric.
 */
function toMillis(timeUnixNano: string): number {
  if (!NANOS_PATTERN.test(timeUnixNano)) {
    return Date.now();
  }

  return Number(BigInt(timeUnixNano) / NANOS_PER_MILLI);
}

/** Elasticsearch maps these value types under `labels` without a dynamic mapping conflict. */
type LabelValue = string | number | boolean;

/**
 * Converts a value to its label form.
 * @param value Raw attribute or resource value.
 * @returns Scalar label value, or null when the value has no scalar form.
 */
function toLabelValue(value: unknown): LabelValue | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  // JSON.stringify throws on a BigInt. That error loses the whole batch.
  if (typeof value === "bigint") {
    return value.toString();
  }

  return null;
}

/**
 * Writes one label. It folds a repeated key into an array. Elasticsearch reads
 * a repeated leaf as one multi-valued field. An array of objects maps the same way.
 * @param labels Label map that the function builds.
 * @param key Dotted label key.
 * @param value Scalar label value.
 */
function pushLabel(labels: Record<string, unknown>, key: string, value: LabelValue): void {
  const existing = labels[key];

  if (existing === undefined) {
    labels[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    (existing as LabelValue[]).push(value);
    return;
  }

  labels[key] = [existing, value];
}

/**
 * Flattens one value into dotted label keys. ECS `labels` is a flat map. A
 * nested object under it causes an Elasticsearch dynamic mapping conflict.
 * @param labels Label map that the function builds.
 * @param key Dotted key for this value.
 * @param value Value to flatten.
 * @param seen Active ancestor objects. This set stops infinite recursion on a cycle.
 */
function flattenLabel(
  labels: Record<string, unknown>,
  key: string,
  value: unknown,
  seen: WeakSet<object>,
): void {
  const scalar = toLabelValue(value);

  if (scalar !== null) {
    pushLabel(labels, key, scalar);
    return;
  }

  // A forwarded record has passed only a shape check. Its attributes can contain a cycle.
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      flattenLabel(labels, key, item, seen);
    }
  } else {
    for (const [name, entry] of Object.entries(value)) {
      flattenLabel(labels, `${key}.${name}`, entry, seen);
    }
  }

  // Remove the object on unwind. If not, a repeated sibling reads as a cycle.
  seen.delete(value);
}

/**
 * Flattens an attribute or resource map into ECS labels.
 * @param source Attribute or resource map.
 * @returns Flat label map keyed by dotted path.
 */
function toLabels(source: Record<string, unknown>): Record<string, unknown> {
  // Use a null prototype. An attribute named `__proto__` must become a key, not a prototype.
  const labels: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const seen = new WeakSet();

  for (const [key, value] of Object.entries(source)) {
    flattenLabel(labels, key, value, seen);
  }

  return labels;
}

/** This serializer writes log records as Elastic Common Schema (ECS) NDJSON documents. */
export const ecsSerializer: LogSerializer = {
  /** This field holds the format name. */
  name: SERIALIZER_NAME_ECS,

  /**
   * Serializes log records into newline-delimited ECS JSON documents.
   * @param records Records to serialize.
   * @returns Serialized NDJSON batch payload.
   */
  serialize(records: LogRecord[]): SerializedBatch {
    const lines = records.map((record) => {
      const millis = toMillis(record.timeUnixNano);

      return JSON.stringify({
        "@timestamp": new Date(millis).toISOString(),
        message: record.body,
        log: { level: ECS_LEVEL_NAMES[record.severityText] ?? record.severityText.toLowerCase() },
        trace: { id: record.traceId },
        span: { id: record.spanId },
        service: {
          name: record.resource[RESOURCE_SERVICE_NAME],
          version: record.resource[RESOURCE_SERVICE_VERSION],
          environment: record.resource[RESOURCE_DEPLOYMENT_ENVIRONMENT],
        },
        user_agent: { original: record.resource[RESOURCE_BROWSER_USER_AGENT] },
        // Use the request URL of a captured network event before the page URL.
        url: {
          full: record.attributes[ATTR_URL_FULL] ?? record.attributes[ATTR_PAGE_URL],
        },
        // Spread the attributes last. A record attribute overrides a resource key with the same
        // name.
        labels: { ...toLabels(record.resource), ...toLabels(record.attributes) },
      });
    });

    return { body: `${lines.join("\n")}\n`, contentType: CONTENT_TYPE_NDJSON };
  },
};

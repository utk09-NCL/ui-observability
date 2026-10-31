// src/transport/serializers/ecs.ts
//
// This module serializes log batches as Elastic Common Schema (ECS) newline-delimited JSON.

import {
  ATTR_APP_NAMESPACE,
  ATTR_LOG_TYPE,
  ATTR_PAGE_URL,
  ATTR_URL_FULL,
  CONTENT_TYPE_NDJSON,
  ECS_LEVEL_NAMES,
  ECS_VERSION,
  LOG_TYPE_METRIC,
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

/** ECS field of each error attribute. */
const ERROR_FIELDS = {
  "error.type": "type",
  "error.message": "message",
  "error.stack_trace": "stack_trace",
} as const;

/** Attribute keys that a string value moves to an ECS field. They then leave labels. */
const MAPPED_KEYS = new Set<string>([ATTR_APP_NAMESPACE, ...Object.keys(ERROR_FIELDS)]);

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

/**
 * Builds the ECS error field from the error attributes.
 * @param attributes Record attributes.
 * @returns The field, or undefined for a record without a string error attribute.
 */
function errorOf(attributes: Record<string, unknown>): Record<string, string> | undefined {
  const fields: [string, string][] = [];

  for (const [key, field] of Object.entries(ERROR_FIELDS)) {
    const value = attributes[key];
    if (typeof value === "string") {
      fields.push([field, value]);
    }
  }

  return fields.length > 0 ? Object.fromEntries(fields) : undefined;
}

/**
 * Removes the attributes that have an ECS field. A label copy of a stack trace doubles the size.
 * @param attributes Record attributes.
 * @returns The attributes for labels.
 */
function unmapped(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, value]) => !(MAPPED_KEYS.has(key) && typeof value === "string"),
    ),
  );
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

      const { attributes } = record;
      const logger = attributes[ATTR_APP_NAMESPACE];

      // JSON.stringify leaves out an undefined field.
      return JSON.stringify({
        "@timestamp": new Date(millis).toISOString(),
        message: record.body,
        ecs: { version: ECS_VERSION },
        log: {
          level: ECS_LEVEL_NAMES[record.severityText] ?? record.severityText.toLowerCase(),
          logger: typeof logger === "string" ? logger : undefined,
        },
        event: { kind: attributes[ATTR_LOG_TYPE] === LOG_TYPE_METRIC ? "metric" : "event" },
        error: errorOf(attributes),
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
          full: attributes[ATTR_URL_FULL] ?? attributes[ATTR_PAGE_URL],
        },
        // Spread the attributes last. A record attribute overrides a resource key with the same
        // name.
        labels: { ...toLabels(record.resource), ...toLabels(unmapped(attributes)) },
      });
    });

    return { body: `${lines.join("\n")}\n`, contentType: CONTENT_TYPE_NDJSON };
  },
};

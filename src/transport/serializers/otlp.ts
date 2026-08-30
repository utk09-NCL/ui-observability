// src/transport/serializers/otlp.ts
//
// Serializes log batches into OpenTelemetry (OTLP/JSON) formatted log records grouped by resource.

import {
  CONTENT_TYPE_JSON,
  SERIALIZER_NAME_OTLP,
  TELEMETRY_SDK_NAME,
  TELEMETRY_SDK_VERSION,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";

/** OTLP AnyValue container with typed value wrappers. */
type AnyValue = Record<string, unknown>;

/** OTLP KeyValue pair container. */
interface KeyValue {
  /** Attribute key. */
  key: string;
  /** Typed AnyValue container. */
  value: AnyValue;
}

/** Records grouped by shared resource attributes. */
interface ResourceGroup {
  /** Resource attribute map. */
  resource: Record<string, unknown>;
  /** Log records associated with the resource. */
  records: LogRecord[];
}

/**
 * Wraps a JavaScript value in an OTLP AnyValue container.
 * @param value Raw attribute or resource value.
 * @returns Typed AnyValue object or null if unsupported.
 */
function toAnyValue(value: unknown): AnyValue | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return { stringValue: value };
  }

  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  // Encodes int64 as decimal strings per OTLP protobuf JSON specification. A number
  // is a silent 400 from a conforming collector.
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }

  // Converts BigInt to decimal string representation for JSON serialization.
  // JSON.stringify throws on a BigInt and loses the batch.
  if (typeof value === "bigint") {
    return { intValue: value.toString() };
  }

  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    const values = items.map(toAnyValue).filter((item): item is AnyValue => item !== null);

    return { arrayValue: { values } };
  }

  if (typeof value === "object") {
    const nested = value as Record<string, unknown>;
    return { kvlistValue: { values: toKeyValues(nested) } };
  }

  return null;
}

/**
 * Converts a plain object into an array of OTLP KeyValue pairs.
 * @param source Key-value attribute object.
 * @returns Array of valid KeyValue pairs.
 */
function toKeyValues(source: Record<string, unknown>): KeyValue[] {
  const out: KeyValue[] = [];

  for (const [key, raw] of Object.entries(source)) {
    const value = toAnyValue(raw);
    if (value) {
      out.push({ key, value });
    }
  }

  return out;
}

/** Memoized JSON string keys per resource object to avoid redundant stringification. */
const resourceKeys = new WeakMap<object, string>();

/**
 * Computes or retrieves a stable serialization key for a resource object.
 * @param resource Resource attribute object.
 * @returns JSON key string.
 */
function resourceKey(resource: Record<string, unknown>): string {
  const cached = resourceKeys.get(resource);
  if (cached !== undefined) {
    return cached;
  }

  const key = JSON.stringify(resource);
  resourceKeys.set(resource, key);

  return key;
}

/** Serializer formatting log records into OTLP/JSON payloads. */
export const otlpSerializer: LogSerializer = {
  /** Format identifier name. */
  name: SERIALIZER_NAME_OTLP,

  /**
   * Groups records by resource and encodes them into an OTLP ExportLogsServiceRequest JSON payload.
   * @param records Array of log records to serialize.
   * @returns Serialized JSON batch payload.
   */
  serialize(records: LogRecord[]): SerializedBatch {
    const groups = new Map<string, ResourceGroup>();

    for (const record of records) {
      const key = resourceKey(record.resource);
      const group = groups.get(key);

      if (group) {
        group.records.push(record);
        continue;
      }

      groups.set(key, { resource: record.resource, records: [record] });
    }

    const resourceLogs = [...groups.values()].map((group) => ({
      resource: { attributes: toKeyValues(group.resource) },
      scopeLogs: [
        {
          scope: { name: TELEMETRY_SDK_NAME, version: TELEMETRY_SDK_VERSION },
          logRecords: group.records.map((record) => ({
            timeUnixNano: record.timeUnixNano,
            // Falls back to timeUnixNano if observedTimeUnixNano is unset.
            observedTimeUnixNano: record.observedTimeUnixNano ?? record.timeUnixNano,
            severityNumber: record.severityNumber,
            severityText: record.severityText,
            body: { stringValue: record.body },
            traceId: record.traceId,
            spanId: record.spanId,
            flags: record.traceFlags,
            attributes: toKeyValues(record.attributes),
          })),
        },
      ],
    }));

    return {
      body: JSON.stringify({ resourceLogs }),
      contentType: CONTENT_TYPE_JSON,
    };
  },
};

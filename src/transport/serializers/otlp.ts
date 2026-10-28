// src/transport/serializers/otlp.ts
//
// This module serializes log batches as OTLP/JSON log records. It groups the records by resource.

import {
  CONTENT_TYPE_JSON,
  SERIALIZER_NAME_OTLP,
  TELEMETRY_SDK_NAME,
  TELEMETRY_SDK_VERSION,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";

/** This type holds an OTLP AnyValue with typed value wrappers. */
type AnyValue = Record<string, unknown>;

/** This interface holds an OTLP KeyValue pair. */
interface KeyValue {
  /** This field holds the attribute key. */
  key: string;
  /** This field holds the typed AnyValue. */
  value: AnyValue;
}

/** This interface holds the records that share resource attributes. */
interface ResourceGroup {
  /** This field holds the resource attribute map. */
  resource: Record<string, unknown>;
  /** This field holds the log records of the resource. */
  records: LogRecord[];
}

/**
 * Wraps a JavaScript value in an OTLP AnyValue.
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

  // Encode int64 as a decimal string. The OTLP protobuf JSON mapping requires it. A conforming
  // collector returns a 400 status for a number. The response does not give the cause.
  // An integer above MAX_SAFE_INTEGER goes to doubleValue. Its text can be "1e+21" or overflow int64.
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }

  // Convert a BigInt to a decimal string. JSON.stringify throws on a BigInt and loses the
  // batch.
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
 * Converts a plain object to an array of OTLP KeyValue pairs.
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

/** This map caches the JSON key of each resource object. It prevents a repeated stringify. */
const resourceKeys = new WeakMap<object, string>();

/**
 * Returns the stable JSON key of a resource object. It caches the key.
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

/** This serializer writes log records as OTLP/JSON payloads. */
export const otlpSerializer: LogSerializer = {
  /** This field holds the format name. */
  name: SERIALIZER_NAME_OTLP,

  /**
   * Groups records by resource. It encodes them as an OTLP
   * ExportLogsServiceRequest JSON payload.
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
            // Use timeUnixNano when observedTimeUnixNano is not set.
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

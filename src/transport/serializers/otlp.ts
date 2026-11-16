// src/transport/serializers/otlp.ts
//
// Serializes log batches as OTLP/JSON log records. Records are grouped by resource, and each
// logger namespace gets its own instrumentation scope.
// The OTLP metrics serializer reuses the value encoding and the resource grouping from here.

import {
  ATTR_APP_NAMESPACE,
  CONTENT_TYPE_JSON,
  SERIALIZER_NAME_OTLP,
  TELEMETRY_SDK_NAME,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";

/** An OTLP AnyValue with typed value wrappers. */
type AnyValue = Record<string, unknown>;

/** An OTLP KeyValue pair. */
export interface KeyValue {
  /** The attribute key. */
  key: string;
  /** The typed AnyValue. */
  value: AnyValue;
}

/** Records that share the same resource attributes. */
export interface ResourceGroup {
  /** The resource attribute map. */
  resource: Record<string, unknown>;
  /** The resource's log records. */
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

  // Encode int64 as a decimal string, as the OTLP protobuf JSON mapping requires. A conforming
  // collector answers a number with a 400 status, and the response doesn't give the cause.
  // An integer above MAX_SAFE_INTEGER goes to doubleValue, because its text can be "1e+21" or
  // overflow int64.
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }

  // Convert a BigInt to a decimal string. JSON.stringify throws on a BigInt and would lose
  // the batch.
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
export function toKeyValues(source: Record<string, unknown>): KeyValue[] {
  const out: KeyValue[] = [];

  for (const [key, raw] of Object.entries(source)) {
    const value = toAnyValue(raw);
    if (value) {
      out.push({ key, value });
    }
  }

  return out;
}

/** Caches the JSON key of every resource object, which avoids a repeated stringify. */
const resourceKeys = new WeakMap<object, string>();

/**
 * Returns the stable JSON key of a resource object, and caches it.
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

/**
 * Groups records by their resource attributes, keeping the record order within each group.
 * @param records Records to group.
 * @returns One group per resource.
 */
export function groupByResource(records: LogRecord[]): ResourceGroup[] {
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

  return [...groups.values()];
}

/** The records of one instrumentation scope. */
export interface ScopeGroup {
  /** The scope name, which is the logger namespace. */
  name: string;
  /** The scope's records. */
  records: LogRecord[];
}

/**
 * Groups records by their logger namespace, keeping the record order within each group.
 * A record without a namespace goes to the library's own scope.
 * @param records Records of one resource.
 * @returns One group per namespace.
 */
export function groupByScope(records: LogRecord[]): ScopeGroup[] {
  const groups = new Map<string, LogRecord[]>();

  for (const record of records) {
    const namespace: unknown = record.attributes[ATTR_APP_NAMESPACE];
    const name = typeof namespace === "string" && namespace ? namespace : TELEMETRY_SDK_NAME;
    const group = groups.get(name);

    if (group) {
      group.push(record);
      continue;
    }

    groups.set(name, [record]);
  }

  return [...groups].map(([name, scoped]) => ({ name, records: scoped }));
}

/** Writes log records as OTLP/JSON payloads. */
export const otlpSerializer: LogSerializer = {
  /** The format name. */
  name: SERIALIZER_NAME_OTLP,

  /**
   * Groups records by resource and encodes them as an OTLP
   * ExportLogsServiceRequest JSON payload.
   * @param records Array of log records to serialize.
   * @returns Serialized JSON batch payload.
   */
  serialize(records: LogRecord[]): SerializedBatch {
    const resourceLogs = groupByResource(records).map((group) => ({
      resource: { attributes: toKeyValues(group.resource) },
      scopeLogs: groupByScope(group.records).map((scope) => ({
        scope: { name: scope.name },
        logRecords: scope.records.map((record) => ({
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
      })),
    }));

    return {
      body: JSON.stringify({ resourceLogs }),
      contentType: CONTENT_TYPE_JSON,
    };
  },
};

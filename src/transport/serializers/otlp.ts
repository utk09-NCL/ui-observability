// src/transport/serializers/otlp.ts
//
// OTLP/JSON. Attributes are a list of pairs, each value tagged with its type,
// and the resource block is hoisted out of the records. A batch can hold
// records from several resources, so grouping is per resource, not per batch.

import {
  CONTENT_TYPE_JSON,
  SERIALIZER_NAME_OTLP,
  TELEMETRY_SDK_NAME,
  TELEMETRY_SDK_VERSION,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";

/** One OTLP value: a single-key object naming its type, such as `{ stringValue: "buy" }`. */
type AnyValue = Record<string, unknown>;

/** One entry of an OTLP attribute list. */
interface KeyValue {
  /** Attribute name. */
  key: string;
  /** Attribute value, in its type wrapper. */
  value: AnyValue;
}

/** The records of one batch that share a resource, and that resource. */
interface ResourceGroup {
  /** Sent once for the whole group. */
  resource: Record<string, unknown>;
  /** The records carrying it. */
  records: LogRecord[];
}

/**
 * One value in its OTLP type wrapper, or null when OTLP has no field for it.
 *
 * int64 is encoded as a string. Getting that wrong is a silent 400.
 *
 * @param value An attribute or resource value.
 */
function toAnyValue(value: unknown): AnyValue | null {
  if (value === null || value === undefined) {
    return null;
  }

  // Sequential typeof checks, not a switch: a switch over `unknown` is never
  // exhaustive, and each check narrows `value` in place.
  if (typeof value === "string") {
    return { stringValue: value };
  }

  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }

  // A structured clone from another realm carries a bigint through untouched,
  // and JSON.stringify throws on one.
  if (typeof value === "bigint") {
    return { intValue: value.toString() };
  }

  if (Array.isArray(value)) {
    // Array.isArray narrows an unknown to any[], so widen before reading elements.
    const items: readonly unknown[] = value;
    const values = items.map(toAnyValue).filter((item): item is AnyValue => item !== null);

    return { arrayValue: { values } };
  }

  if (typeof value === "object") {
    const nested = value as Record<string, unknown>;
    return { kvlistValue: { values: toKeyValues(nested) } };
  }

  // Symbol or function, the only types left. JSON.stringify drops both from an
  // object, so dropping them here keeps the payload consistent with it.
  return null;
}

/**
 * An object as an OTLP attribute list, minus the keys with no representable value.
 *
 * @param source Attributes or a resource block.
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

/**
 * Grouping keys, memoized per resource object.
 *
 * The record builder stamps one cached object onto every record from a context,
 * so this costs one stringify per resource rather than one per record.
 */
const resourceKeys = new WeakMap<object, string>();

/**
 * A stable key for one resource block.
 *
 * @param resource The block hoisted out of a record.
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

/** OpenTelemetry logs over HTTP, JSON encoding. */
export const otlpSerializer: LogSerializer = {
  /** The name a consumer selects this format by. */
  name: SERIALIZER_NAME_OTLP,

  /**
   * Group by resource, then encode. Records forwarded from an iframe carry a
   * different resource from the parent's, so never assume one group.
   *
   * @param records The batch's records.
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
            // Some collectors reject an empty observed time, and only a
            // forwarded record has one that genuinely differs.
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

    return { body: JSON.stringify({ resourceLogs }), contentType: CONTENT_TYPE_JSON };
  },
};

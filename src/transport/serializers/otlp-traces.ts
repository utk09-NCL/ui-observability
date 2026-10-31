// src/transport/serializers/otlp-traces.ts
//
// This module serializes span records as an OTLP/JSON ExportTraceServiceRequest. The transport
// uses it for a batch of span records.

import {
  ATTR_LOG_TYPE,
  CONTENT_TYPE_JSON,
  SERIALIZER_NAME_OTLP,
  SPAN_KEYS,
  TELEMETRY_SDK_NAME,
  TELEMETRY_SDK_VERSION,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";
import { groupByResource, toKeyValues } from "./otlp";

/** OTLP SpanKind of each span kind of the library. */
const SPAN_KIND = { internal: 1, client: 3 } as const;

/** OTLP StatusCode ERROR. */
const STATUS_ERROR = 2;

/** OTLP StatusCode UNSET. */
const STATUS_UNSET = 0;

/** Attribute keys that hold span fields. They are not span attributes. */
const FIELD_KEYS = new Set<string>([ATTR_LOG_TYPE, ...Object.values(SPAN_KEYS)]);

/**
 * Reads a string attribute.
 * @param record Span record.
 * @param key Attribute key.
 * @returns The string, or undefined.
 */
function stringOf(record: LogRecord, key: string): string | undefined {
  const value: unknown = record.attributes[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Builds one OTLP span. A record that lost a time field starts and ends at its record time.
 * @param record Span record.
 * @returns The OTLP span.
 */
function spanOf(record: LogRecord): Record<string, unknown> {
  const attributes = Object.fromEntries(
    Object.entries(record.attributes).filter(([key]) => !FIELD_KEYS.has(key)),
  );
  const parent = stringOf(record, SPAN_KEYS.parentId);

  return {
    traceId: record.traceId,
    spanId: record.spanId,
    // A root span has no parent. Leave the field out.
    ...(parent ? { parentSpanId: parent } : {}),
    name: record.body,
    kind: stringOf(record, SPAN_KEYS.kind) === "client" ? SPAN_KIND.client : SPAN_KIND.internal,
    startTimeUnixNano: stringOf(record, SPAN_KEYS.start) ?? record.timeUnixNano,
    endTimeUnixNano: stringOf(record, SPAN_KEYS.end) ?? record.timeUnixNano,
    attributes: toKeyValues(attributes),
    status: {
      code: stringOf(record, SPAN_KEYS.status) === "error" ? STATUS_ERROR : STATUS_UNSET,
    },
  };
}

/** This serializer writes span records as an OTLP/JSON ExportTraceServiceRequest. */
export const otlpTracesSerializer: LogSerializer = {
  /** This field holds the format name. */
  name: SERIALIZER_NAME_OTLP,

  /**
   * Groups the records by resource.
   * @param records Span records to serialize.
   * @returns Serialized JSON payload.
   */
  serialize(records: LogRecord[]): SerializedBatch {
    const resourceSpans = groupByResource(records).map((group) => ({
      resource: { attributes: toKeyValues(group.resource) },
      scopeSpans: [
        {
          scope: { name: TELEMETRY_SDK_NAME, version: TELEMETRY_SDK_VERSION },
          spans: group.records.map(spanOf),
        },
      ],
    }));

    return {
      body: JSON.stringify({ resourceSpans }),
      contentType: CONTENT_TYPE_JSON,
    };
  },
};

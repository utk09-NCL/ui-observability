// src/transport/serializers/ecs.ts
//
// Elastic Common Schema, newline-delimited JSON, one document per record.
// A rename plus two conversions: nanoseconds to an ISO timestamp, and the
// level to lower case. Here so a gateway that does not speak OTLP costs one
// config value rather than a change upstream of the serializer.

import {
  ATTR_PAGE_URL,
  ATTR_URL_FULL,
  CONTENT_TYPE_NDJSON,
  NANOS_PER_MILLI,
  RESOURCE_BROWSER_USER_AGENT,
  RESOURCE_DEPLOYMENT_ENVIRONMENT,
  RESOURCE_SERVICE_NAME,
  RESOURCE_SERVICE_VERSION,
  SERIALIZER_NAME_ECS,
} from "../../constants";
import type { LogRecord } from "../../models/log-record";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";

/** Elastic Common Schema over a bulk ingest endpoint. */
export const ecsSerializer: LogSerializer = {
  /** The name a consumer selects this format by. */
  name: SERIALIZER_NAME_ECS,

  /**
   * One JSON document per record. Resource and attributes are also copied into
   * `labels`, so a field with no ECS name stays searchable. Attributes win a
   * collision, being the more specific of the two.
   *
   * @param records The batch's records.
   */
  serialize(records: LogRecord[]): SerializedBatch {
    const lines = records.map((record) => {
      // Divide as a bigint, then convert. A nanosecond timestamp is past what a
      // double holds exactly, so converting first can land the wrong millisecond.
      const millis = Number(BigInt(record.timeUnixNano) / NANOS_PER_MILLI);

      return JSON.stringify({
        "@timestamp": new Date(millis).toISOString(),
        message: record.body,
        log: { level: record.severityText.toLowerCase() },
        trace: { id: record.traceId },
        span: { id: record.spanId },
        service: {
          name: record.resource[RESOURCE_SERVICE_NAME],
          version: record.resource[RESOURCE_SERVICE_VERSION],
          environment: record.resource[RESOURCE_DEPLOYMENT_ENVIRONMENT],
        },
        user_agent: { original: record.resource[RESOURCE_BROWSER_USER_AGENT] },
        // The request this record is about, falling back to the page it was
        // logged from. The other way round rewrites a captured request to the
        // document that made it.
        url: { full: record.attributes[ATTR_URL_FULL] ?? record.attributes[ATTR_PAGE_URL] },
        labels: { ...record.resource, ...record.attributes },
      });
    });

    return { body: `${lines.join("\n")}\n`, contentType: CONTENT_TYPE_NDJSON };
  },
};

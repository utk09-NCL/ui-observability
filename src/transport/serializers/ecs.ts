// src/transport/serializers/ecs.ts
//
// Serializes log batches into Elastic Common Schema (ECS) formatted newline-delimited JSON.

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

/** Serializer formatting log records into Elastic Common Schema (ECS) NDJSON documents. */
export const ecsSerializer: LogSerializer = {
  /** Format identifier name. */
  name: SERIALIZER_NAME_ECS,

  /**
   * Serializes an array of log records into newline-delimited ECS JSON documents.
   * @param records Records to serialize.
   * @returns Serialized NDJSON batch payload.
   */
  serialize(records: LogRecord[]): SerializedBatch {
    const lines = records.map((record) => {
      // BigInt division preserves precision before conversion to millisecond Date.
      // No double holds a nanosecond epoch exactly.
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
        // Prefers request URL over ambient page URL for captured network events.
        url: {
          full: record.attributes[ATTR_URL_FULL] ?? record.attributes[ATTR_PAGE_URL],
        },
        labels: { ...record.resource, ...record.attributes },
      });
    });

    return { body: `${lines.join("\n")}\n`, contentType: CONTENT_TYPE_NDJSON };
  },
};

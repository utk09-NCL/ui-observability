// src/transport/serializers/select.ts
//
// This module maps the serializer option to an implementation. Only transport code imports
// this module. config.ts keeps only the name. The main chunk then contains no serializer.

import { ATTR_LOG_TYPE } from "../../constants";
import type { Diagnostics } from "../../core/diagnostics";
import { attributeOf, type LogBatch } from "../../models/batch";
import type { BatchKind, ResolvedConfig, SerializerChoice } from "../../models/config";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";
import { ecsSerializer } from "./ecs";
import { otlpSerializer } from "./otlp";
import { otlpMetricsSerializer } from "./otlp-metrics";

/**
 * Returns the implementation for a resolved serializer option.
 * @param choice Serializer name, or a custom implementation.
 * @returns Serializer implementation.
 */
export function serializerFor(choice: SerializerChoice): LogSerializer {
  if (choice === "otlp") {
    return otlpSerializer;
  }

  if (choice === "ecs") {
    return ecsSerializer;
  }

  return choice;
}

/**
 * Gives the kind of a batch. Only a batch of metric records goes to metricsEndpoint. A stored
 * record can be corrupt. It then is not a metric.
 * @param batch Batch to test.
 * @param config Active configuration.
 * @returns "metrics" with metricsEndpoint set and only metric records, else "logs".
 */
export function batchKind(batch: LogBatch, config: ResolvedConfig): BatchKind {
  const metrics =
    config.metricsEndpoint !== "" &&
    batch.records.length > 0 &&
    batch.records.every((record) => attributeOf(record, ATTR_LOG_TYPE) === "metric");

  return metrics ? "metrics" : "logs";
}

/**
 * Serializes a batch. It reports a serializer that throws, and the caller drops the batch.
 * A metrics batch gets the OTLP metrics format.
 * @param config Active configuration.
 * @param batch Batch to serialize.
 * @param diagnostics Diagnostics reporter.
 * @param message ASD-STE100 sentence for the report.
 * @returns The serialized batch, or undefined if the serializer threw.
 */
export function serializeBatch(
  config: ResolvedConfig,
  batch: LogBatch,
  diagnostics: Diagnostics,
  message: string,
): SerializedBatch | undefined {
  try {
    const serializer =
      batchKind(batch, config) === "metrics"
        ? otlpMetricsSerializer
        : serializerFor(config.serializer);
    return serializer.serialize(batch.records);
  } catch (error) {
    diagnostics.report("transport.serialize_failed", message, { batchId: batch.id }, error);
    return undefined;
  }
}

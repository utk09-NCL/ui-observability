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
import { otlpTracesSerializer } from "./otlp-traces";

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
 * Gives the kind of a batch. Only a batch of metric records goes to metricsEndpoint. A batch of
 * span records is always "traces". It must not go to endpoint as log records. A stored record
 * can be corrupt. It then is not a metric or a span.
 * @param batch Batch to test.
 * @param config Active configuration.
 * @returns "metrics" with metricsEndpoint set and only metric records, "traces" for only span
 * records, else "logs".
 */
export function batchKind(batch: LogBatch, config: ResolvedConfig): BatchKind {
  const only = (type: string): boolean =>
    batch.records.length > 0 &&
    batch.records.every((record) => attributeOf(record, ATTR_LOG_TYPE) === type);

  if (config.metricsEndpoint !== "" && only("metric")) {
    return "metrics";
  }

  return only("span") ? "traces" : "logs";
}

/**
 * Gives the endpoint of a batch kind.
 * @param kind Kind of the batch.
 * @param config Active configuration.
 * @returns metricsEndpoint for a metrics batch, tracesEndpoint for a traces batch, else
 * endpoint. "" means that the batch has no destination.
 */
export function endpointFor(kind: BatchKind, config: ResolvedConfig): string | null {
  if (kind === "metrics") {
    return config.metricsEndpoint;
  }

  return kind === "traces" ? config.tracesEndpoint : config.endpoint;
}

/** Serializer of each batch kind that does not use the configured serializer. */
const SIGNAL_SERIALIZERS: Partial<Record<BatchKind, LogSerializer>> = {
  metrics: otlpMetricsSerializer,
  traces: otlpTracesSerializer,
};

/**
 * Serializes a batch. It reports a serializer that throws, and the caller drops the batch.
 * A metrics batch gets the OTLP metrics format. A traces batch gets the OTLP traces format.
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
      SIGNAL_SERIALIZERS[batchKind(batch, config)] ?? serializerFor(config.serializer);
    return serializer.serialize(batch.records);
  } catch (error) {
    diagnostics.report("transport.serialize_failed", message, { batchId: batch.id }, error);
    return undefined;
  }
}

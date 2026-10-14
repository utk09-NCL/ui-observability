// src/transport/serializers/select.ts
//
// This module maps the serializer option to an implementation. Only transport code imports
// this module. config.ts keeps only the name. The main chunk then contains no serializer.

import type { Diagnostics } from "../../core/diagnostics";
import type { LogBatch } from "../../models/batch";
import type { SerializerChoice } from "../../models/config";
import type { LogSerializer, SerializedBatch } from "../../models/serializer";
import { ecsSerializer } from "./ecs";
import { otlpSerializer } from "./otlp";

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
 * Serializes a batch. It reports a serializer that throws, and the caller drops the batch.
 * @param choice Serializer name, or a custom implementation.
 * @param batch Batch to serialize.
 * @param diagnostics Diagnostics reporter.
 * @param message ASD-STE100 sentence for the report.
 * @returns The serialized batch, or undefined if the serializer threw.
 */
export function serializeBatch(
  choice: SerializerChoice,
  batch: LogBatch,
  diagnostics: Diagnostics,
  message: string,
): SerializedBatch | undefined {
  try {
    return serializerFor(choice).serialize(batch.records);
  } catch (error) {
    diagnostics.report("transport.serialize_failed", message, { batchId: batch.id }, error);
    return undefined;
  }
}

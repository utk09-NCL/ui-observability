// src/transport/serializers/select.ts
//
// Maps the serializer option to an implementation. Only transport code imports this
// module. config.ts keeps the name, so the main chunk holds no serializer.

import type { SerializerChoice } from "../../models/config";
import type { LogSerializer } from "../../models/serializer";
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

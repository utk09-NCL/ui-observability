// src/transport/custom-transport.ts
//
// Sends batches through the transport function that the consumer supplies. The status codes
// have the same meaning as on the HTTP path. Retry, storage and the exit flush do not change.

import {
  HTTP_STATUS_MAX,
  HTTP_STATUS_MIN,
  HTTP_SUCCESS_END,
  HTTP_SUCCESS_MIN,
  REQUEST_TIMEOUT_MS,
} from "../constants";
import type { LogBatch } from "../models/batch";
import type { TransportRequest, TransportResponse } from "../models/config";
import type { SerializedBatch } from "../models/serializer";
import { DeadlineError, withDeadline } from "../utils/deadline";
import { runAsLibraryConsole } from "../utils/library-console";
import { runAsLibraryRequest } from "../utils/library-request";
import { TransportError } from "./errors";
import { StatusTransport } from "./status-transport";

/**
 * Builds the request that a custom transport and its exit hook receive.
 * @param batch Batch to send.
 * @param serialized Serialized form of the batch.
 * @returns The transport request.
 */
export function toTransportRequest(batch: LogBatch, serialized: SerializedBatch): TransportRequest {
  return {
    body: serialized.body,
    contentType: serialized.contentType,
    batchId: batch.id,
    attempt: batch.attempts,
    records: batch.records,
  };
}

/**
 * Tests if a value is a usable transport response.
 * @param value Value that the transport resolved to.
 * @returns True if the value has an integer status from 100 to 599.
 */
function isResponse(value: unknown): value is TransportResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const status: unknown = Reflect.get(value, "status");
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= HTTP_STATUS_MIN &&
    status <= HTTP_STATUS_MAX
  );
}

/**
 * Gives a number hint that the server can use. A string, NaN or Infinity breaks the throttle.
 * @param value Hint that the transport returned.
 * @returns The value, 0 or more, or undefined if it is not a finite number.
 */
function finiteHint(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

/** Sends batches through the consumer's transport function. */
export class CustomTransport extends StatusTransport {
  /**
   * Sends one batch through the configured transport function.
   * @param batch Batch to send.
   * @throws TransportError when the batch is not accepted.
   */
  async send(batch: LogBatch): Promise<void> {
    const { transport } = this.config;

    if (!transport || batch.records.length === 0) {
      return;
    }

    const serialized = this.serialize(batch);

    if (!serialized) {
      return;
    }

    const request = toTransportRequest(batch, serialized);

    let response: unknown;

    try {
      // A transport that never settles holds a dispatch slot. The deadline frees the slot.
      response = await withDeadline(
        // The capture modules skip a request or a console line inside these scopes.
        runAsLibraryRequest(() => runAsLibraryConsole(() => transport(request))),
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // The pipeline reports the thrown error. Classify it here.
      const deadline = error instanceof DeadlineError ? error : undefined;
      const kind = deadline ? "timeout" : "transient";
      const message = deadline?.message ?? "The custom transport failed.";

      throw new TransportError(kind, message, undefined, undefined, undefined, error);
    }

    if (!isResponse(response)) {
      this.diagnostics.report(
        "transport.http_error",
        "The custom transport returned no valid status. The library sends the batch again later.",
        { batchId: batch.id },
      );
      throw new TransportError("transient", "The custom transport returned no valid status.");
    }

    const { status } = response;

    if (status >= HTTP_SUCCESS_MIN && status < HTTP_SUCCESS_END) {
      this.accept(response.sampling);
      return;
    }

    throw this.reject(status, batch.id, {
      retryAfterMs: finiteHint(response.retryAfterMs),
      maxBytes: finiteHint(response.maxBytes),
    });
  }
}

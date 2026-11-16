// src/transport/custom-transport.ts
//
// Sends batches through the consumer's own transport function. Status codes mean the same as
// on the HTTP path, and retry, storage and the exit flush work unchanged.

import { HTTP_STATUS_MAX, HTTP_STATUS_MIN, HTTP_SUCCESS_END, HTTP_SUCCESS_MIN } from "../constants";
import type { LogBatch } from "../models/batch";
import type { BatchKind, TransportRequest, TransportResponse } from "../models/config";
import type { SerializedBatch } from "../models/serializer";
import { DeadlineError, withDeadline } from "../utils/deadline";
import { runAsLibraryConsole } from "../utils/library-console";
import { runAsLibraryRequest, trackTransportCall } from "../utils/library-request";
import { TransportError } from "./errors";
import { batchKind } from "./serializers/select";
import { StatusTransport } from "./status-transport";

/**
 * Builds the request that a custom transport and its exit hook receive.
 * @param batch Batch to send.
 * @param serialized Serialized form of the batch.
 * @param kind Kind of the batch.
 * @returns The transport request.
 */
export function toTransportRequest(
  batch: LogBatch,
  serialized: SerializedBatch,
  kind: BatchKind,
): TransportRequest {
  return {
    kind,
    body: serialized.body,
    contentType: serialized.contentType,
    batchId: batch.id,
    attempt: batch.attempts,
    records: batch.records,
    routingContextId: batch.routingContextId,
  };
}

/**
 * Checks whether a value is a usable transport response.
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
 * Cleans a numeric hint from the transport's response before the library's throttle and
 * batch split use it. A string, NaN or Infinity would break the throttle.
 * @param value Hint that the transport returned.
 * @returns The value, 0 or more, or undefined if it isn't a finite number.
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
    this.assertContext(batch);
    const { transport } = this.config;

    if (!transport || batch.records.length === 0) {
      return;
    }

    const serialized = this.serialize(batch);

    if (!serialized) {
      return;
    }

    const kind = batchKind(batch, this.config);
    const request = toTransportRequest(batch, serialized, kind);
    request.signal = this.cancellation.signal;

    let response: unknown;

    try {
      // A transport that never settles would hold a dispatch slot forever. The deadline frees it.
      response = await withDeadline(
        // Inside these scopes the capture modules skip requests and console lines. A request
        // made after an await falls outside the scopes, and network capture warns about it.
        this.untilCancelled(
          trackTransportCall(() =>
            runAsLibraryRequest(() => runAsLibraryConsole(() => transport(request))),
          ),
        ),
        this.config.delivery.requestTimeoutMs,
      );
    } catch (error) {
      // The pipeline reports the thrown error. All we do here is classify it.
      const deadline = error instanceof DeadlineError ? error : undefined;
      const kind = deadline ? "timeout" : "transient";
      const message = deadline?.message ?? "The custom transport failed.";

      throw new TransportError(kind, message, undefined, undefined, undefined, error);
    }

    this.assertContext(batch);
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
      this.accept(kind, response.sampling, response.date);
      return;
    }

    throw this.reject(status, batch.id, kind, {
      retryAfterMs: finiteHint(response.retryAfterMs),
      maxBytes: finiteHint(response.maxBytes),
    });
  }
}

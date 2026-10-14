// src/transport/status-transport.ts
//
// Holds the parts that the HTTP transport and the custom transport share. A status code then
// has the same meaning on both paths. 2xx accepts the batch. 413 splits it. 429 and 503 throttle.
// 408 and 5xx retry. Each other code drops the batch.

import {
  HTTP_FORBIDDEN,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_REQUEST_TIMEOUT,
  HTTP_SERVER_ERROR_MIN,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  RETRY_BASE_DELAY_MS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { SerializedBatch } from "../models/serializer";
import { TransportError } from "./errors";
import { serializeBatch } from "./serializers/select";

/** The two operations that the pipeline and the retry engine use. */
export interface BatchTransport {
  /**
   * Sends one batch.
   * @param batch Batch to send.
   * @throws TransportError when the batch is not accepted.
   */
  send(batch: LogBatch): Promise<void>;
  /**
   * Returns the remaining throttle delay.
   * @returns Milliseconds until the throttle ends, or 0.
   */
  throttledForMs(): number;
}

/** Hints that come with a rejected batch. */
export interface RejectHints {
  /** Delay that the server asks for, in milliseconds. */
  retryAfterMs?: number;
  /** Largest payload that the server accepts, from a 413 answer. */
  maxBytes?: number;
  /** Extra advice for a 401 or a 403 answer. */
  advice?: string;
}

/** Base class of the HTTP transport and the custom transport. */
export abstract class StatusTransport implements BatchTransport {
  /** Epoch time in milliseconds when the server throttle ends. */
  private throttledUntil = 0;

  /**
   * @param config Active configuration instance.
   * @param diagnostics Diagnostics reporter.
   * @param onSampling Receives the sampling rules of an accepted batch, before validation.
   */
  constructor(
    protected readonly config: ResolvedConfig,
    protected readonly diagnostics: Diagnostics,
    private readonly onSampling: (raw: unknown) => void = () => undefined,
  ) {}

  /**
   * Sends one batch.
   * @param batch Batch to send.
   * @throws TransportError when the batch is not accepted.
   */
  abstract send(batch: LogBatch): Promise<void>;

  /**
   * Returns the remaining throttle delay in milliseconds.
   * @returns Milliseconds remaining in throttle window, or 0 if unthrottled.
   */
  throttledForMs(): number {
    return Math.max(0, this.throttledUntil - Date.now());
  }

  /**
   * Serializes a batch with the configured serializer. It reports a serializer that throws.
   * @param batch Batch to serialize.
   * @returns The serialized batch, or undefined if the serializer threw.
   */
  protected serialize(batch: LogBatch): SerializedBatch | undefined {
    return serializeBatch(
      this.config.serializer,
      batch,
      this.diagnostics,
      "The serializer threw an error. The library dropped the batch.",
    );
  }

  /**
   * Records an accepted batch. It ends a server throttle.
   * @param sampling Sampling rules of the answer, as text or as an object.
   */
  protected accept(sampling: unknown): void {
    this.throttledUntil = 0;

    // Trust only the answer to a batch that the library sent. A null header means no rules.
    if (this.config.sampling.remote && sampling !== undefined && sampling !== null) {
      this.onSampling(sampling);
    }
  }

  /**
   * Converts a status code that is not 2xx into a classified TransportError.
   * @param status Status code of the answer.
   * @param batchId Identifier of the rejected batch.
   * @param hints Delay, size limit and advice that come with the answer.
   * @returns Classified TransportError instance.
   */
  protected reject(status: number, batchId: string, hints: RejectHints): TransportError {
    const code = String(status);

    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      const advice = hints.advice === undefined ? "" : ` ${hints.advice}`;

      this.diagnostics.report(
        "transport.rejected_credentials",
        `The server returned ${code}.${advice}`,
        { status, endpoint: this.config.endpoint },
      );
      // Classify as permanent. A retry loop on a rejected credential blocks each batch after it.
      return new TransportError("permanent", `The server rejected the batch with ${code}.`, status);
    }

    if (status === HTTP_PAYLOAD_TOO_LARGE) {
      return new TransportError(
        "too_large",
        "The payload is too large.",
        status,
        undefined,
        hints.maxBytes,
      );
    }

    if (status === HTTP_TOO_MANY_REQUESTS || status === HTTP_SERVICE_UNAVAILABLE) {
      const throttled = status === HTTP_TOO_MANY_REQUESTS;
      this.throttledUntil = Date.now() + (hints.retryAfterMs ?? RETRY_BASE_DELAY_MS);

      if (throttled) {
        this.diagnostics.report("transport.throttled", "The server throttles the requests.", {
          retryAfterMs: hints.retryAfterMs,
        });
      }

      return new TransportError(
        "throttled",
        throttled ? "The server throttles the requests." : "The service is not available.",
        status,
        hints.retryAfterMs,
      );
    }

    if (status === HTTP_REQUEST_TIMEOUT || status >= HTTP_SERVER_ERROR_MIN) {
      return new TransportError("transient", `The server returned the error ${code}.`, status);
    }

    this.diagnostics.report(
      "transport.dropped_permanent",
      `The server rejected the batch with ${code}. The library dropped it.`,
      { batchId, status },
    );
    return new TransportError("permanent", `The server rejected the batch with ${code}.`, status);
  }
}

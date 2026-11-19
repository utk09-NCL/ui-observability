// src/transport/status-transport.ts
//
// Holds what the HTTP transport and the custom transport share, so a status code means the
// same on both paths. 2xx accepts the batch, 413 splits it, 429 and 503 throttle, and 408 and
// 5xx retry. Any other code drops the batch.

import {
  DATE_HEADER_HALF_STEP_MS,
  HTTP_FORBIDDEN,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_REQUEST_TIMEOUT,
  HTTP_SERVER_ERROR_MIN,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { BatchKind, ResolvedConfig } from "../models/config";
import type { LossReporter } from "../models/drop";
import type { SerializedBatch } from "../models/serializer";
import { TransportError } from "./errors";
import { partialSuccessOf } from "./response-body";
import { batchKind, endpointFor, serializeBatch } from "./serializers/select";

/**
 * Computes the clock offset from an answer's Date header.
 * @param date Value of the Date header. It has whole seconds.
 * @returns Server time minus client time in milliseconds, or undefined without a valid date.
 */
function clockOffset(date: unknown): number | undefined {
  const serverMs = typeof date === "string" ? Date.parse(date) : Number.NaN;

  return Number.isNaN(serverMs)
    ? undefined
    : Math.round(serverMs + DATE_HEADER_HALF_STEP_MS - Date.now());
}

/** The two operations that the pipeline and the retry engine use. */
export interface BatchTransport {
  /**
   * Sends one batch.
   * @param batch Batch to send.
   * @param onKeepalive Runs when one of the batch's requests starts with keepalive.
   * @returns Promise that resolves to the records lost in a send that ends without an error,
   * for example the records a server rejected in an accepted batch.
   * @throws TransportError when the batch isn't accepted.
   */
  send(batch: LogBatch, onKeepalive?: () => void): Promise<number>;
  /**
   * Returns the remaining throttle delay for a batch's endpoint.
   * @param batch Batch to send.
   * @returns Milliseconds until the throttle ends, or 0.
   */
  throttledForMs(batch: LogBatch): number;
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
  /** Abort controller shared by the requests of this delivery context. */
  protected readonly cancellation = new AbortController();
  /** Cancels this context's work. A custom transport receives the same abort signal. */
  stop(): void {
    this.cancellation.abort();
  }

  /**
   * Checks the batch context after every asynchronous step and before a send.
   * @param batch Batch to check.
   * @throws TransportError if the context stopped or the context id doesn't match.
   */
  protected assertContext(batch: LogBatch): void {
    if (
      this.cancellation.signal.aborted ||
      (this.config.securityContext.isolation &&
        this.config.securityContext.id &&
        batch.routingContextId !== this.config.securityContext.id)
    ) {
      this.diagnostics.count("security.context_mismatch");
      throw new TransportError(
        "permanent",
        "The delivery context is inactive or does not match the batch.",
      );
    }
  }

  /**
   * Ends the wait if this context stops before the work completes.
   * @param work Work to wait for.
   * @returns The result of the work.
   * @throws TransportError if this context stops first.
   */
  protected async untilCancelled<T>(work: Promise<T>): Promise<T> {
    if (this.cancellation.signal.aborted) {
      throw new TransportError("permanent", "The delivery context retired.");
    }
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        reject(new TransportError("permanent", "The delivery context retired."));
      };
      this.cancellation.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      this.cancellation.signal.removeEventListener("abort", cancel);
    }
  }
  /**
   * Epoch time in milliseconds when the server throttle ends, per endpoint, so that a 429 from
   * metricsEndpoint doesn't stop the log batches.
   */
  private readonly throttledUntil: Record<BatchKind, number> = { logs: 0, metrics: 0, traces: 0 };

  /** Epoch time in milliseconds when the server last accepted a batch, or null. */
  private acceptedAt: number | null = null;

  /**
   * @param config Active configuration instance.
   * @param diagnostics Diagnostics reporter.
   * @param onSampling Receives an accepted batch's sampling rules, before validation.
   * @param onLoss Receives the records of a batch that the serializer can't encode.
   * @param onClock Receives an accepted batch's clock offset, in milliseconds.
   */
  constructor(
    protected readonly config: ResolvedConfig,
    protected readonly diagnostics: Diagnostics,
    private readonly onSampling: (raw: unknown) => void = () => undefined,
    private readonly onLoss: LossReporter = () => undefined,
    private readonly onClock: (offsetMs: number) => void = () => undefined,
  ) {}

  /**
   * Sends one batch.
   * @param batch Batch to send.
   * @param onKeepalive Runs when one of the batch's requests starts with keepalive.
   * @returns Promise that resolves to the records lost in a send that ends without an error.
   * @throws TransportError when the batch isn't accepted.
   */
  abstract send(batch: LogBatch, onKeepalive?: () => void): Promise<number>;

  /**
   * Returns the remaining throttle delay for a batch's endpoint, in milliseconds.
   * @param batch Batch to send.
   * @returns Milliseconds remaining in throttle window, or 0 if unthrottled.
   */
  throttledForMs(batch: LogBatch): number {
    return Math.max(0, this.throttledUntil[batchKind(batch, this.config)] - Date.now());
  }

  /**
   * Returns when the latest server throttle ends, over all endpoints.
   * @returns Epoch time in milliseconds, or null when no endpoint is throttled now.
   */
  throttleEnd(): number | null {
    const end = Math.max(...Object.values(this.throttledUntil));
    return end > Date.now() ? end : null;
  }

  /**
   * Returns the time when the server last accepted a batch.
   * @returns Epoch time in milliseconds, or null before the first accepted batch.
   */
  lastSendAt(): number | null {
    return this.acceptedAt;
  }

  /**
   * Serializes a batch with the configured serializer. A metrics batch gets the OTLP metrics
   * format. Reports a serializer that throws.
   * @param batch Batch to serialize.
   * @returns The serialized batch, or undefined if the serializer threw.
   */
  protected serialize(batch: LogBatch): SerializedBatch | undefined {
    const serialized = serializeBatch(
      this.config,
      batch,
      this.diagnostics,
      "The serializer threw an error. The library dropped the batch.",
    );

    if (!serialized) {
      this.onLoss("unserializable", batch.records, [batch.id]);
    }

    return serialized;
  }

  /**
   * Records an accepted batch and ends the server throttle for that batch's endpoint.
   * @param kind Kind of the accepted batch.
   * @param sampling The answer's sampling rules, as text or as an object.
   * @param date The answer's Date header. Null when the server doesn't expose it.
   */
  protected accept(kind: BatchKind, sampling: unknown, date: unknown): void {
    this.throttledUntil[kind] = 0;
    this.acceptedAt = Date.now();

    // Only trust the answer to a batch that we sent ourselves. A null header means no rules.
    if (this.config.sampling.remote && sampling !== undefined && sampling !== null) {
      this.onSampling(sampling);
    }

    const offset = clockOffset(date);
    if (offset !== undefined) {
      this.onClock(offset);
    }
  }

  /**
   * Reports what an OTLP server rejected or warned about in a batch it accepted. The batch isn't
   * sent again, because the server kept the other records and a resend would duplicate them.
   * @param batch The accepted batch.
   * @param kind Kind of the batch, which names the count's field.
   * @param body The answer's body text.
   * @returns The number of rejected records, or 0.
   */
  protected reportPartial(batch: LogBatch, kind: BatchKind, body: string): number {
    const partial = this.diagnostics.guard(
      "transport.http_error",
      "The library could not read the body of the 2xx response.",
      () => partialSuccessOf(body, kind),
    );
    if (!partial) {
      return 0;
    }

    const endpoint = endpointFor(kind, this.config);
    // The server only gives a count, so onDrop can't name the journeys or the actions.
    const rejected = Math.min(partial.rejected, batch.records.length);
    if (rejected === 0) {
      this.diagnostics.report(
        "transport.partial_success",
        "The server accepted the batch with a warning.",
        { endpoint, serverMessage: partial.message },
      );
      return 0;
    }

    this.onLoss("partially_rejected", [], [batch.id], rejected);
    const total = String(batch.records.length);
    this.diagnostics.report(
      "transport.partial_success",
      `The server rejected ${String(rejected)} of ${total} records in the batch. ` +
        "The library does not send them again.",
      { endpoint, rejected, serverMessage: partial.message },
    );
    return rejected;
  }

  /**
   * Converts a non-2xx status code into a classified TransportError.
   * @param status The answer's status code.
   * @param batchId Identifier of the rejected batch.
   * @param kind Kind of the rejected batch. A throttle applies only to its endpoint.
   * @param hints Delay, size limit and advice that come with the answer.
   * @returns Classified TransportError instance.
   */
  protected reject(
    status: number,
    batchId: string,
    kind: BatchKind,
    hints: RejectHints,
  ): TransportError {
    const code = String(status);

    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      const advice = hints.advice === undefined ? "" : ` ${hints.advice}`;

      this.diagnostics.report(
        "transport.rejected_credentials",
        `The server returned ${code}.${advice}`,
        { status, endpoint: endpointFor(kind, this.config) },
      );
      // Classify as permanent. Retrying a rejected credential would block every batch behind it.
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
      // Cap the server delay, otherwise a large Retry-After could stop delivery for hours.
      const retryAfterMs =
        hints.retryAfterMs === undefined
          ? undefined
          : Math.min(hints.retryAfterMs, this.config.delivery.retryMaxDelayMs);
      this.throttledUntil[kind] =
        Date.now() + (retryAfterMs ?? this.config.delivery.retryBaseDelayMs);

      if (throttled) {
        this.diagnostics.report("transport.throttled", "The server throttles the requests.", {
          retryAfterMs,
        });
      }

      return new TransportError(
        "throttled",
        throttled ? "The server throttles the requests." : "The service is not available.",
        status,
        retryAfterMs,
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

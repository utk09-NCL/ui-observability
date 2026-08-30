// src/transport/http-transport.ts
//
// Serializes, compresses, and delivers log batches over HTTP with error
// classification. Classifies, reports and throws. What happens to a rejected batch
// belongs to the caller that owns storage.

import {
  ENCODING_GZIP,
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
  HEADER_RETRY_AFTER,
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
import type { ResolvedConfig } from "../models/config";
import type { SerializedBatch } from "../models/serializer";
import { estimateBytes } from "../utils/sanitize";
import { unrefTimer } from "../utils/unref";
import { gzip } from "./compression";
import { parseRetryAfter, TransportError } from "./errors";

/** HTTP transport delivering serialized log batches with header resolution, gzip compression, and error classification. */
export class HttpTransport {
  /** Timestamp in epoch milliseconds until which requests are throttled. */
  private throttledUntil = 0;

  /**
   * @param config Active configuration instance.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Delivers a single log batch over HTTP.
   * @param batch Batch to send.
   * @throws TransportError on transient, throttled, 413, or permanent network failures.
   */
  async send(batch: LogBatch): Promise<void> {
    if (!this.config.endpoint || batch.records.length === 0) {
      return;
    }

    await this.post(batch);
  }

  /**
   * Returns the remaining throttle backoff duration in milliseconds.
   * @returns Milliseconds remaining in throttle window, or 0 if unthrottled.
   */
  throttledForMs(): number {
    return Math.max(0, this.throttledUntil - Date.now());
  }

  /**
   * Serializes, encodes, and dispatches a batch, throwing a classified TransportError on failure.
   * @param batch Batch to deliver.
   */
  private async post(batch: LogBatch): Promise<void> {
    const { config } = this;

    let serialized: SerializedBatch;
    try {
      serialized = config.serializer.serialize(batch.records);
    } catch (error) {
      this.diagnostics.report(
        "transport.serialize_failed",
        "serializer threw, dropping the batch",
        { batchId: batch.id },
        error,
      );
      return;
    }

    // Headers normalizes header names case-insensitively.
    const headers = new Headers(await this.resolveHeaders());
    headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
    headers.set(HEADER_BATCH_ID, batch.id);
    headers.set(HEADER_ATTEMPT, String(batch.attempts));

    const body = await this.encodeBody(serialized.body);
    if (typeof body !== "string") {
      headers.set(HEADER_CONTENT_ENCODING, ENCODING_GZIP);
    }

    const response = await this.dispatch(headers, body);
    if (response.ok) {
      this.throttledUntil = 0;
      return;
    }

    throw await this.classify(response, batch.id);
  }

  /**
   * Compresses the serialized payload if gzip compression is enabled and size exceeds threshold.
   * @param text Serialized payload string.
   * @returns Promise resolving to original string or compressed byte array.
   */
  private async encodeBody(text: string): Promise<string | Uint8Array<ArrayBuffer>> {
    const { config } = this;
    if (
      config.compression !== ENCODING_GZIP ||
      estimateBytes(text) < config.compressionThresholdBytes
    ) {
      return text;
    }

    const compressed = await this.diagnostics.guardAsync(
      "transport.http_error",
      "gzipping the payload",
      () => gzip(text),
    );

    return compressed ?? text;
  }

  /**
   * Executes the HTTP POST request with timeout and network error mapping.
   * @param headers HTTP request headers.
   * @param body Request body string or byte array.
   * @returns Promise resolving to the HTTP Response.
   * @throws TransportError on network failure, timeout, or offline status.
   */
  private async dispatch(
    headers: Headers,
    body: string | Uint8Array<ArrayBuffer>,
  ): Promise<Response> {
    const { config } = this;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, config.requestTimeoutMs);
    unrefTimer(timer);

    try {
      return await fetch(config.endpoint, {
        method: "POST",
        headers,
        body,
        credentials: config.credentials,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      if (controller.signal.aborted) {
        const waited = String(config.requestTimeoutMs);
        throw new TransportError("timeout", `request exceeded ${waited}ms`);
      }
      const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
      throw new TransportError(online === false ? "offline" : "transient", "network error");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Classifies an HTTP error response into a structured TransportError.
   * @param response Unsuccessful HTTP response.
   * @param batchId Identifier of the rejected batch.
   * @returns Classified TransportError instance.
   */
  private async classify(response: Response, batchId: string): Promise<TransportError> {
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));

    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      const advice =
        "In a cross-origin iframe the session cookie is a third-party cookie and is very " +
        "likely blocked. Forward to the platform document instead of promoting to sender, " +
        "or issue the cookie with the Partitioned attribute.";

      this.diagnostics.report(
        "transport.rejected_credentials",
        `server returned ${String(status)}. ${advice}`,
        { status, endpoint: this.config.endpoint },
      );
      // Permanent. Retrying a rejected credential forever blocks every batch behind
      // it.
      return new TransportError("permanent", `rejected with ${String(status)}`, status);
    }

    if (status === HTTP_PAYLOAD_TOO_LARGE) {
      const maxBytes = await this.readMaxBytes(response);
      return new TransportError("too_large", "payload too large", status, undefined, maxBytes);
    }

    if (status === HTTP_TOO_MANY_REQUESTS || status === HTTP_SERVICE_UNAVAILABLE) {
      const throttled = status === HTTP_TOO_MANY_REQUESTS;
      this.throttledUntil = Date.now() + (retryAfterMs ?? this.config.retry.baseDelayMs);

      if (throttled) {
        this.diagnostics.report("transport.throttled", "server throttled us", {
          retryAfterMs,
        });
      }

      return new TransportError(
        "throttled",
        throttled ? "throttled" : "service unavailable",
        status,
        retryAfterMs,
      );
    }

    if (status === HTTP_REQUEST_TIMEOUT || status >= HTTP_SERVER_ERROR_MIN) {
      return new TransportError("transient", `server error ${String(status)}`, status);
    }

    this.diagnostics.report(
      "transport.dropped_permanent",
      `server rejected the batch with ${String(status)}, dropping it`,
      { batchId, status },
    );
    return new TransportError("permanent", `rejected with ${String(status)}`, status);
  }

  /**
   * Extracts optional maxBytes payload limit from a 413 response body.
   * @param response HTTP 413 Response instance.
   * @returns Promise resolving to maximum byte limit or undefined.
   */
  private async readMaxBytes(response: Response): Promise<number | undefined> {
    return this.diagnostics.guardAsync("transport.http_error", "reading the 413 body", async () => {
      const parsed = JSON.parse(await response.text()) as {
        maxBytes?: unknown;
      };
      return typeof parsed.maxBytes === "number" ? parsed.maxBytes : undefined;
    });
  }

  /**
   * Evaluates configured static or dynamic request headers.
   * @returns Promise resolving to resolved header map.
   */
  private async resolveHeaders(): Promise<Record<string, string>> {
    const { headers } = this.config;
    if (!headers) {
      return {};
    }
    if (typeof headers !== "function") {
      return headers;
    }

    const resolved = await this.diagnostics.guardAsync(
      "transport.http_error",
      "headers() threw",
      () => Promise.resolve(headers()),
    );
    return resolved ?? {};
  }
}

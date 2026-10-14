// src/transport/http-transport.ts
//
// This module serializes, compresses and sends log batches over HTTP. It classifies each
// failure, reports it and throws it. The caller that owns storage decides what happens to a
// rejected batch.

import {
  COMPRESSION_THRESHOLD_BYTES,
  ENCODING_GZIP,
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLING,
  HTTP_PAYLOAD_TOO_LARGE,
  REQUEST_TIMEOUT_MS,
} from "../constants";
import type { LogBatch } from "../models/batch";
import { runAsLibraryRequest } from "../utils/library-request";
import { estimateBytes } from "../utils/sanitize";
import { unrefTimer } from "../utils/unref";
import { gzip } from "./compression";
import { parseRetryAfter, TransportError } from "./errors";
import { StatusTransport } from "./status-transport";

/** Advice for a 401 or a 403 answer on the HTTP path. */
const CREDENTIAL_ADVICE =
  "In a cross-origin iframe, the session cookie is a third-party cookie. The browser " +
  "often blocks it. Forward the records to the platform document. As an alternative, " +
  "issue the cookie with the Partitioned attribute.";

/**
 * This class sends serialized log batches over HTTP. It resolves headers, applies gzip
 * compression and classifies errors.
 */
export class HttpTransport extends StatusTransport {
  /**
   * Sends one log batch over HTTP.
   * @param batch Batch to send.
   * @throws TransportError on transient, throttled, 413, or permanent network failures.
   */
  async send(batch: LogBatch): Promise<void> {
    const { endpoint } = this.config;

    if (!endpoint || batch.records.length === 0) {
      return;
    }

    await this.post(batch, endpoint);
  }

  /**
   * Serializes, encodes and sends a batch. It throws a classified TransportError
   * on failure.
   * @param batch Batch to deliver.
   * @param endpoint Ingest URL. The caller reads it one time. A reconfigure during the send
   * cannot change it.
   */
  private async post(batch: LogBatch, endpoint: string): Promise<void> {
    const serialized = this.serialize(batch);

    if (!serialized) {
      return;
    }

    // Headers ignores the case of header names. A config header cannot duplicate a header below.
    const headers = new Headers(await this.resolveHeaders());
    headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
    headers.set(HEADER_BATCH_ID, batch.id);
    headers.set(HEADER_ATTEMPT, String(batch.attempts));

    const body = await this.encodeBody(serialized.body);
    if (typeof body !== "string") {
      headers.set(HEADER_CONTENT_ENCODING, ENCODING_GZIP);
    }

    const response = await this.dispatch(endpoint, headers, body);
    if (response.ok) {
      // The server must list the header in Access-Control-Expose-Headers. Else the value is null.
      this.accept(response.headers.get(HEADER_SAMPLING));
      return;
    }

    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));
    const maxBytes =
      status === HTTP_PAYLOAD_TOO_LARGE ? await this.readMaxBytes(response) : undefined;

    throw this.reject(status, batch.id, { retryAfterMs, maxBytes, advice: CREDENTIAL_ADVICE });
  }

  /**
   * Compresses the serialized payload when gzip is enabled. The payload size must
   * be at or above the threshold.
   * @param text Serialized payload string.
   * @returns Promise resolving to original string or compressed byte array.
   */
  private async encodeBody(text: string): Promise<string | Uint8Array<ArrayBuffer>> {
    const { config } = this;
    if (config.compression !== ENCODING_GZIP || estimateBytes(text) < COMPRESSION_THRESHOLD_BYTES) {
      return text;
    }

    const compressed = await this.diagnostics.guardAsync(
      "transport.http_error",
      "The library could not compress the payload.",
      () => gzip(text),
    );

    return compressed ?? text;
  }

  /**
   * Sends the HTTP POST request with a timeout. It maps network errors to
   * TransportError.
   * @param endpoint Ingest URL.
   * @param headers HTTP request headers.
   * @param body Request body string or byte array.
   * @returns Promise resolving to the HTTP Response.
   * @throws TransportError on network failure, timeout, or offline status.
   */
  private async dispatch(
    endpoint: string,
    headers: Headers,
    body: string | Uint8Array<ArrayBuffer>,
  ): Promise<Response> {
    const { config } = this;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    unrefTimer(timer);

    try {
      return await runAsLibraryRequest(() =>
        fetch(endpoint, {
          method: "POST",
          headers,
          body,
          credentials: config.credentials,
          signal: controller.signal,
          cache: "no-store",
        }),
      );
    } catch {
      if (controller.signal.aborted) {
        const waited = String(REQUEST_TIMEOUT_MS);
        throw new TransportError("timeout", `The request took longer than ${waited} ms.`);
      }
      const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
      throw new TransportError(
        online === false ? "offline" : "transient",
        "A network error occurred.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads the optional maxBytes limit from a 413 response body.
   * @param response HTTP 413 Response instance.
   * @returns Promise resolving to maximum byte limit or undefined.
   */
  private async readMaxBytes(response: Response): Promise<number | undefined> {
    return this.diagnostics.guardAsync(
      "transport.http_error",
      "The library could not read the body of the 413 response.",
      async () => {
        const parsed = JSON.parse(await response.text()) as {
          maxBytes?: unknown;
        };
        return typeof parsed.maxBytes === "number" ? parsed.maxBytes : undefined;
      },
    );
  }

  /**
   * Resolves the configured static or dynamic request headers.
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
      "The headers() function threw an error.",
      () => Promise.resolve(headers()),
    );
    return resolved ?? {};
  }
}

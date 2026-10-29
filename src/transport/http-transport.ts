// src/transport/http-transport.ts
//
// This module serializes, compresses and sends log batches over HTTP. It classifies each
// failure, reports it and throws it. The caller that owns storage decides what happens to a
// rejected batch.

import {
  BEACON_LIMIT_BYTES,
  COMPRESSION_THRESHOLD_BYTES,
  ENCODING_GZIP,
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLING,
  HTTP_FORBIDDEN,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_UNAUTHORIZED,
  REQUEST_TIMEOUT_MS,
} from "../constants";
import type { LogBatch } from "../models/batch";
import type { SerializedBatch } from "../models/serializer";
import { withDeadline } from "../utils/deadline";
import { runAsLibraryRequest } from "../utils/library-request";
import { estimateBytes } from "../utils/sanitize";
import { unrefTimer } from "../utils/unref";
import { gzip } from "./compression";
import { parseRetryAfter, TransportError } from "./errors";
import { batchKind } from "./serializers/select";
import { StatusTransport } from "./status-transport";

/** Advice for a 401 or a 403 answer on the HTTP path. */
const CREDENTIAL_ADVICE =
  "In a cross-origin iframe, the session cookie is a third-party cookie. The browser " +
  "often blocks it. Forward the records to the platform document. As an alternative, " +
  "issue the cookie with the Partitioned attribute.";

/** Body of one request. It is text or gzip bytes. */
type RequestBody = string | Uint8Array<ArrayBuffer>;

/** Headers that a headers() function gave, that function and the endpoint of the send. */
interface CachedHeaders {
  /** The headers() function that gave the headers. */
  source: unknown;
  /** The endpoint of the send that used the headers. */
  endpoint: string;
  /** The headers. */
  headers: Record<string, string>;
}

/** This type reads document.visibilityState without global DOM type assertions. */
interface DocumentGlobal {
  document?: { visibilityState?: string };
}

/**
 * This class sends serialized log batches over HTTP. It resolves headers, applies gzip
 * compression and classifies errors.
 */
export class HttpTransport extends StatusTransport {
  /**
   * Headers that the headers() function gave last. The exit flush sends them only while that
   * function and the endpoint are in force. A tenant switch must not send the old token to the
   * new endpoint.
   */
  private cachedHeaders: CachedHeaders | undefined;

  /**
   * Sends one log batch over HTTP. A metrics batch goes to metricsEndpoint.
   * @param batch Batch to send.
   * @param onKeepalive Runs when a request of the batch starts with keepalive.
   * @throws TransportError on transient, throttled, 413, or permanent network failures.
   */
  async send(batch: LogBatch, onKeepalive?: () => void): Promise<void> {
    const { config } = this;
    const endpoint =
      batchKind(batch, config) === "metrics" ? config.metricsEndpoint : config.endpoint;

    if (!endpoint || batch.records.length === 0) {
      return;
    }

    await this.post(batch, endpoint, onKeepalive);
  }

  /**
   * Gives the headers for the exit flush. A closing document cannot await headers().
   * @returns The static headers, the headers that the function in force gave last, or undefined.
   */
  lastHeaders(): Record<string, string> | undefined {
    const { headers } = this.config;
    if (!headers) {
      return undefined;
    }

    if (typeof headers !== "function") {
      return headers;
    }

    // The headers apply to both endpoints. The last send can be a metrics batch.
    const cached = this.cachedHeaders;
    const endpoints = [this.config.endpoint, this.config.metricsEndpoint];
    const current = cached?.source === headers && endpoints.includes(cached.endpoint);

    return current ? cached.headers : undefined;
  }

  /**
   * Serializes, encodes and sends a batch. It throws a classified TransportError
   * on failure.
   * @param batch Batch to deliver.
   * @param endpoint Ingest URL. The caller reads it one time. A reconfigure during the send
   * cannot change it.
   * @param onKeepalive Runs when a request of the batch starts with keepalive.
   */
  private async post(
    batch: LogBatch,
    endpoint: string,
    onKeepalive: (() => void) | undefined,
  ): Promise<void> {
    const serialized = this.serialize(batch);

    if (!serialized) {
      return;
    }

    let response = await this.attempt(batch, endpoint, serialized, onKeepalive);

    // A token can expire between two calls of headers(). Send one time more with new
    // headers. A second 401 or 403 drops the batch.
    if (this.rejectsCredentials(response.status) && typeof this.config.headers === "function") {
      this.cachedHeaders = undefined;
      response = await this.attempt(batch, endpoint, serialized, onKeepalive);
    }

    if (response.ok) {
      // The server must list the header in Access-Control-Expose-Headers. If not, it is null.
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
   * Tests if a status rejects the credentials.
   * @param status HTTP status code.
   * @returns True for 401 and 403.
   */
  private rejectsCredentials(status: number): boolean {
    return status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN;
  }

  /**
   * Resolves the headers, encodes the body and sends one request. One deadline covers the
   * three steps. Without it, a headers() that never settles holds a dispatch slot forever.
   * @param batch Batch to deliver.
   * @param endpoint Ingest URL.
   * @param serialized Serialized batch.
   * @param onKeepalive Runs when the request starts with keepalive.
   * @returns Promise that resolves to the HTTP Response.
   * @throws TransportError on timeout or network failure.
   */
  private async attempt(
    batch: LogBatch,
    endpoint: string,
    serialized: SerializedBatch,
    onKeepalive: (() => void) | undefined,
  ): Promise<Response> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;

    // Headers ignores the case of header names. A config header cannot duplicate a header below.
    const headers = new Headers(await this.before(this.resolveHeaders(endpoint), deadline));
    headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
    headers.set(HEADER_BATCH_ID, batch.id);
    headers.set(HEADER_ATTEMPT, String(batch.attempts));

    const body = await this.before(this.encodeBody(serialized.body), deadline);
    if (typeof body !== "string") {
      headers.set(HEADER_CONTENT_ENCODING, ENCODING_GZIP);
    }

    // A keepalive request continues after unload. The exit flush must not send the batch again.
    const keepalive = this.keepalive(body);
    if (keepalive) {
      onKeepalive?.();
    }

    return this.dispatch(endpoint, headers, body, deadline, keepalive);
  }

  /**
   * Waits for a step until the deadline.
   * @param work Step to wait for. It does not reject. Only the deadline rejects here.
   * @param deadline Epoch time in milliseconds at which the request times out.
   * @returns Promise that resolves to the value of the step.
   * @throws TransportError of kind "timeout" at the deadline.
   */
  private async before<T>(work: Promise<T>, deadline: number): Promise<T> {
    try {
      return await withDeadline(work, Math.max(0, deadline - Date.now()));
    } catch {
      throw this.timeout();
    }
  }

  /**
   * Reports a timeout and builds its error.
   * @returns TransportError of kind "timeout".
   */
  private timeout(): TransportError {
    const waited = String(REQUEST_TIMEOUT_MS);
    const message = `The request took longer than ${waited} ms.`;

    this.diagnostics.report("transport.timeout", message, { endpoint: this.config.endpoint });
    return new TransportError("timeout", message);
  }

  /**
   * Compresses the serialized payload when the config sets gzip. The payload size must
   * be at or above the threshold.
   * @param text Serialized payload string.
   * @returns Promise that resolves to original string or compressed byte array.
   */
  private async encodeBody(text: string): Promise<RequestBody> {
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
   * @param deadline Epoch time in milliseconds at which the request times out.
   * @param keepalive True if the request continues after unload.
   * @returns Promise that resolves to the HTTP Response.
   * @throws TransportError on network failure, timeout, or offline status.
   */
  private async dispatch(
    endpoint: string,
    headers: Headers,
    body: RequestBody,
    deadline: number,
    keepalive: boolean,
  ): Promise<Response> {
    const { config } = this;
    const controller = new AbortController();
    // The fetch gets the rest of the time after the headers and the encoding.
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      Math.max(0, deadline - Date.now()),
    );
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
          keepalive,
        }),
      );
    } catch {
      if (controller.signal.aborted) {
        throw this.timeout();
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
   * Tests if a send uses keepalive. A mobile OS can stop a hidden page with no pagehide.
   * A keepalive request continues after that. The browser limits the keepalive bodies in flight.
   * @param body Request body string or byte array.
   * @returns True for a hidden document and a body of BEACON_LIMIT_BYTES or less.
   */
  private keepalive(body: RequestBody): boolean {
    const hidden = (globalThis as DocumentGlobal).document?.visibilityState === "hidden";
    const bytes = typeof body === "string" ? estimateBytes(body) : body.byteLength;

    return hidden && bytes <= BEACON_LIMIT_BYTES;
  }

  /**
   * Reads the optional maxBytes limit from a 413 response body.
   * @param response HTTP 413 Response instance.
   * @returns Promise that resolves to maximum byte limit or undefined.
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
   * Resolves the configured static or dynamic request headers. It keeps the headers that
   * headers() gave, for the exit flush.
   * @param endpoint Ingest URL of the send.
   * @returns Promise that resolves to resolved header map.
   */
  private async resolveHeaders(endpoint: string): Promise<Record<string, string>> {
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

    if (resolved) {
      this.cachedHeaders = { source: headers, endpoint, headers: resolved };
    }

    return resolved ?? {};
  }
}

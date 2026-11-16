// src/transport/http-transport.ts
//
// Serializes, compresses and sends log batches over HTTP. Every failure is classified,
// reported and thrown. The caller that owns storage decides what happens to a rejected batch.

import {
  BEACON_LIMIT_BYTES,
  COMPRESSION_THRESHOLD_BYTES,
  ENCODING_GZIP,
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
  HEADER_DATE,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLING,
  HTTP_FORBIDDEN,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_UNAUTHORIZED,
} from "../constants";
import type { LogBatch } from "../models/batch";
import type { BatchKind } from "../models/config";
import type { SerializedBatch } from "../models/serializer";
import { withDeadline } from "../utils/deadline";
import { runAsLibraryRequest } from "../utils/library-request";
import { isOnline } from "../utils/platform";
import { estimateBytes } from "../utils/sanitize";
import { unrefTimer } from "../utils/unref";
import { gzip } from "./compression";
import { lastHeaders, resetHeaders, resolveHeaders } from "./headers";
import { parseRetryAfter, TransportError } from "./errors";
import { isOtlpBatch, maxBytesOf, needsBody, readOptionalBody } from "./response-body";
import { batchKind, endpointFor } from "./serializers/select";
import { StatusTransport } from "./status-transport";

/** Advice for an HTTP send answered with a 401 or a 403, on the main thread or in the worker. */
export const CREDENTIAL_ADVICE =
  "In a cross-origin iframe, the session cookie is a third-party cookie. The browser " +
  "often blocks it. Forward the records to the platform document. As an alternative, " +
  "issue the cookie with the Partitioned attribute.";

/** Body of one request, either text or gzip bytes. */
type RequestBody = string | Uint8Array<ArrayBuffer>;

/** A response, and the body text when the library uses it. */
interface Answer {
  response: Response;
  /** A 413's size hint or an OTLP 2xx's partialSuccess. Absent when not read or too large. */
  body?: string;
}

/** Lets us read document.visibilityState without global DOM type assertions. */
interface DocumentGlobal {
  document?: { visibilityState?: string };
}

/**
 * Sends serialized log batches over HTTP. Resolves headers, applies gzip compression and
 * classifies errors.
 */
export class HttpTransport extends StatusTransport {
  /**
   * Sends one log batch over HTTP. A metrics batch goes to metricsEndpoint and a traces batch
   * to tracesEndpoint. A batch without an endpoint goes nowhere.
   * @param batch Batch to send.
   * @param onKeepalive Runs when one of the batch's requests starts with keepalive.
   * @throws TransportError on transient, throttled, 413, or permanent network failures.
   */
  async send(batch: LogBatch, onKeepalive?: () => void): Promise<void> {
    this.assertContext(batch);
    const { config } = this;
    const kind = batchKind(batch, config);
    const endpoint = endpointFor(kind, config);

    // A traces batch without tracesEndpoint has no destination. Count the drop.
    if (!endpoint) {
      this.diagnostics.count("record.dropped_no_destination");
      return;
    }

    if (batch.records.length === 0) {
      return;
    }

    await this.post(batch, kind, endpoint, onKeepalive);
  }

  /**
   * Returns the headers for the exit flush, because a closing document can't await headers().
   * @returns The static headers, the last result of the current headers function, or undefined.
   */
  lastHeaders(): Record<string, string> | undefined {
    return lastHeaders(this, this.config);
  }

  /**
   * Serializes, encodes and sends a batch. Throws a classified TransportError
   * on failure.
   * @param batch Batch to deliver.
   * @param kind Kind of the batch. The caller reads it together with the endpoint.
   * @param endpoint Ingest URL. The caller reads it once, so a reconfigure during the send
   * can't change it.
   * @param onKeepalive Runs when one of the batch's requests starts with keepalive.
   */
  private async post(
    batch: LogBatch,
    kind: BatchKind,
    endpoint: string,
    onKeepalive: (() => void) | undefined,
  ): Promise<void> {
    const serialized = this.serialize(batch);

    if (!serialized) {
      return;
    }

    const otlp = isOtlpBatch(kind, this.config.serializer);
    let answer = await this.attempt(batch, endpoint, serialized, otlp, onKeepalive);
    this.assertContext(batch);

    // A token can expire between two headers() calls, so send once more with fresh
    // headers. A second 401 or 403 drops the batch.
    if (
      this.rejectsCredentials(answer.response.status) &&
      typeof this.config.headers === "function"
    ) {
      resetHeaders(this);
      answer = await this.attempt(batch, endpoint, serialized, otlp, onKeepalive);
      this.assertContext(batch);
    }

    const { response, body } = answer;

    if (response.ok) {
      // The server must list each header in Access-Control-Expose-Headers, or it reads as null.
      const { headers } = response;
      this.accept(kind, headers.get(HEADER_SAMPLING), headers.get(HEADER_DATE));
      if (body !== undefined) {
        this.reportPartial(batch, kind, body);
      }
      return;
    }

    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));
    const maxBytes =
      status === HTTP_PAYLOAD_TOO_LARGE && body !== undefined ? this.readMaxBytes(body) : undefined;

    throw this.reject(status, batch.id, kind, {
      retryAfterMs,
      maxBytes,
      advice: CREDENTIAL_ADVICE,
    });
  }

  /**
   * Checks whether a status rejects the credentials.
   * @param status HTTP status code.
   * @returns True for 401 and 403.
   */
  private rejectsCredentials(status: number): boolean {
    return status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN;
  }

  /**
   * Resolves the headers, encodes the body and sends one request. One deadline covers all
   * three steps, otherwise a headers() that never settles holds a dispatch slot forever.
   * @param batch Batch to deliver.
   * @param endpoint Ingest URL.
   * @param serialized Serialized batch.
   * @param otlp True when the batch is in an OTLP format, so a 2xx can carry a partialSuccess.
   * @param onKeepalive Runs when the request starts with keepalive.
   * @returns Promise that resolves to the response and the body text its status needs.
   * @throws TransportError on timeout or network failure.
   */
  private async attempt(
    batch: LogBatch,
    endpoint: string,
    serialized: SerializedBatch,
    otlp: boolean,
    onKeepalive: (() => void) | undefined,
  ): Promise<Answer> {
    const deadline = Date.now() + this.config.delivery.requestTimeoutMs;

    // Headers ignores case in header names, so a config header can't duplicate one set below.
    const headers = new Headers(await this.before(this.resolveHeaders(), deadline, endpoint));
    headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
    headers.set(HEADER_BATCH_ID, batch.id);
    headers.set(HEADER_ATTEMPT, String(batch.attempts));

    const body = await this.before(this.encodeBody(serialized.body), deadline, endpoint);
    this.assertContext(batch);
    if (typeof body !== "string") {
      headers.set(HEADER_CONTENT_ENCODING, ENCODING_GZIP);
    }

    // A keepalive request continues after unload, so the exit flush must not send the batch
    // again.
    const keepalive = this.keepalive(body);
    if (keepalive) {
      onKeepalive?.();
    }

    return this.dispatch(endpoint, headers, body, deadline, keepalive, otlp);
  }

  /**
   * Waits for a step until the deadline.
   * @param work Step to wait for. It never rejects, so only the deadline rejects here.
   * @param deadline Epoch time in milliseconds at which the request times out.
   * @param endpoint Ingest URL of the request, for the timeout report.
   * @returns Promise that resolves to the step's value.
   * @throws TransportError of kind "timeout" at the deadline.
   */
  private async before<T>(work: Promise<T>, deadline: number, endpoint: string): Promise<T> {
    try {
      return await withDeadline(this.untilCancelled(work), Math.max(0, deadline - Date.now()));
    } catch {
      if (this.cancellation.signal.aborted)
        throw new TransportError("permanent", "The delivery context retired.");
      throw this.timeout(endpoint);
    }
  }

  /**
   * Reports a timeout and builds its error.
   * @param endpoint Ingest URL of the request.
   * @returns TransportError of kind "timeout".
   */
  private timeout(endpoint: string): TransportError {
    const waited = String(this.config.delivery.requestTimeoutMs);
    const message = `The request took longer than ${waited} ms.`;

    this.diagnostics.report("transport.timeout", message, { endpoint });
    return new TransportError("timeout", message);
  }

  /**
   * Compresses the serialized payload when the config sets gzip and the payload is at or
   * above the threshold.
   * @param text Serialized payload string.
   * @returns Promise that resolves to the original string or the compressed byte array.
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
   * Sends the HTTP POST request with a timeout, and maps network errors to
   * TransportError.
   * @param endpoint Ingest URL.
   * @param headers HTTP request headers.
   * @param body Request body string or byte array.
   * @param deadline Epoch time in milliseconds at which the request times out.
   * @param keepalive True if the request continues after unload.
   * @param otlp True when the batch is in an OTLP format, so a 2xx can carry a partialSuccess.
   * @returns Promise that resolves to the response and the body text its status needs.
   * @throws TransportError on network failure, timeout, or offline status.
   */
  private async dispatch(
    endpoint: string,
    headers: Headers,
    body: RequestBody,
    deadline: number,
    keepalive: boolean,
    otlp: boolean,
  ): Promise<Answer> {
    const { config } = this;
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
    };
    this.cancellation.signal.addEventListener("abort", cancel, { once: true });
    if (this.cancellation.signal.aborted) controller.abort();
    // The fetch gets whatever time is left after the headers and the encoding.
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      Math.max(0, deadline - Date.now()),
    );
    unrefTimer(timer);

    try {
      const response = await runAsLibraryRequest(() =>
        fetch(endpoint, {
          method: "POST",
          headers,
          body,
          credentials: config.credentials,
          signal: controller.signal,
          cache: "no-store",
          keepalive,
          // The OS can stop a hidden page soon, so don't delay its keepalive send.
          priority: keepalive ? "auto" : config.delivery.priority,
        }),
      );

      if (!needsBody(response, otlp)) {
        return { response };
      }

      // Read the body before the finally below disarms the timer and the stop listener,
      // otherwise a body that stalls holds the dispatch slot past the deadline and after stop().
      return {
        response,
        body: await readOptionalBody(response, controller.signal, this.diagnostics),
      };
    } catch {
      if (this.cancellation.signal.aborted) {
        throw new TransportError("permanent", "The delivery context retired.");
      }
      if (controller.signal.aborted) {
        throw this.timeout(endpoint);
      }
      throw new TransportError(isOnline() ? "transient" : "offline", "A network error occurred.");
    } finally {
      this.cancellation.signal.removeEventListener("abort", cancel);
      clearTimeout(timer);
    }
  }

  /**
   * Checks whether a send uses keepalive. A mobile OS can stop a hidden page without a
   * pagehide, and a keepalive request continues after that. The browser limits the keepalive
   * bodies in flight.
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
   * @param body The 413 body text.
   * @returns The limit in bytes, or undefined.
   */
  private readMaxBytes(body: string): number | undefined {
    return this.diagnostics.guard(
      "transport.http_error",
      "The library could not read the body of the 413 response.",
      () => maxBytesOf(body),
    );
  }

  /**
   * Resolves the configured static or dynamic request headers, and keeps what headers()
   * returned for the exit flush.
   * @returns Promise that resolves to the header map.
   */
  private async resolveHeaders(): Promise<Record<string, string>> {
    return resolveHeaders(this, this.config, this.diagnostics);
  }
}

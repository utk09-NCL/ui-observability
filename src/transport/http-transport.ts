// src/transport/http-transport.ts
//
// One batch, one POST. This class classifies, reports and throws; it does not
// split, store or retry. What to keep, what to halve and when to try again
// lives with whoever holds the records: the pipeline on the live path, the
// retry engine on the stored one.
//
// Cookie auth is why `credentials` defaults to "include" and why there is no
// token cache here. A move to bearer tokens goes through the header resolver,
// and would also need the exit flush reworked, since an unloading page cannot
// await a token refresh.

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
import { gzip } from "./compression";
import { parseRetryAfter, TransportError } from "./errors";

/** Delivers batches over HTTP. */
export class HttpTransport {
  /** Epoch ms until which the server has asked to be left alone. Zero when it has not asked. */
  private throttledUntil = 0;

  /**
   * @param config The live config object, so a reconfigure reaches this instance.
   * @param diagnostics Where a rejected batch and a broken header resolver are reported.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Send one batch.
   *
   * @param batch The records, and the id the server deduplicates on.
   * @throws TransportError on any failure the caller has to react to. A batch
   * the serializer cannot encode resolves instead: it would fail identically
   * forever, so there is nothing to store and nothing to retry.
   */
  async send(batch: LogBatch): Promise<void> {
    if (!this.config.endpoint || batch.records.length === 0) {
      return;
    }

    await this.post(batch);
  }

  /**
   * How long the server has asked to be left alone, in milliseconds.
   *
   * The pipeline checks this before dispatching, so a 429 slows the live path
   * too. Without it the retry engine backs off politely while the pipeline
   * posts a fresh batch every flush interval into a server asking it to stop.
   */
  throttledForMs(): number {
    return Math.max(0, this.throttledUntil - Date.now());
  }

  /** Encode, label, dispatch, and turn a failed response into a classified error. */
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

    // A `Headers` rather than a plain object, because header names are
    // case-insensitive: a consumer returning `x-uiobs-batch-id` keeps its own
    // key beside ours in an object literal, and fetch folds the two into
    // "spoofed, 0f1c...". The server then deduplicates on a value no client
    // sent. `Headers.set` normalises the name, so ours really does win.
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
   * The body to send: gzipped bytes past the threshold, the text otherwise.
   *
   * A gzip that fails costs a bigger request, not a lost batch, so it reports
   * and falls back. The return type is what tells the caller whether to label
   * the request.
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
   * One POST, with the timeout that stops a hung request holding a batch open.
   *
   * @throws TransportError when the request never produced a response. Not
   * reported here: the caller decides what a transient failure costs.
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

    try {
      return await fetch(config.endpoint, {
        method: "POST",
        headers,
        body,
        credentials: config.credentials,
        signal: controller.signal,
        // A log request must never keep a page or a service worker alive.
        cache: "no-store",
      });
    } catch {
      if (controller.signal.aborted) {
        const waited = String(config.requestTimeoutMs);
        throw new TransportError("timeout", `request exceeded ${waited}ms`);
      }
      // Read off globalThis: `navigator` is absent in some hosts, and the DOM
      // types declare it as always present.
      const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
      throw new TransportError(online === false ? "offline" : "transient", "network error");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A failed response as the error the caller reacts to.
   *
   * @param response The server's answer, already known not to be ok.
   * @param batchId Reported with a batch that is being dropped.
   */
  private async classify(response: Response, batchId: string): Promise<TransportError> {
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));

    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      // The likeliest cause by far, and impossible to see from a bare 401.
      const advice =
        "In a cross-origin iframe the session cookie is a third-party cookie and is very " +
        "likely blocked. Forward to the platform document instead of promoting to sender, " +
        "or issue the cookie with the Partitioned attribute.";

      this.diagnostics.report(
        "transport.rejected_credentials",
        `server returned ${String(status)}. ${advice}`,
        { status, endpoint: this.config.endpoint },
      );
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
        this.diagnostics.report("transport.throttled", "server throttled us", { retryAfterMs });
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

    // Any other 4xx will never succeed. Retrying it forever is how one bad
    // batch blocks every batch behind it.
    this.diagnostics.report(
      "transport.dropped_permanent",
      `server rejected the batch with ${String(status)}, dropping it`,
      { batchId, status },
    );
    return new TransportError("permanent", `rejected with ${String(status)}`, status);
  }

  /** The limit a 413 body may carry. Optional per the server contract, so junk there is not an error. */
  private async readMaxBytes(response: Response): Promise<number | undefined> {
    return this.diagnostics.guardAsync("transport.http_error", "reading the 413 body", async () => {
      const parsed = JSON.parse(await response.text()) as { maxBytes?: unknown };
      return typeof parsed.maxBytes === "number" ? parsed.maxBytes : undefined;
    });
  }

  /** The consumer's headers. A resolver that throws costs its headers, never the batch. */
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

// src/capture/replay-upload.ts
//
// Cuts session replay events into segments and sends them. A segment closes on an event count,
// on a size, or after a wait. Only one segment is in flight at a time, which keeps them in
// order. Segments live in memory only, and the exit flush doesn't send them.

import {
  COMPRESSION_THRESHOLD_BYTES,
  CONTENT_TYPE_JSON,
  ENCODING_GZIP,
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { ResolvedConfig } from "../models/config";
import type { ReplaySegment } from "../models/replay";
import { gzip } from "../transport/compression";
import { withDeadline } from "../utils/deadline";
import { runAsLibraryRequest } from "../utils/library-request";
import { unrefTimer } from "../utils/unref";

/** The ids stamped on every segment of a recording. */
export interface ReplayIds {
  /** Recording id. */
  replayId: string;
  /** Session id from the record that triggered the upload. */
  sessionId: string;
  /** Tab id from the record that triggered the upload. */
  tabId: string;
}

/** Outcome of one send. `retry` means a later attempt might work. */
type SendResult = "sent" | "retry" | "drop";

/** Statuses that mean our credentials were rejected. The next attempt re-reads the headers. */
const CREDENTIAL_STATUSES = [401, 403];

/** Name used for a thrown value that isn't an Error. Reports only ever show the error name. */
const UNKNOWN_ERROR = "Error";

/** The server is asking us to slow down. */
const STATUS_TOO_MANY = 429;

/** Server faults start here. */
const STATUS_SERVER_FAULT = 500;

/** Cuts replay events into segments and sends them in order. */
export class ReplayUploader {
  /** Events in the open segment, as JSON text. */
  private open: string[] = [];

  /** Size of the open segment. */
  private openBytes = 0;

  /** Closes a segment that didn't fill up in time. */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Closed segments waiting to be sent. The one in flight isn't in here. */
  private queue: ReplaySegment[] = [];

  /** Total size of the queued segments. */
  private queueBytes = 0;

  /** True while a segment is in flight or waiting for its next attempt. */
  private busy = false;

  /** Timer for the in-flight segment's next attempt. */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Ids for the segments we cut next. */
  private ids: ReplayIds | undefined;

  /** Sequence number for the recording's next segment. */
  private sequence = 0;

  /** Bumped on every stop, so a send that finishes after a stop changes nothing. */
  private generation = 0;

  /** Aborts the request in flight. Once stopped, the uploader must not send anything else. */
  private inFlight: AbortController | undefined;

  /**
   * @param config Returns the current configuration.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly config: () => ResolvedConfig,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Sets the ids for the segments that follow. A new recording restarts the sequence at 0.
   * @param ids Ids of the recording and of the record that triggered the upload.
   */
  begin(ids: ReplayIds): void {
    if (ids.replayId !== this.ids?.replayId) {
      this.sequence = 0;
    }

    this.ids = ids;
  }

  /**
   * Adds events. A full segment closes right away, a partial one closes after the wait.
   * @param texts The events as JSON text, in order.
   */
  push(texts: readonly string[]): void {
    const { batchSize, batchBytes, flushIntervalMs } = this.config().replay;

    for (const text of texts) {
      // If this event doesn't fit, close the segment first. A huge event ends up in its own.
      if (this.open.length > 0 && this.openBytes + text.length > batchBytes) {
        this.flush();
      }

      this.open.push(text);
      this.openBytes += text.length;

      if (this.open.length >= batchSize || this.openBytes >= batchBytes) {
        this.flush();
      }
    }

    if (this.open.length > 0 && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, flushIntervalMs);
      unrefTimer(this.flushTimer);
    }
  }

  /** Closes the open segment and gets it sent. */
  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;

    const { ids } = this;
    if (this.open.length === 0 || !ids) {
      return;
    }

    const payload = `[${this.open.join(",")}]`;
    const segment: ReplaySegment = {
      "replay.id": ids.replayId,
      "session.id": ids.sessionId,
      "tab.id": ids.tabId,
      "service.name": this.config().serviceName,
      sequence: this.sequence++,
      events: this.open.length,
      bytes: payload.length,
      payload,
    };
    this.open = [];
    this.openBytes = 0;
    this.queue.push(segment);
    this.queueBytes += segment.bytes;

    let dropped = 0;
    while (this.queueBytes > this.config().replay.maxQueueBytes && this.queue.length > 1) {
      const [oldest] = this.queue.splice(0, 1);
      this.queueBytes -= oldest.bytes;
      dropped++;
    }

    if (dropped > 0) {
      this.diagnostics.report(
        "transport.dropped_permanent",
        `The replay queue is above replay.maxQueueBytes. The library dropped ${String(dropped)} segments.`,
      );
    }

    this.drain();
  }

  /** Drops everything that is waiting. A send still in flight no longer changes any state. */
  stop(): void {
    this.generation++;
    this.inFlight?.abort();
    this.inFlight = undefined;
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.flushTimer = undefined;
    this.retryTimer = undefined;
    this.open = [];
    this.openBytes = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.busy = false;
  }

  /** Sends the next segment, unless one is already in flight. */
  private drain(): void {
    if (this.busy || this.queue.length === 0) {
      return;
    }

    const [segment] = this.queue.splice(0, 1);
    this.queueBytes -= segment.bytes;
    this.busy = true;
    void this.deliver(segment, 1, this.generation);
  }

  /**
   * Sends one segment, backing off before each retry.
   * @param segment The segment to send.
   * @param attempt Attempt number, starting at 1.
   * @param generation The uploader's generation when the send started.
   */
  private async deliver(
    segment: ReplaySegment,
    attempt: number,
    generation: number,
  ): Promise<void> {
    const result = await this.send(segment, attempt, generation);

    if (generation !== this.generation) {
      return;
    }

    const { replay, delivery } = this.config();
    if (result === "retry" && attempt < replay.maxAttempts) {
      const wait = Math.min(
        delivery.retryBaseDelayMs * 2 ** (attempt - 1),
        delivery.retryMaxDelayMs,
      );
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.deliver(segment, attempt + 1, generation);
      }, wait);
      unrefTimer(this.retryTimer);
      return;
    }

    if (result !== "sent") {
      this.diagnostics.report(
        "transport.dropped_permanent",
        `The library dropped the replay segment ${String(segment.sequence)} after ${String(attempt)} attempts.`,
        { "replay.id": segment["replay.id"], sequence: segment.sequence },
      );
    }

    this.busy = false;
    this.drain();
  }

  /**
   * Hands a segment to the app's onSegment function, or posts it to the endpoint. Never throws.
   * @param segment The segment to send.
   * @param attempt Attempt number, starting at 1.
   * @param generation The uploader's generation when the send started.
   * @returns How the send went.
   */
  private async send(
    segment: ReplaySegment,
    attempt: number,
    generation: number,
  ): Promise<SendResult> {
    const config = this.config();
    const { onSegment, endpoint, headers: source } = config.replay;
    const timeoutMs = config.delivery.requestTimeoutMs;

    if (onSegment) {
      try {
        // Don't let a callback that never settles block the uploader forever.
        await withDeadline(Promise.resolve(onSegment(segment)), timeoutMs);
        return "sent";
      } catch (error) {
        this.diagnostics.report(
          "capture.record_failed",
          `The replay.onSegment function threw an error, or it did not end in ${String(timeoutMs)} ms.`,
          undefined,
          error,
        );
        return "drop";
      }
    }

    // The capture starts only with an endpoint or onSegment, but a later configure() can remove
    // both while a segment waits.
    if (endpoint === null) {
      return "drop";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    unrefTimer(timer);

    try {
      // The replay endpoint only gets replay.headers. The log endpoint's headers may carry a
      // token meant for a different host.
      const given =
        typeof source === "function"
          ? await withDeadline(Promise.resolve(source()), timeoutMs)
          : source;
      const headers = new Headers(given ?? {});
      headers.set(HEADER_CONTENT_TYPE, CONTENT_TYPE_JSON);
      headers.set(HEADER_BATCH_ID, `${segment["replay.id"]}-${String(segment.sequence)}`);
      headers.set(HEADER_ATTEMPT, String(attempt - 1));

      // In the body "events" is the event list itself. Its length is the count.
      const { payload, events: _count, ...head } = segment;
      const text = `${JSON.stringify(head).slice(0, -1)},"events":${payload}}`;
      let body: string | Uint8Array<ArrayBuffer> = text;

      if (config.compression === ENCODING_GZIP && text.length >= COMPRESSION_THRESHOLD_BYTES) {
        const zipped = await gzip(text);

        if (zipped) {
          body = zipped;
          headers.set(HEADER_CONTENT_ENCODING, ENCODING_GZIP);
        }
      }

      // If we were stopped during the awaits above, send nothing.
      if (generation !== this.generation) {
        return "drop";
      }

      this.inFlight = controller;

      // Network capture skips requests started in this scope. The replay endpoint is also in
      // capture.ignoreUrls, in case some wrapper starts the request later.
      const response = await runAsLibraryRequest(() =>
        fetch(endpoint, {
          method: "POST",
          headers,
          body,
          credentials: config.credentials,
          cache: "no-store",
          signal: controller.signal,
        }),
      );

      if (response.ok) {
        return "sent";
      }

      this.diagnostics.report(
        "transport.http_error",
        `The replay endpoint returned ${String(response.status)}.`,
      );

      return CREDENTIAL_STATUSES.includes(response.status) ||
        response.status === STATUS_TOO_MANY ||
        response.status >= STATUS_SERVER_FAULT
        ? "retry"
        : "drop";
    } catch (error) {
      // A request error's message can contain the URL, and a URL can contain a credential.
      this.diagnostics.report(
        "transport.http_error",
        `The replay request failed with ${error instanceof Error ? error.name : UNKNOWN_ERROR}.`,
      );
      return "retry";
    } finally {
      clearTimeout(timer);
      this.inFlight = undefined;
    }
  }
}

// src/transport/errors.ts
//
// Classifies HTTP transport failures and parses server Retry-After backoff headers.

import { MILLIS_PER_SECOND } from "../constants";

/**
 * Failure classification determining retry, backoff, or drop behavior. transient,
 * offline and timeout retry with backoff. throttled waits the server's delay.
 * too_large splits the batch. permanent drops it: it will never be accepted.
 */
export type TransportFailureKind =
  "transient" | "throttled" | "too_large" | "permanent" | "timeout" | "offline";

/** Error representing a failed transport attempt with failure classification and metadata. */
export class TransportError extends Error {
  /**
   * @param kind Failure classification.
   * @param message Error description.
   * @param status Optional HTTP response status code.
   * @param retryAfterMs Delay requested by the server in milliseconds.
   * @param maxBytes Maximum payload bytes suggested by a 413 response.
   */
  constructor(
    public readonly kind: TransportFailureKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly maxBytes?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Parses HTTP Retry-After header value (seconds or HTTP date) into millisecond
 * delay. Both forms are legal. A date already past clamps to zero.
 * Clamps negative delays to zero.
 * @param header Raw Retry-After header string or null.
 * @returns Non-negative delay in milliseconds, or undefined if invalid or missing.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * MILLIS_PER_SECOND);
  }

  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

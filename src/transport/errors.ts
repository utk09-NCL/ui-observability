// src/transport/errors.ts
//
// This module classifies HTTP transport failures. It also parses the Retry-After header.

import { MILLIS_PER_SECOND } from "../constants";

/**
 * The failure kind sets the retry, backoff or drop behavior. The engine retries transient,
 * offline and timeout failures with backoff. A throttled failure waits for the server delay.
 * A too_large failure splits the batch. The engine drops a permanent failure. The server
 * never accepts that batch.
 */
export type TransportFailureKind =
  "transient" | "throttled" | "too_large" | "permanent" | "timeout" | "offline";

/** This error records a failed transport attempt, its failure kind and its metadata. */
export class TransportError extends Error {
  /**
   * @param kind Failure classification.
   * @param message Error description.
   * @param status Optional HTTP response status code.
   * @param retryAfterMs Delay requested by the server in milliseconds.
   * @param maxBytes Maximum payload bytes suggested by a 413 response.
   * @param cause Error that caused this failure.
   */
  constructor(
    public readonly kind: TransportFailureKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly maxBytes?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TransportError";
  }
}

/**
 * Parses an HTTP Retry-After value into a delay in milliseconds. The value
 * can be a number of seconds or an HTTP date. The function clamps a negative delay to zero.
 * A date in the past gives a negative delay.
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

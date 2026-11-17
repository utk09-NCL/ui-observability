// src/transport/errors.ts
//
// Classifies HTTP transport failures and parses the Retry-After header.

import { MILLIS_PER_SECOND } from "../constants";

/**
 * The failure kind decides whether the engine retries, backs off or drops. Transient, offline
 * and timeout failures are retried with backoff. A throttled failure waits for the server's
 * delay, and a too_large failure splits the batch. A permanent failure is dropped, because the
 * server will never accept that batch.
 */
export type TransportFailureKind =
  "transient" | "throttled" | "too_large" | "permanent" | "timeout" | "offline";

/** A failed transport attempt, with its failure kind and metadata. */
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
    super(message);
    this.name = "TransportError";

    // Older browsers ignore the ES2022 (message, { cause }) option, so set the property the way
    // the native one does: own, writable and not enumerable.
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, writable: true, configurable: true });
    }
  }
}

/**
 * Parses an HTTP Retry-After value into a delay in milliseconds. The value
 * can be a number of seconds or an HTTP date. A date in the past gives a negative delay,
 * which is clamped to zero.
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

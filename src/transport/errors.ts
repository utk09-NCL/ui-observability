// src/transport/errors.ts
//
// How a failed send is classified. The transport decides which kind a failure
// is; what to do about it belongs to whoever holds the records.

import { MILLIS_PER_SECOND } from "../constants";

/**
 * What the holder of the batch should do next.
 *
 * `transient` retry with backoff. `throttled` retry after exactly
 * `retryAfterMs`. `too_large` split the batch and retry the halves.
 * `permanent` drop it, it will never be accepted. `timeout` treat as transient.
 * `offline` do not count it as an attempt, since nothing was tried.
 */
export type TransportFailureKind =
  "transient" | "throttled" | "too_large" | "permanent" | "timeout" | "offline";

/** A send that failed, carrying everything the caller needs to decide what happens next. */
export class TransportError extends Error {
  /**
   * @param kind What to do about it.
   * @param message Human-readable detail. Free-form, and it may change between versions.
   * @param status The HTTP status, where the failure got that far.
   * @param retryAfterMs How long the server asked for, on a throttled failure.
   * @param maxBytes From a 413 body, when the server bothers to say. Reported, never obeyed.
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
 * Retry-After as milliseconds. It is either delta seconds or an HTTP date, and
 * both are legal, so a parser that handles one of them is wrong half the time.
 *
 * @param header The raw header, or null when the server sent none.
 * @returns The delay, never negative, or undefined when there is nothing usable.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * MILLIS_PER_SECOND);
  }

  // A date already in the past clamps to zero rather than asking for a send
  // that happened before now.
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

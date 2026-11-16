// src/transport/memory-transport.ts
//
// A transport for tests that keeps every batch in memory, so a test can check the records the
// library sends without a network or a fetch mock.

import { HTTP_SUCCESS_END, HTTP_SUCCESS_MIN } from "../constants";
import type { Transport, TransportRequest, TransportResponse } from "../models/config";
import type { LogRecord } from "../models/log-record";

/** A transport for tests that keeps every batch in memory. */
export interface MemoryTransport {
  /** Pass this function as `transport` to `configure()`. */
  transport: Transport;
  /**
   * Returns the records of every accepted batch, in send order.
   * @returns The accepted records.
   */
  records(): LogRecord[];
  /**
   * Returns every request, accepted or refused, in send order.
   * @returns The requests.
   */
  batches(): TransportRequest[];
  /** Forgets every batch. The answer set with respondWith stays. */
  clear(): void;
  /**
   * Sets the answer for all later batches. The default answer is 200.
   * @param status Status code to answer with, for example 413, 429 or 500.
   * @param retryAfterMs Delay to answer with, for 429 and 503.
   */
  respondWith(status: number, retryAfterMs?: number): void;
}

/**
 * Creates a transport that keeps every batch in memory. Use it in tests, with `configure()`.
 * @returns The memory transport.
 */
export function createMemoryTransport(): MemoryTransport {
  const sent: TransportRequest[] = [];
  const accepted: TransportRequest[] = [];
  let answer: TransportResponse = { status: HTTP_SUCCESS_MIN };

  return {
    transport: (request) => {
      sent.push(request);

      if (answer.status >= HTTP_SUCCESS_MIN && answer.status < HTTP_SUCCESS_END) {
        accepted.push(request);
      }

      return Promise.resolve({ ...answer });
    },
    records: () => accepted.flatMap((request) => [...request.records]),
    batches: () => [...sent],
    clear: () => {
      sent.length = 0;
      accepted.length = 0;
    },
    respondWith: (status, retryAfterMs) => {
      answer = retryAfterMs === undefined ? { status } : { status, retryAfterMs };
    },
  };
}

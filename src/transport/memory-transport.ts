// src/transport/memory-transport.ts
//
// Gives tests a transport that keeps each batch in memory. A test then checks the records that
// the library sends, with no network and no fetch mock.

import { HTTP_SUCCESS_END, HTTP_SUCCESS_MIN } from "../constants";
import type { Transport, TransportRequest, TransportResponse } from "../models/config";
import type { LogRecord } from "../models/log-record";

/** A transport that keeps each batch in memory, for tests. */
export interface MemoryTransport {
  /** Pass this function as `transport` to `configure()`. */
  transport: Transport;
  /**
   * Returns the records of each accepted batch, in send order.
   * @returns The accepted records.
   */
  records(): LogRecord[];
  /**
   * Returns each request, accepted or refused, in send order.
   * @returns The requests.
   */
  batches(): TransportRequest[];
  /** Forgets each batch. The answer that respondWith set stays. */
  clear(): void;
  /**
   * Sets the answer for each later batch. The default answer is 200.
   * @param status Status code to answer with, for example 413, 429 or 500.
   * @param retryAfterMs Delay to answer with, for 429 and 503.
   */
  respondWith(status: number, retryAfterMs?: number): void;
}

/**
 * Creates a transport that keeps each batch in memory. Use it in tests, with `configure()`.
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

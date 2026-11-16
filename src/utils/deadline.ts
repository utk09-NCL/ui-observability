// src/utils/deadline.ts
//
// Puts a deadline on a promise that could stay pending. A pending promise raises no
// diagnostics event, so without a deadline its caller waits forever and keeps its slot.

import { unrefTimer } from "./unref";

/** The error for a promise that didn't settle before its deadline. */
export class DeadlineError extends Error {
  /**
   * @param ms Deadline in milliseconds.
   */
  constructor(ms: number) {
    super(`The operation took longer than ${String(ms)} ms.`);
    this.name = "DeadlineError";
  }
}

/**
 * Rejects when a promise doesn't settle within a deadline.
 * @param work The promise to bound.
 * @param ms Deadline in milliseconds.
 * @returns The promise's value, or a rejection after the deadline.
 */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let expire: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeadlineError(ms));
    }, ms);

    expire = timer;
    unrefTimer(timer);
  });

  // Clear the timer on success and on failure. Otherwise every storage call leaves an armed timer.
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(expire);
  });
}

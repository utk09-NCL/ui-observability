// src/utils/deadline.ts
//
// Sets a deadline for a promise that can stay pending. A pending promise raises no
// diagnostics event. Without a deadline, its caller waits forever and keeps its slot.

import { unrefTimer } from "./unref";

/** Error of a promise that did not settle before its deadline. */
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
 * Rejects when a promise does not settle within a deadline.
 * @param work Promise to bound.
 * @param ms Deadline in milliseconds.
 * @returns The value of the promise, or a rejection after the deadline.
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

  // Clear the timer on success and on failure. If not, each storage call leaves an armed timer.
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(expire);
  });
}

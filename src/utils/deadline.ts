// src/utils/deadline.ts
//
// Deadline for a promise that can stay pending. A pending promise raises no
// diagnostics event, so its caller waits with it and holds the slot it took.

import { unrefTimer } from "./unref";

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
      reject(new Error(`timed out after ${String(ms)}ms`));
    }, ms);

    expire = timer;
    unrefTimer(timer);
  });

  // Cleared on both paths. One armed timer for each storage call is waste.
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(expire);
  });
}

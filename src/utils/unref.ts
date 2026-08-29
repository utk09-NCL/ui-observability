// src/utils/unref.ts
//
// One timer handle, two host families.

/**
 * A timer handle as the two host families actually hand one back: a number in a
 * browser, an object in Node.
 */
export type TimerHandle = number | { unref?: () => void };

/**
 * Stop a pending timer from holding a Node process open: under SSR or a test
 * runner one long timer keeps the process alive. A browser's numeric handle has
 * no `unref` and needs none.
 *
 * @param timer The handle `setTimeout` returned.
 */
export function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "number") {
    timer.unref?.();
  }
}

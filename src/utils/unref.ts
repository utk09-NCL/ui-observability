// src/utils/unref.ts
//
// Unreferences timer handles in Node and browser environments. A pending timer
// keeps a Node process alive under SSR and in tests.

/** A timer handle. A number in a browser, a Timeout object in Node. */
export type TimerHandle = number | { unref?: () => void };

/**
 * Unreferences a timer handle, so a pending timer doesn't keep a Node.js process alive.
 * @param timer The timer handle returned by setTimeout.
 */
export function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "number") {
    timer.unref?.();
  }
}

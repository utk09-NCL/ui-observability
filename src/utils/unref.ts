// src/utils/unref.ts
//
// Unreferences timer handles in Node and browser environments. A pending timer
// keeps a Node process alive under SSR and in tests.

/** Timer handle. It is a number in a browser and a Timeout object in Node. */
export type TimerHandle = number | { unref?: () => void };

/**
 * Unreferences a timer handle. A pending timer then does not keep a Node.js process alive.
 * @param timer Timer handle returned by setTimeout.
 */
export function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "number") {
    timer.unref?.();
  }
}

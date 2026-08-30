// src/utils/unref.ts
//
// Utility for safely unreferencing timer handles across Node and browser
// environments. A pending timer keeps a Node process alive under SSR and in
// tests.

/** Cross-platform timer handle representing browser numeric IDs or Node Timeout objects. */
export type TimerHandle = number | { unref?: () => void };

/**
 * Unreferences a timer handle to prevent it from keeping a Node.js process alive.
 * @param timer Timer handle returned by setTimeout.
 */
export function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "number") {
    timer.unref?.();
  }
}

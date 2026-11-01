// src/utils/fixed-window.ts
//
// Counts events in a fixed time window. A quiet period adds no allowance. The capture modules and
// the error ceiling use it to stop a storm of records.

/** State of one fixed window. Counters that share a limit share one object. */
export interface StormWindow {
  /** Start of the current window, in epoch milliseconds. */
  start: number;
  /** Events counted in the current window. */
  count: number;
}

/**
 * Counts one event in a fixed window.
 * @param window Window state to change.
 * @param limit Maximum events in each window.
 * @param windowMs Length of the window, in milliseconds.
 * @returns False when the window has no allowance left. The caller must drop the event.
 */
export function countInWindow(window: StormWindow, limit: number, windowMs: number): boolean {
  const now = Date.now();

  if (windowEnded(window, windowMs, now)) {
    window.start = now;
    window.count = 0;
  }

  window.count++;

  return window.count <= limit;
}

/**
 * Tells if a fixed window has ended. The bus uses the same rule to expire its source entries.
 * @param window Window state.
 * @param windowMs Length of the window, in milliseconds.
 * @param now Current epoch time, in milliseconds.
 * @returns True after the window length, or when the clock moved back. Without the second
 * check, a clock that moves back keeps the window open.
 */
export function windowEnded(window: StormWindow, windowMs: number, now: number): boolean {
  return now < window.start || now - window.start > windowMs;
}

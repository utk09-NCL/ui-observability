// src/capture/storm.ts
//
// Fixed-window rate limit for the capture modules. A render loop that throws or freezes
// makes thousands of events each second. Sending all of them floods the ingest endpoint.

import { ERROR_STORM_WINDOW_MS } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { countInWindow, type StormWindow } from "../utils/fixed-window";

export type { StormWindow } from "../utils/fixed-window";

/**
 * Counts one event in a fixed window. It reports each event over the limit.
 * @param window Window state to change.
 * @param limit Maximum events in each window.
 * @param diagnostics Diagnostics reporter.
 * @param what Plural name of the events, for the diagnostic message.
 * @returns False when the window has no allowance left. The caller must drop the event.
 */
export function allowInWindow(
  window: StormWindow,
  limit: number,
  diagnostics: Diagnostics,
  what: string,
): boolean {
  if (countInWindow(window, limit, ERROR_STORM_WINDOW_MS)) {
    return true;
  }

  diagnostics.report(
    "capture.rate_limited",
    `More than ${String(limit)} ${what} occurred in ${String(ERROR_STORM_WINDOW_MS)} ms. The library ignores the other ${what} in this window.`,
  );
  return false;
}

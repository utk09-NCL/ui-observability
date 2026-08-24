// src/utils/sequence.ts
//
// Per-context record ordering. Timestamps cannot provide it: wall clocks are
// skewed between machines and step backwards when NTP corrects them, so two
// records can reach the backend in the wrong order with nothing in the output
// to show it.
//
// Numbers from two contexts are unrelated; what relates those records is the
// correlation ids. Paired with the context id this is a total order over one
// realm. An increment has no failure mode, so this file has no diagnostics
// dependency.

/** A monotonic counter, meaningful only alongside the context id it is paired with. */
export class Sequence {
  /**
   * The last number handed out. Per instance, not per module: two runtimes
   * sharing a counter would each see holes, and a hole reads as a lost record.
   */
  private value = 0;

  /**
   * The next number. Counts from one, leaving zero as an obviously-unset value.
   *
   * No wrap handling: at a thousand records a second, reaching the largest safe
   * integer outlasts any document.
   */
  next(): number {
    return ++this.value;
  }

  /**
   * Start from one again, for a runtime torn down and configured afresh, where
   * continuing the count would imply a continuity with the previous run.
   */
  reset(): void {
    this.value = 0;
  }
}

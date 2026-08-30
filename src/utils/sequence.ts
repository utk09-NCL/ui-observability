// src/utils/sequence.ts
//
// Generates monotonic sequence numbers for deterministic per-context record
// ordering. Clocks step and two records share a millisecond, so timestamps cannot
// order them. One counter per context: a shared counter shows holes, and a hole
// reads as a lost record.

/** Monotonic sequence counter establishing total record ordering within an execution context. */
export class Sequence {
  /** Last emitted sequence counter value. */
  private value = 0;

  /**
   * Increments and returns the next monotonic sequence number starting at 1.
   * @returns Next sequence number.
   */
  next(): number {
    return ++this.value;
  }

  /**
   * Resets the sequence counter to zero, for a runtime configured afresh.
   * Continuing the count implies continuity with the previous run.
   */
  reset(): void {
    this.value = 0;
  }
}

// src/utils/sequence.ts
//
// Generates monotonic sequence numbers that order the records of each context.
// Timestamps cannot order records. A clock can step, and two records can share a
// millisecond. Each context has its own counter. A shared counter shows gaps, and
// a gap looks like a lost record. The counter does not reset. A reset repeats
// numbers in one context.

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
}

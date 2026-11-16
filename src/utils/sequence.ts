// src/utils/sequence.ts
//
// Generates monotonic sequence numbers that order each context's records. Timestamps can't
// order records, because a clock can step and two records can share a millisecond. Each
// context has its own counter, because a shared counter shows gaps and a gap looks like a
// lost record. The counter never resets, because a reset would repeat numbers in one context.

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

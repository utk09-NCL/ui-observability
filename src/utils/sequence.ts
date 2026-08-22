// src/utils/sequence.ts
//
// The counter that puts records back in the order they happened.
//
// Sorting by timestamp does not do that. Wall clocks are skewed between the
// machines on one desk, and a single machine's clock steps backwards whenever
// NTP corrects it, so two records a millisecond apart can reach the backend
// claiming the wrong order, or the same instant, and neither is visible in the
// output. A counter has neither problem: it costs one increment, it never goes
// backwards, and it does not care what the clock is doing.
//
// It orders one context and nothing wider. Two contexts count independently, so
// comparing a number from one against a number from another is meaningless, and
// what relates their records is the correlation ids instead. Paired with the
// context id, though, this is a total order over one realm, which is the
// strongest ordering a browser can offer.
//
// Nothing here can throw. An increment has no failure mode, which makes this one
// of the few files with no diagnostics dependency.

/**
 * A monotonic counter, meaningful only alongside the context id it is paired with.
 *
 * Per instance rather than per module. Two runtimes in one document each need
 * their own run of numbers; sharing one would leave both of their sequences full
 * of holes, and a hole is indistinguishable from a record that was dropped in
 * transit, which is exactly the question this field is meant to answer.
 */
export class Sequence {
  /**
   * The last number handed out.
   *
   * Starts at zero so that the first `next()` returns one, which keeps zero
   * available as an obviously-unset value. A record legitimately carrying
   * sequence zero would be indistinguishable from one whose sequence was lost.
   */
  private value = 0;

  /**
   * The next number in the sequence.
   *
   * On the record path, once per record, so it stays an increment and nothing
   * else. It never repeats within one context and it needs no wrap handling: at
   * a thousand records a second, reaching the largest safe integer takes longer
   * than any document has ever been open.
   */
  next(): number {
    return ++this.value;
  }

  /**
   * Start counting from one again.
   *
   * For when the context this sequence describes stops being the same context:
   * a runtime torn down and configured afresh, where continuing the old count
   * would imply a continuity with the previous run that no longer exists.
   */
  reset(): void {
    this.value = 0;
  }
}

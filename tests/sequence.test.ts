import { describe, expect, it } from "vitest";
import { Sequence } from "../src/utils/sequence";

describe("Sequence", () => {
  it("is monotonic from one, and resettable", () => {
    const seq = new Sequence();

    expect([seq.next(), seq.next(), seq.next()]).toEqual([1, 2, 3]);

    seq.reset();
    expect(seq.next()).toBe(1);
  });

  it("starts at one rather than zero, so a lost sequence cannot look like a real one", () => {
    // Zero is worth keeping as the obviously-unset value. A record legitimately
    // carrying sequence zero would be indistinguishable from one whose sequence
    // never made it onto the record at all.
    expect(new Sequence().next()).toBe(1);
  });

  it("counts per instance, so two runtimes do not punch holes in each other's run", () => {
    // A hole in a sequence is indistinguishable from a record dropped in
    // transit, which is the one question this field exists to answer. Sharing
    // module state between two runtimes would put holes in both.
    const a = new Sequence();
    const b = new Sequence();

    a.next();
    a.next();

    expect(b.next()).toBe(1);
    expect(a.next()).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import { Sequence } from "../src/utils/sequence";

describe("Sequence", () => {
  it("is monotonic from one", () => {
    const seq = new Sequence();

    expect([seq.next(), seq.next(), seq.next()]).toEqual([1, 2, 3]);
  });

  it("starts at one rather than zero, so a lost sequence cannot look like a real one", () => {
    // Keep zero as the clear unset value. A record with a real sequence of zero then looks the same
    // as a record with no sequence.
    expect(new Sequence().next()).toBe(1);
  });

  it("counts per instance, so two runtimes do not punch holes in each other's run", () => {
    // A hole in a sequence looks the same as a record that the network lost. This field exists to
    // answer that one question. Shared module state between two runtimes puts holes in both.
    const a = new Sequence();
    const b = new Sequence();

    a.next();
    a.next();

    expect(b.next()).toBe(1);
    expect(a.next()).toBe(3);
  });
});

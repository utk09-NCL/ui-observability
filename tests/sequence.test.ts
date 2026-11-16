import { describe, expect, it } from "vitest";
import { Sequence } from "../src/utils/sequence";

describe("Sequence", () => {
  it("is monotonic from one", () => {
    const seq = new Sequence();

    expect([seq.next(), seq.next(), seq.next()]).toEqual([1, 2, 3]);
  });

  it("starts at one rather than zero, so a lost sequence cannot look like a real one", () => {
    // Zero stays reserved as the obvious unset value. Otherwise a record with a real sequence of
    // zero would look the same as a record with no sequence.
    expect(new Sequence().next()).toBe(1);
  });

  it("counts per instance, so two runtimes do not punch holes in each other's run", () => {
    // A hole in a sequence looks exactly like a record the network lost, and answering that one
    // question is why this field exists. Module state shared between two runtimes would put holes
    // in both.
    const a = new Sequence();
    const b = new Sequence();

    a.next();
    a.next();

    expect(b.next()).toBe(1);
    expect(a.next()).toBe(3);
  });
});

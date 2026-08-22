import { describe, expect, it } from "vitest";
import { type Breadcrumb, BreadcrumbBuffer } from "../src/core/breadcrumbs";

/** A crumb with a fixed timestamp, since ring ordering is what these tests exercise, not the clock. */
const crumb = (message: string): Breadcrumb => ({ t: 0, category: "log", message });

const messages = (buffer: BreadcrumbBuffer): string[] => buffer.snapshot().map((c) => c.message);

describe("BreadcrumbBuffer", () => {
  it("keeps crumbs in push order before the ring is full", () => {
    const buffer = new BreadcrumbBuffer(3);
    buffer.push(crumb("A"));
    buffer.push(crumb("B"));

    expect(messages(buffer)).toEqual(["A", "B"]);
  });

  it("holds every crumb, still in order, the moment it fills exactly to capacity", () => {
    // The push that lands on the last empty slot also wraps the write pointer
    // back to zero, which is the same pointer value an untouched ring starts
    // at. The `filled` flag is what keeps the two from being read as the
    // same state, and this is the push where it first flips.
    const buffer = new BreadcrumbBuffer(3);
    buffer.push(crumb("A"));
    buffer.push(crumb("B"));
    buffer.push(crumb("C"));

    expect(messages(buffer)).toEqual(["A", "B", "C"]);
  });

  it("overwrites only the oldest crumb on the push one past capacity", () => {
    const buffer = new BreadcrumbBuffer(3);
    buffer.push(crumb("A"));
    buffer.push(crumb("B"));
    buffer.push(crumb("C"));
    buffer.push(crumb("D"));

    expect(messages(buffer)).toEqual(["B", "C", "D"]);
  });

  it("keeps dropping the oldest crumb across many wraps, never losing chronological order", () => {
    const buffer = new BreadcrumbBuffer(3);
    for (const message of ["A", "B", "C", "D", "E"]) {
      buffer.push(crumb(message));
    }

    expect(messages(buffer)).toEqual(["C", "D", "E"]);
  });

  it("keeps the newest crumbs and forgets the rest when shrunk", () => {
    const buffer = new BreadcrumbBuffer(5);
    for (const message of ["A", "B", "C", "D"]) {
      buffer.push(crumb(message));
    }

    buffer.resize(2);

    expect(messages(buffer)).toEqual(["C", "D"]);
    buffer.push(crumb("E"));
    expect(messages(buffer)).toEqual(["D", "E"]);
  });

  it("keeps every existing crumb, in order, when grown", () => {
    const buffer = new BreadcrumbBuffer(2);
    buffer.push(crumb("A"));
    buffer.push(crumb("B"));

    buffer.resize(5);

    expect(messages(buffer)).toEqual(["A", "B"]);

    // The new capacity has to be real, not cosmetic: three more pushes must
    // not wrap a ring that is genuinely five wide.
    buffer.push(crumb("C"));
    buffer.push(crumb("D"));
    buffer.push(crumb("E"));

    expect(messages(buffer)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("treats a resize to its current capacity as a no-op", () => {
    // clamped === this.capacity, taken with no clamping in play: the
    // requested capacity already equals the stored one.
    const buffer = new BreadcrumbBuffer(5);
    for (const message of ["A", "B", "C"]) {
      buffer.push(crumb(message));
    }

    buffer.resize(5);

    expect(messages(buffer)).toEqual(["A", "B", "C"]);
  });

  it("short-circuits a below-minimum resize when already at the minimum", () => {
    // clamped === this.capacity taken by way of the clamp instead of by
    // matching input: resize(0) clamps to 1, which is what a buffer built
    // with capacity 1 already holds.
    const buffer = new BreadcrumbBuffer(1);
    buffer.push(crumb("A"));

    buffer.resize(0);

    expect(messages(buffer)).toEqual(["A"]);
    // The early return has to leave the ring itself usable, not just its
    // last snapshot: the next push must behave as an ordinary capacity-1 ring.
    buffer.push(crumb("B"));
    expect(messages(buffer)).toEqual(["B"]);
  });

  it("clamps a zero capacity up to one instead of storing nothing or throwing", () => {
    // The guide's version threw on this input. This constructor runs inside
    // configure(), where a thrown error would take the host application down
    // while it was setting logging up, so it clamps instead of rejecting.
    expect(() => new BreadcrumbBuffer(0)).not.toThrow();

    const buffer = new BreadcrumbBuffer(0);
    buffer.push(crumb("A"));
    // A true capacity of zero would make the write pointer advance modulo
    // zero, which is NaN, so every crumb would land on index NaN and none
    // would ever be read back. Proof that did not happen: this behaves as an
    // ordinary capacity-one ring, one crumb in, that same crumb out.
    expect(messages(buffer)).toEqual(["A"]);

    buffer.push(crumb("B"));
    expect(messages(buffer)).toEqual(["B"]);
  });

  it("empties the ring directly, not only as a side effect of resize", () => {
    const buffer = new BreadcrumbBuffer(3);
    buffer.push(crumb("A"));
    buffer.push(crumb("B"));
    buffer.push(crumb("C"));

    buffer.clear();

    expect(messages(buffer)).toEqual([]);
    // A push right after clear must not read as a continuation of the old
    // trail: both the write pointer and the filled flag have to have reset.
    buffer.push(crumb("D"));
    expect(messages(buffer)).toEqual(["D"]);
  });

  it("hands back a fresh array on every call, so a caller cannot mutate the stored trail", () => {
    const buffer = new BreadcrumbBuffer(3);
    buffer.push(crumb("A"));

    const first = buffer.snapshot();
    first.push(crumb("tampered"));

    expect(buffer.snapshot()).not.toBe(first);
    expect(messages(buffer)).toEqual(["A"]);
  });

  it("stores a crumb by reference, never a copy", () => {
    const original = crumb("A");
    const buffer = new BreadcrumbBuffer(3);

    buffer.push(original);

    expect(buffer.snapshot()[0]).toBe(original);
  });
});

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

  it("empties the ring and leaves it usable", () => {
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

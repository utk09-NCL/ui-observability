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
    // The push to the last empty slot also moves the write pointer back to zero. An untouched ring
    // starts at the same pointer value. The `filled` flag tells the two states apart. This push is
    // the first one that sets it.
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
    // The version in the guide threw on this input. This constructor runs inside configure(). A
    // throw there stops the host application during its logging setup. The constructor clamps the
    // value. It does not reject it.
    expect(() => new BreadcrumbBuffer(0)).not.toThrow();

    const buffer = new BreadcrumbBuffer(0);
    buffer.push(crumb("A"));
    // A true capacity of zero makes the write pointer advance modulo zero. The result is NaN. Each
    // crumb then goes to index NaN. The ring gives no crumb back. This test proves that this does
    // not occur. The ring acts as an ordinary ring of capacity one. One crumb goes in. The same
    // crumb comes out.
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
    // A push after clear() must not continue the old trail. The write pointer and the filled flag
    // must both reset.
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

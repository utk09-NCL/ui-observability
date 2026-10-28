import { describe, expect, it } from "vitest";
import { patch } from "../src/utils/patch";

/** A host object with one method that a capture wraps. */
interface Host {
  run: (value: number) => number;
}

describe("patch", () => {
  it("installs the wrapper and gives it the original", () => {
    const original = (value: number): number => value + 1;
    const host: Host = { run: original };

    patch(host, "run", (inner) => (value) => inner(value) * 10);

    expect(host.run(1)).toBe(20);
  });

  it("restores the original when the property still holds the wrapper", () => {
    const original = (value: number): number => value;
    const host: Host = { run: original };

    const restore = patch(host, "run", (inner) => (value) => inner(value));

    expect(restore()).toBe(true);
    expect(host.run).toBe(original);
  });

  it("leaves a later wrapper in place and returns false", () => {
    const host: Host = { run: (value) => value };
    const restore = patch(host, "run", (inner) => (value) => inner(value));
    const ours = host.run;
    const later = (value: number): number => ours(value);
    host.run = later;

    expect(restore()).toBe(false);
    expect(host.run).toBe(later);
  });
});

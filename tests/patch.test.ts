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

  it("restores an own original as an own property", () => {
    const original = (value: number): number => value;
    const host: Host = { run: original };

    patch(host, "run", (inner) => (value) => inner(value))();

    // console, fetch, XMLHttpRequest and WebSocket keep their own property after a restore.
    expect(Object.hasOwn(host, "run")).toBe(true);
    expect(host.run).toBe(original);
  });

  it("makes an inherited original inherited again after the restore", () => {
    class Inherited {
      run(value: number): number {
        return value;
      }
    }
    const host = new Inherited();
    const restore = patch(host, "run", (inner) => (value) => inner.call(host, value) + 1);
    expect(Object.hasOwn(host, "run")).toBe(true);

    expect(restore()).toBe(true);

    expect(Object.hasOwn(host, "run")).toBe(false);
    expect(host.run).toBe(Inherited.prototype.run);
  });

  it("lets a later patch of the prototype run after an inherited original is restored", () => {
    class Inherited {
      run(value: number): number {
        return value;
      }
    }
    const host = new Inherited();
    patch(host, "run", (inner) => (value) => inner.call(host, value) + 1)();

    // A router or a second SDK patches the prototype after us, as some tools do.
    const native = Inherited.prototype.run;
    Inherited.prototype.run = function (this: Inherited, value: number): number {
      return native.call(this, value) * 100;
    };

    expect(host.run(1)).toBe(100);
  });

  it("keeps a later wrapper on an inherited property and returns false", () => {
    class Inherited {
      run(value: number): number {
        return value;
      }
    }
    const host = new Inherited();
    const restore = patch(host, "run", (inner) => (value) => inner.call(host, value));
    const later = (value: number): number => value * 2;
    host.run = later;

    expect(restore()).toBe(false);
    expect(host.run).toBe(later);
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

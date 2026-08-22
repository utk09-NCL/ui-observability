import { describe, expect, it } from "vitest";
import { ContextStore } from "../src/core/context";

describe("ContextStore", () => {
  it("sets, reads, removes and clears", () => {
    const store = new ContextStore();
    store.set("desk", "eq-flow");
    store.setMany({ user: "u1", region: "emea" });

    expect(store.get("desk")).toBe("eq-flow");
    expect(store.getAll()).toEqual({ desk: "eq-flow", user: "u1", region: "emea" });

    store.remove("user");
    expect(store.get("user")).toBeUndefined();
    expect(store.getAll()).toEqual({ desk: "eq-flow", region: "emea" });

    store.clear();
    expect(store.getAll()).toEqual({});
  });

  it("is instance-owned, so two runtimes cannot leak into each other", () => {
    // The reason this is not a module-level Map. A static store makes every
    // test in the suite depend on the order the files happened to run in, and
    // makes two runtimes in one document share one user's identifiers.
    const a = new ContextStore();
    const b = new ContextStore();

    a.set("desk", "eq-flow");

    expect(b.getAll()).toEqual({});
  });

  it("replaces a value on a second set rather than keeping both", () => {
    const store = new ContextStore();

    store.set("region", "emea");
    store.set("region", "apac");

    expect(store.get("region")).toBe("apac");
    expect(Object.keys(store.getAll())).toEqual(["region"]);
  });

  it("merges on setMany rather than replacing what is already there", () => {
    // A caller that sets a region must not silently drop the user id some
    // other part of the application set a moment earlier.
    const store = new ContextStore();
    store.set("user", "u1");

    store.setMany({ region: "emea" });
    store.setMany({});

    expect(store.getAll()).toEqual({ user: "u1", region: "emea" });
  });

  it("treats removing an absent key as a no-op", () => {
    const store = new ContextStore();
    store.set("user", "u1");

    store.remove("never-set");

    expect(store.getAll()).toEqual({ user: "u1" });
  });

  it("stays usable after clear", () => {
    // clear() empties the store, it does not retire it. A sign-out is followed
    // by a sign-in.
    const store = new ContextStore();
    store.set("user", "u1");

    store.clear();
    store.set("user", "u2");

    expect(store.getAll()).toEqual({ user: "u2" });
  });

  it("stores values verbatim, because sanitizing belongs where the record is built", () => {
    // The limits that govern sanitizing come from a config the consumer can
    // replace at any time. A value cleaned on the way in would have been
    // cleaned against limits that no longer apply by the time it is sent.
    const store = new ContextStore();
    const value = { nested: { deep: true } };

    store.set("session", value);

    expect(store.get("session")).toBe(value);
  });

  it("returns a fresh snapshot from getAll, so a caller cannot mutate the store", () => {
    // The record builder merges this object under the scoped and per-call
    // attributes. Handing out the live map would let that merge, a sanitizer,
    // or a consumer holding the result rewrite the context by accident.
    const store = new ContextStore();
    store.set("user", "u1");

    const first = store.getAll();
    first.user = "tampered";

    expect(store.get("user")).toBe("u1");
    expect(store.getAll()).not.toBe(first);
    expect(store.getAll()).toEqual({ user: "u1" });
  });

  it("keeps prototype keys as ordinary data, which is why the store is a Map", () => {
    // On a plain object `__proto__` is a setter, so this pair would write to
    // the prototype chain instead of being stored. Consumers do echo
    // user-supplied keys into the context.
    const store = new ContextStore();
    const payload = { polluted: true };

    store.set("__proto__", payload);
    store.set("constructor", "not a function");

    expect(store.get("__proto__")).toBe(payload);
    expect(store.get("constructor")).toBe("not a function");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const snapshot = store.getAll();
    // Object.fromEntries defines properties rather than assigning them, so the
    // key survives the round trip as an own property and the snapshot's own
    // prototype is untouched.
    expect(Object.getOwnPropertyNames(snapshot)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  });

  it("cannot tell a stored undefined from an absent key, and does not pretend to", () => {
    // Both serialize to the same absence on a record, so the ambiguity costs
    // nothing and keeping the store dumb is worth more than a has() method
    // nothing calls.
    const store = new ContextStore();

    store.set("user", undefined);

    expect(store.get("user")).toBeUndefined();
    expect(store.get("never-set")).toBeUndefined();
    expect(Object.keys(store.getAll())).toEqual(["user"]);
  });
});

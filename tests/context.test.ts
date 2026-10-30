import { describe, expect, it } from "vitest";
import { ContextStore } from "../src/core/context";

describe("ContextStore", () => {
  it("sets, reads and removes", () => {
    const store = new ContextStore();
    store.set("desk", "eq-flow");
    store.setMany({ user: "u1", region: "emea" });

    expect(store.getAll()).toEqual({ desk: "eq-flow", user: "u1", region: "emea" });

    store.remove("user");
    expect(store.getAll()).toEqual({ desk: "eq-flow", region: "emea" });
  });

  it("is instance-owned, so two runtimes cannot leak into each other", () => {
    // This is why the store is not a module-level Map. A static store makes each test depend on the
    // order of the test files. It also makes two runtimes in one document share the identifiers of
    // one user.
    const a = new ContextStore();
    const b = new ContextStore();

    a.set("desk", "eq-flow");

    expect(b.getAll()).toEqual({});
  });

  it("replaces a value on a second set rather than keeping both", () => {
    const store = new ContextStore();

    store.set("region", "emea");
    store.set("region", "apac");

    expect(store.getAll()).toEqual({ region: "apac" });
  });

  it("merges on setMany rather than replacing what is already there", () => {
    // A caller that sets a region must not drop a user id. Another part of the application can set
    // that id just before.
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

  it("stores values verbatim, because sanitizing belongs where the record is built", () => {
    // The consumer can replace the config that sets the sanitize limits at any time. A value that
    // the store cleans on input uses old limits. Those limits do not apply at the time of the send.
    const store = new ContextStore();
    const value = { nested: { deep: true } };

    store.set("session", value);

    expect(store.getAll().session).toBe(value);
  });

  it("returns a fresh snapshot from getAll, so a caller cannot mutate the store", () => {
    // The record builder merges this object under the scoped and per-call attributes. If the store
    // gives out the live map, three parties can change the context by accident. They are that
    // merge, a sanitizer and a consumer that keeps the result.
    const store = new ContextStore();
    store.set("user", "u1");

    const first = store.getAll();
    first.user = "tampered";

    expect(store.getAll()).not.toBe(first);
    expect(store.getAll()).toEqual({ user: "u1" });
  });

  it("keeps prototype keys as ordinary data, which is why the store is a Map", () => {
    // On a plain object, `__proto__` is a setter. This pair then writes to the prototype chain. The
    // store does not keep it. Consumers do put keys from users into the context.
    const store = new ContextStore();
    const payload = { polluted: true };

    store.set("__proto__", payload);
    store.set("constructor", "not a function");

    const snapshot = store.getAll();
    expect(Object.getOwnPropertyDescriptor(snapshot, "__proto__")?.value).toBe(payload);
    expect(snapshot.constructor).toBe("not a function");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // Object.fromEntries defines properties. It does not assign them. The key stays an own
    // property. The prototype of the snapshot does not change.
    expect(Object.getOwnPropertyNames(snapshot)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  });

  it("cannot tell a stored undefined from an absent key, and does not pretend to", () => {
    // Both values serialize to the same absence on a record. The difference has no cost. A simple
    // store is better than a has() method that no code calls.
    const store = new ContextStore();

    store.set("user", undefined);

    expect(store.getAll().user).toBeUndefined();
    expect(store.getAll()["never-set"]).toBeUndefined();
    expect(Object.keys(store.getAll())).toEqual(["user"]);
  });
});

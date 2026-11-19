import { describe, expect, it } from "vitest";
import { ContextStore } from "../src/core/context";

describe("ContextStore", () => {
  it("sets, reads and removes", () => {
    const store = new ContextStore();
    store.merge({ desk: "eq-flow" });
    store.merge({ user: "u1", region: "emea" });

    expect(store.getAll()).toEqual({ desk: "eq-flow", user: "u1", region: "emea" });

    store.remove("user");
    expect(store.getAll()).toEqual({ desk: "eq-flow", region: "emea" });
  });

  it("is instance-owned, so two runtimes cannot leak into each other", () => {
    // This is why the store is not a module-level Map. A static store makes every test depend on
    // the order of the test files, and makes two runtimes in one document share one user's
    // identifiers.
    const a = new ContextStore();
    const b = new ContextStore();

    a.merge({ desk: "eq-flow" });

    expect(b.getAll()).toEqual({});
  });

  it("replaces a value on a second set rather than keeping both", () => {
    const store = new ContextStore();

    store.merge({ region: "emea" });
    store.merge({ region: "apac" });

    expect(store.getAll()).toEqual({ region: "apac" });
  });

  it("merges rather than replacing what is already there", () => {
    // A caller that sets a region must not drop a user id that another part of the application
    // set just before.
    const store = new ContextStore();
    store.merge({ user: "u1" });

    store.merge({ region: "emea" });
    store.merge({});

    expect(store.getAll()).toEqual({ user: "u1", region: "emea" });
  });

  it("removes a key for null and keeps the current value for undefined", () => {
    const store = new ContextStore();
    store.merge({ user: "u1", region: "emea", desk: "eq-flow" });

    store.merge({ user: null, region: undefined, desk: "fx" });

    expect(store.getAll()).toEqual({ region: "emea", desk: "fx" });
  });

  it("treats removing an absent key as a no-op", () => {
    const store = new ContextStore();
    store.merge({ user: "u1" });

    store.remove("never-set");

    expect(store.getAll()).toEqual({ user: "u1" });
  });

  it("stores values verbatim, because sanitizing belongs where the record is built", () => {
    // The consumer can replace the config that sets the sanitize limits at any time. A value
    // cleaned on input would use old limits that no longer apply when the record is sent.
    const store = new ContextStore();
    const value = { nested: { deep: true } };

    store.merge({ session: value });

    expect(store.getAll().session).toBe(value);
  });

  it("returns a fresh snapshot from getAll, so a caller cannot mutate the store", () => {
    // The record builder merges this object under the scoped and per-call attributes. If the store
    // handed out the live map, that merge, a sanitizer or a consumer that keeps the result could
    // each change the context by accident.
    const store = new ContextStore();
    store.merge({ user: "u1" });

    const first = store.getAll();
    first.user = "tampered";

    expect(store.getAll()).not.toBe(first);
    expect(store.getAll()).toEqual({ user: "u1" });
  });

  it("keeps prototype keys as ordinary data, which is why the store is a Map", () => {
    // On a plain object, `__proto__` is a setter, so this pair would write to the prototype chain
    // instead of being stored. Consumers do put user-supplied keys into the context.
    const store = new ContextStore();
    const payload = { polluted: true };

    // Object.fromEntries defines the key, so the app's map really holds an own __proto__ key.
    store.merge(Object.fromEntries([["__proto__", payload]]));
    store.merge({ constructor: "not a function" });

    const snapshot = store.getAll();
    expect(Object.getOwnPropertyDescriptor(snapshot, "__proto__")?.value).toBe(payload);
    expect(snapshot.constructor).toBe("not a function");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // Object.fromEntries defines properties instead of assigning them, so the key stays an own
    // property and the snapshot's prototype doesn't change.
    expect(Object.getOwnPropertyNames(snapshot)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  });

  it("stores no key for an undefined value, as configure() keeps a value for undefined", () => {
    const store = new ContextStore();

    store.merge({ user: undefined });

    expect(store.getAll().user).toBeUndefined();
    expect(Object.keys(store.getAll())).toEqual([]);
  });
});

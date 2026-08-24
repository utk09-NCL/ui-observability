// src/core/context.ts
//
// The mapped diagnostic context: the key/value pairs that belong to everything
// this runtime logs from now on rather than to one call. A desk name, a user
// id, a region.
//
// Owned per instance, never per module. A module-level Map is shared by every
// runtime in the realm, which makes two runtimes in one document silently share
// a user id and makes each test depend on the order the files ran in.
//
// Values are stored exactly as given. Sanitizing and size-capping happen where
// the record is built, against the limits in force then, which a consumer can
// replace at any time. A Map accepts any key and value, so there is no failure
// to report and no diagnostics dependency.

/** The context shared by every record this runtime builds. */
export class ContextStore {
  /**
   * A Map rather than an object literal, so that keys like `__proto__` and
   * `constructor` are ordinary data rather than writes to the prototype chain.
   */
  private readonly map = new Map<string, unknown>();

  /**
   * Add or replace one pair.
   *
   * @param key The attribute name, used verbatim on every record from here on.
   * @param value Anything at all. It is sanitized when a record is built, not now.
   */
  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  /**
   * Add or replace several pairs, merging onto what is already there so that a
   * caller setting a region cannot drop the user id someone else set.
   *
   * @param values The pairs to merge in.
   */
  setMany(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.map.set(key, value);
    }
  }

  /**
   * Read one value back.
   *
   * @param key The attribute name.
   * @returns The stored value, or `undefined` when nothing is stored under that
   * key. A stored `undefined` and an absent key are indistinguishable here, and
   * both serialize to the same absence on a record.
   */
  get(key: string): unknown {
    return this.map.get(key);
  }

  /**
   * Forget one pair, so records built after this call no longer carry it.
   *
   * @param key The attribute name. Removing a key that was never set is not an error.
   */
  remove(key: string): void {
    this.map.delete(key);
  }

  /** Forget every pair. The usual caller is a sign-out. */
  clear(): void {
    this.map.clear();
  }

  /**
   * Every pair, as a plain object.
   *
   * @returns A fresh snapshot on each call. Handing out the live map would let
   * a merge target, a sanitizer or a consumer mutate the context by accident.
   */
  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}

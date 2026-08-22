// src/core/context.ts
//
// The mapped diagnostic context: the key/value pairs that belong to everything
// this runtime logs from now on, rather than to one call. A desk name, a user
// id, a region. Set once, and every record built afterwards carries them.
//
// Two decisions shape the whole file.
//
//   1. The map is owned by the instance, never by the module. A module-level
//      Map is shared by every runtime in the realm, which makes each test in a
//      suite depend on the order the files happened to run in, and makes two
//      runtimes in one document silently share a user id.
//   2. It stores values exactly as given and inspects none of them. Sanitizing
//      and size-capping happen where the record is built, because the limits
//      that govern them come from a config a consumer can replace at any time.
//      A value cleaned on the way in would have been cleaned against limits
//      that no longer apply.
//
// Nothing here can throw: a Map accepts any key and any value, so there is no
// failure to report and this is one of the few files with no diagnostics
// dependency.

/**
 * The context shared by every record this runtime builds.
 *
 * Held per instance rather than per module. See the note at the top of the
 * file for why that distinction is load bearing rather than stylistic.
 */
export class ContextStore {
  /**
   * The pairs themselves.
   *
   * A Map rather than a plain object so that keys like `__proto__` and
   * `constructor` are ordinary data. On an object literal they are not, and a
   * consumer echoing user-supplied keys into the context would be writing to
   * the prototype chain instead of storing a value.
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
   * Add or replace several pairs at once.
   *
   * Merges onto what is already there rather than replacing it, so a caller
   * setting a region cannot silently drop the user id someone else set.
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
   * @returns The stored value, or `undefined` when nothing is stored under that key.
   * A stored `undefined` and an absent key are indistinguishable here, which is
   * acceptable because both serialize to the same absence on a record.
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

  /** Forget every pair. The usual caller is a sign-out, where the previous user's identifiers must stop appearing. */
  clear(): void {
    this.map.clear();
  }

  /**
   * Every pair, as a plain object.
   *
   * @returns A fresh snapshot on each call. The record builder merges this
   * under the scoped and per-call attributes, and handing out the live map
   * would let a merge target, a sanitizer or a consumer mutate the context by
   * accident.
   */
  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}

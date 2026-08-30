// src/core/context.ts
//
// Stores ambient contextual attributes merged into all subsequent log records.
// Per instance, never module level. A module Map is shared by every runtime in the
// realm.

/** Key-value store for ambient context attributes attached to log records. */
export class ContextStore {
  /** Backing store mapping attribute keys to raw values. */
  private readonly map = new Map<string, unknown>();

  /**
   * Sets an ambient context attribute key and value.
   * @param key Attribute key.
   * @param value Raw attribute value.
   */
  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  /**
   * Merges multiple key-value pairs into the ambient context store.
   * @param values Record of attributes to merge.
   */
  setMany(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.map.set(key, value);
    }
  }

  /**
   * Retrieves an attribute value by key.
   * @param key Attribute key.
   * @returns Stored attribute value or undefined if not set.
   */
  get(key: string): unknown {
    return this.map.get(key);
  }

  /**
   * Deletes an attribute from the ambient context store.
   * @param key Attribute key to remove.
   */
  remove(key: string): void {
    this.map.delete(key);
  }

  /** Clears all attributes from the ambient context store. */
  clear(): void {
    this.map.clear();
  }

  /**
   * Returns a snapshot copy of all ambient context attributes. A copy: a merge
   * target or sanitizer must not mutate the store.
   * @returns Plain object containing stored key-value pairs.
   */
  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}

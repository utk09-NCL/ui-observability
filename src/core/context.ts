// src/core/context.ts
//
// Stores the ambient context attributes that the logger merges into every later record.
// Keep the store per instance, not at module level: all runtimes in a realm share a module Map.

/** Key-value store for ambient context attributes attached to log records. */
export class ContextStore {
  /** Backing store mapping attribute keys to raw values. */
  private readonly map = new Map<string, unknown>();

  /**
   * Merges attributes into the ambient context. null removes a key, and undefined keeps the
   * current value, as in configure().
   * @param values Attributes to merge.
   */
  merge(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        this.map.delete(key);
      } else if (value !== undefined) {
        this.map.set(key, value);
      }
    }
  }

  /**
   * Removes an attribute from the ambient context.
   * @param key Attribute key to remove.
   */
  remove(key: string): void {
    this.map.delete(key);
  }

  /** Removes all ambient context attributes. */
  clear(): void {
    this.map.clear();
  }

  /**
   * Returns a copy of all ambient context attributes, so a merge target or a sanitizer
   * can't change the store.
   * @returns Plain object with the stored key-value pairs.
   */
  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}

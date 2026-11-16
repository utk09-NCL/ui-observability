// src/core/context.ts
//
// Stores the ambient context attributes that the logger merges into every later record.
// Keep the store per instance, not at module level: all runtimes in a realm share a module Map.

/** Key-value store for ambient context attributes attached to log records. */
export class ContextStore {
  /** Backing store mapping attribute keys to raw values. */
  private readonly map = new Map<string, unknown>();

  /**
   * Sets one ambient context attribute.
   * @param key Attribute key.
   * @param value Raw attribute value.
   */
  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  /**
   * Merges several key-value pairs into the ambient context.
   * @param values Attributes to merge.
   */
  setMany(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.map.set(key, value);
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

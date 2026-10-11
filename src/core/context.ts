// src/core/context.ts
//
// This store keeps ambient context attributes. The logger merges them into each later record.
// Keep the store per instance, not at module level. All runtimes in a realm share a module Map.

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
   * Returns a copy of all ambient context attributes. The copy prevents a merge
   * target or a sanitizer from changing the store.
   * @returns Plain object containing stored key-value pairs.
   */
  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}

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
   * Deletes an attribute from the ambient context store.
   * @param key Attribute key to remove.
   */
  remove(key: string): void {
    this.map.delete(key);
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

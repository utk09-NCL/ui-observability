import { vi } from "vitest";

/** The Storage methods this fake can be told to refuse. */
export type StorageMethod = "getItem" | "setItem" | "removeItem" | "key";

/**
 * A localStorage on a Map. A switch makes one method throw.
 *
 * The test replaces the whole global. It does not spy on it. The Storage of happy-dom is a Proxy. A
 * spy on `Storage.prototype` never runs. The real method answers. The test then shows no failure.
 *
 * @returns The set of blocked methods. Add one to make it throw SecurityError.
 */
export const useFakeLocalStorage = (): Set<StorageMethod> => {
  const store = new Map<string, string>();
  const blocked = new Set<StorageMethod>();

  const check = (method: StorageMethod) => {
    if (blocked.has(method)) {
      throw new DOMException("blocked", "SecurityError");
    }
  };

  vi.stubGlobal("localStorage", {
    get length(): number {
      return store.size;
    },
    key(index: number): string | null {
      check("key");
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      check("getItem");
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      check("setItem");
      store.set(key, value);
    },
    removeItem(key: string): void {
      check("removeItem");
      store.delete(key);
    },
    // This method is necessary. The shared afterEach calls clear() on this stub.
    clear(): void {
      store.clear();
    },
  });

  return blocked;
};

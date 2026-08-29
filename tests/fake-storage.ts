import { vi } from "vitest";

/** The Storage methods this fake can be told to refuse. */
export type StorageMethod = "getItem" | "setItem" | "removeItem" | "key";

/**
 * A localStorage backed by a Map, with a switch that makes one method throw.
 *
 * The whole global is replaced rather than spied on. happy-dom's Storage is a
 * Proxy, so a spy installed on `Storage.prototype` never runs and the real
 * method answers instead, which reads as the failure not happening at all.
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
    // Required: the shared afterEach calls clear() and can reach this stub.
    clear(): void {
      store.clear();
    },
  });

  return blocked;
};

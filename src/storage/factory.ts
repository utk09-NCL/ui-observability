// src/storage/factory.ts
//
// Which store this context gets. "auto" degrades rather than failing:
// IndexedDB, then localStorage, then memory. A logging library that throws at
// construction because the browser is in private mode is worse than one that
// keeps a hundred batches in RAM.

import {
  STORAGE_NAME_INDEXEDDB,
  STORAGE_NAME_MEMORY,
  STORAGE_NAME_NONE,
  STORAGE_PROBE_KEY,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { StorageStrategy } from "../models/config";
import type { GapReporter, StorageAdapter, StorageLimits } from "../models/storage";
import { LocalStorageStorage } from "./local-storage";
import { MemoryStorage } from "./memory-storage";

/**
 * The store for a consumer who asked for none. Every method exists and
 * resolves, because a sender that calls `close()` on shutdown must not crash on
 * the one strategy that keeps nothing.
 */
const noop: StorageAdapter = {
  name: STORAGE_NAME_NONE,
  save: () => Promise.resolve(),
  take: () => Promise.resolve([]),
  remove: () => Promise.resolve(),
  bumpAttempts: () => Promise.resolve(),
  prune: () => Promise.resolve({ batches: 0, records: 0, reason: "expired" as const }),
  count: () => Promise.resolve(0),
  clear: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

/** Whether this context has an IndexedDB to open. Firefox in private mode throws on the read itself. */
function hasIndexedDb(diagnostics: Diagnostics): boolean {
  const available = diagnostics.guard("storage.unavailable", "reading indexedDB", () => {
    const factory = (globalThis as { indexedDB?: IDBFactory | null }).indexedDB;
    return factory !== undefined && factory !== null;
  });

  return available === true;
}

/** Whether localStorage accepts a write. A sandboxed frame, private mode or a policy block does not. */
function hasLocalStorage(diagnostics: Diagnostics): boolean {
  const usable = diagnostics.guard("storage.unavailable", "probing localStorage", () => {
    localStorage.setItem(STORAGE_PROBE_KEY, "1");
    localStorage.removeItem(STORAGE_PROBE_KEY);
    return true;
  });

  return usable === true;
}

/**
 * Build the store this context can actually use.
 *
 * Async only because of the dynamic import below. Nothing here waits on the
 * network, and nothing here throws.
 *
 * @param strategy What the consumer asked for.
 * @param dbName The IndexedDB database name.
 * @param limits Age and count ceilings, passed to whichever adapter wins.
 * @param diagnostics Where every degradation is reported.
 * @param onGap Told when a prune drops records.
 */
export async function createStorage(
  strategy: StorageStrategy,
  dbName: string,
  limits: StorageLimits,
  diagnostics: Diagnostics,
  onGap?: GapReporter,
): Promise<StorageAdapter> {
  if (strategy === STORAGE_NAME_NONE) {
    return noop;
  }
  if (strategy === STORAGE_NAME_MEMORY) {
    return new MemoryStorage(limits, onGap);
  }

  if (strategy === STORAGE_NAME_INDEXEDDB || strategy === "auto") {
    if (hasIndexedDb(diagnostics)) {
      // Imported here rather than at the top of the file, to keep Dexie out of
      // the main bundle. A chunk that fails to load is a real failure, and it
      // costs a fallback rather than the whole logger.
      const adapter = await diagnostics.guardAsync(
        "storage.unavailable",
        "opening IndexedDB",
        async () => {
          const { IndexedDbStorage } = await import("./indexeddb-storage");
          return new IndexedDbStorage(dbName, limits, diagnostics, onGap);
        },
      );
      if (adapter) {
        return adapter;
      }
    }

    if (strategy === STORAGE_NAME_INDEXEDDB) {
      diagnostics.report(
        "storage.degraded",
        "IndexedDB was asked for by name and is unavailable, using memory",
      );
      return new MemoryStorage(limits, onGap);
    }
  }

  if (hasLocalStorage(diagnostics)) {
    return new LocalStorageStorage(limits, diagnostics, onGap);
  }

  diagnostics.report(
    "storage.degraded",
    "no persistent storage available, offline logs are memory only",
  );
  return new MemoryStorage(limits, onGap);
}

// src/storage/factory.ts
//
// Factory resolving storage adapters with graceful degradation from IndexedDB to localStorage to memory.
// Degrades rather than throwing. IndexedDB is unavailable in private mode and
// sandboxed frames.

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
 * No-op storage adapter returned when persistence strategy is "none". Every method
 * resolves. A sender calling close() on shutdown must not crash.
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

/**
 * Evaluates whether IndexedDB is accessible in the current execution context.
 * @param diagnostics Diagnostics reporter.
 * @returns True if IDBFactory is available.
 */
function hasIndexedDb(diagnostics: Diagnostics): boolean {
  const available = diagnostics.guard("storage.unavailable", "reading indexedDB", () => {
    const factory = (globalThis as { indexedDB?: IDBFactory | null }).indexedDB;
    return factory !== undefined && factory !== null;
  });

  return available === true;
}

/**
 * Tests whether localStorage is accessible and accepts write operations.
 * @param diagnostics Diagnostics reporter.
 * @returns True if localStorage probe write succeeds.
 */
function hasLocalStorage(diagnostics: Diagnostics): boolean {
  const usable = diagnostics.guard("storage.unavailable", "probing localStorage", () => {
    localStorage.setItem(STORAGE_PROBE_KEY, "1");
    localStorage.removeItem(STORAGE_PROBE_KEY);
    return true;
  });

  return usable === true;
}

/**
 * Instantiates the requested storage adapter, degrading gracefully if dependencies are unavailable.
 * @param strategy Configured persistence strategy.
 * @param dbName IndexedDB database name.
 * @param limits Storage retention and capacity thresholds.
 * @param diagnostics Diagnostics reporter.
 * @param onGap Optional callback for telemetry gap reporting.
 * @returns Promise resolving to the selected StorageAdapter instance.
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
      // Dynamically imports IndexedDbStorage to omit storage drivers from main
      // bundle. A chunk that fails to load degrades to the next adapter.
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

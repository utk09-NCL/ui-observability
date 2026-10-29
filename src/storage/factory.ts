// src/storage/factory.ts
//
// This module selects a storage adapter. It falls back from IndexedDB to localStorage to memory.
// It falls back and does not throw. IndexedDB is unavailable in private mode and sandboxed
// frames.

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
 * Builds the adapter that keeps nothing. The factory returns it for the "none" strategy. Each
 * method resolves. A sender that calls close() on shutdown must not crash.
 * @param onGap Receives each batch that the adapter does not keep. That batch is a loss.
 * @returns The adapter.
 */
const noop = (onGap?: GapReporter): StorageAdapter => ({
  name: STORAGE_NAME_NONE,
  save: (batch) => {
    onGap?.({ batches: 1, records: batch.records.length, reason: "not_stored" }, [batch]);
    return Promise.resolve();
  },
  take: () => Promise.resolve([]),
  remove: () => Promise.resolve(),
  bumpAttempts: () => Promise.resolve(),
  prune: () => Promise.resolve({ batches: 0, records: 0, reason: "expired" as const }),
  count: () => Promise.resolve(0),
  clear: () => Promise.resolve(),
  close: () => Promise.resolve(),
});

/**
 * Checks if IndexedDB is available in the current context.
 * @param diagnostics Diagnostics reporter.
 * @returns True if IDBFactory is available.
 */
function hasIndexedDb(diagnostics: Diagnostics): boolean {
  const available = diagnostics.guard(
    "storage.unavailable",
    "The library could not read indexedDB.",
    () => {
      const factory = (globalThis as { indexedDB?: IDBFactory | null }).indexedDB;
      return factory !== undefined && factory !== null;
    },
  );

  return available === true;
}

/**
 * Checks if localStorage is available and accepts writes.
 * @param diagnostics Diagnostics reporter.
 * @returns True if localStorage probe write succeeds.
 */
function hasLocalStorage(diagnostics: Diagnostics): boolean {
  const usable = diagnostics.guard(
    "storage.unavailable",
    "The library could not write a test key to localStorage.",
    () => {
      localStorage.setItem(STORAGE_PROBE_KEY, "1");
      localStorage.removeItem(STORAGE_PROBE_KEY);
      return true;
    },
  );

  return usable === true;
}

/**
 * Creates the requested storage adapter. It falls back to the next adapter when
 * a dependency is unavailable.
 * @param strategy Configured persistence strategy.
 * @param dbName IndexedDB database name.
 * @param limits Storage retention and capacity thresholds.
 * @param diagnostics Diagnostics reporter.
 * @param onGap Optional callback for telemetry gap reporting.
 * @returns Promise that resolves to the selected StorageAdapter instance.
 */
export async function createStorage(
  strategy: StorageStrategy,
  dbName: string,
  limits: StorageLimits,
  diagnostics: Diagnostics,
  onGap?: GapReporter,
): Promise<StorageAdapter> {
  if (strategy === STORAGE_NAME_NONE) {
    return noop(onGap);
  }
  if (strategy === STORAGE_NAME_MEMORY) {
    return new MemoryStorage(limits, onGap);
  }

  if (strategy === STORAGE_NAME_INDEXEDDB || strategy === "auto") {
    if (hasIndexedDb(diagnostics)) {
      // Import IndexedDbStorage dynamically. This keeps the driver out of the main bundle. A
      // chunk that does not load falls back to the next adapter.
      const adapter = await diagnostics.guardAsync(
        "storage.unavailable",
        "The library could not open IndexedDB.",
        async () => {
          const { IndexedDbStorage } = await import("./indexeddb-storage");
          const storage = new IndexedDbStorage(dbName, limits, diagnostics, onGap);
          // Open the database here, not on first use. Private mode, a corrupt profile and
          // some WebViews define indexedDB but reject open(). Only a rejection in this
          // block selects the next adapter.
          await storage.open();
          return storage;
        },
      );
      if (adapter) {
        return adapter;
      }
    }

    if (strategy === STORAGE_NAME_INDEXEDDB) {
      diagnostics.report(
        "storage.degraded",
        "IndexedDB is not available. The library uses memory storage instead.",
      );
      return new MemoryStorage(limits, onGap);
    }
  }

  if (hasLocalStorage(diagnostics)) {
    return new LocalStorageStorage(limits, diagnostics, onGap);
  }

  diagnostics.report(
    "storage.degraded",
    "No persistent storage is available. The library keeps undelivered records in memory only.",
  );
  return new MemoryStorage(limits, onGap);
}

// src/storage/factory.ts
//
// Picks a storage adapter, falling back from IndexedDB to localStorage to memory instead of
// throwing. IndexedDB is unavailable in private mode and in sandboxed frames.

import {
  STORAGE_DB_NAME,
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
 * Returns the database name for one application namespace. The sender and the deletion both
 * use this one rule.
 * @param namespace Application namespace. An empty value keeps the name used before namespaces.
 * @returns The IndexedDB database name.
 */
export function storageName(namespace: string): string {
  return namespace ? `${STORAGE_DB_NAME}:${namespace}` : STORAGE_DB_NAME;
}

/**
 * Builds the adapter that keeps nothing, returned for the "none" strategy. Every method
 * resolves, so a sender that calls close() on shutdown doesn't crash.
 * @param onGap Receives every batch the adapter doesn't keep. Each one is a loss.
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
 * Checks whether IndexedDB is available in the current context.
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
 * Checks whether localStorage is available and accepts writes.
 * @param diagnostics Diagnostics reporter.
 * @returns True if a probe write to localStorage succeeds.
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
 * Creates the requested storage adapter, falling back to the next one when a dependency is
 * unavailable.
 * @param strategy The configured persistence strategy.
 * @param dbName IndexedDB database name.
 * @param limits Storage retention and capacity thresholds.
 * @param diagnostics Diagnostics reporter.
 * @param onGap Optional callback for telemetry gap reporting.
 * @returns A promise that resolves to the selected StorageAdapter.
 */
export async function createStorage(
  strategy: StorageStrategy,
  dbName: string,
  limits: StorageLimits,
  diagnostics: Diagnostics,
  onGap?: GapReporter,
  namespace = "",
): Promise<StorageAdapter> {
  if (strategy === STORAGE_NAME_NONE) {
    return noop(onGap);
  }
  if (strategy === STORAGE_NAME_MEMORY) {
    return new MemoryStorage(limits, onGap);
  }

  if (strategy === STORAGE_NAME_INDEXEDDB || strategy === "auto") {
    if (hasIndexedDb(diagnostics)) {
      // The dynamic import keeps the driver out of the main bundle. If the chunk fails to
      // load, we fall back to the next adapter.
      const adapter = await diagnostics.guardAsync(
        "storage.unavailable",
        "The library could not open IndexedDB.",
        async () => {
          const { IndexedDbStorage } = await import("./indexeddb-storage");
          const storage = new IndexedDbStorage(dbName, limits, diagnostics, onGap);
          // Open the database here rather than on first use. Private mode, a corrupt profile
          // and some WebViews define indexedDB but reject open(), and only a rejection in
          // this block selects the next adapter.
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
    return new LocalStorageStorage(
      limits,
      diagnostics,
      onGap,
      namespace ? `ui-observability:namespaced:${encodeURIComponent(namespace)}:batch:` : undefined,
    );
  }

  diagnostics.report(
    "storage.degraded",
    "No persistent storage is available. The library keeps undelivered records in memory only.",
  );
  return new MemoryStorage(limits, onGap);
}

// src/storage/persistence.ts
//
// Asks the browser to keep the stored batches under storage pressure.

import type { Diagnostics } from "../core/diagnostics";
import type { StoragePersistence } from "../models/storage";

/** Global with the storage manager. A worker, Node and an insecure page can lack it. */
interface StorageGlobal {
  navigator?: { storage?: StorageManager };
}

/**
 * Asks the browser for persistent storage. Firefox can show a permission prompt.
 * @param diagnostics Diagnostics reporter.
 * @returns The answer of the browser. It never rejects.
 */
export async function requestPersistence(diagnostics: Diagnostics): Promise<StoragePersistence> {
  const storage = (globalThis as StorageGlobal).navigator?.storage;
  // An old browser can have navigator.storage without persist().
  if (typeof storage?.persist !== "function") {
    return "unsupported";
  }

  const granted = await diagnostics.guardAsync(
    "storage.unavailable",
    "The browser rejected the request for persistent storage.",
    () => storage.persist(),
  );

  return granted === true ? "granted" : "denied";
}

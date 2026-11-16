// src/storage/persistence.ts
//
// Asks the browser to keep the stored batches under storage pressure.

import type { Diagnostics } from "../core/diagnostics";
import type { StoragePersistence } from "../models/storage";

/** The global that holds the storage manager. Workers, Node and insecure pages can lack it. */
interface StorageGlobal {
  navigator?: { storage?: StorageManager };
}

/**
 * Asks the browser for persistent storage. Firefox can show a permission prompt.
 * @param diagnostics Diagnostics reporter.
 * @returns The browser's answer. Never rejects.
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

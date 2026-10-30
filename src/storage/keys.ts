// src/storage/keys.ts
//
// This module builds the localStorage key of a batch. It also returns the sorted keys that start
// with a prefix. A sandboxed frame and private mode throw on first access. They do not return null.

import { BATCH_KEY_TIME_WIDTH } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";

/**
 * Formats a storage key with a zero-padded creation time. The keys sort in FIFO order. Always use
 * batch.createdAt, never Date.now(). A key from Date.now() does not match the written key.
 * @param prefix Storage key prefix.
 * @param batch Target log batch.
 * @returns Prefixed, timestamp-ordered storage key.
 */
export function batchKey(prefix: string, batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${prefix}${at}.${batch.id}`;
}

/**
 * Returns all localStorage keys that start with the prefix, in sorted order.
 * @param prefix Storage key prefix to filter by.
 * @param diagnostics Diagnostics reporter.
 * @returns Sorted array of matching storage keys.
 */
export function keysWithPrefix(prefix: string, diagnostics: Diagnostics): string[] {
  const out: string[] = [];

  diagnostics.guard(
    "storage.unavailable",
    "The library could not list the localStorage keys.",
    () => {
      for (let i = 0; i < localStorage.length; i++) {
        // localStorage.key(i) has the type string | null. It cannot be null below length. A
        // null check here adds a branch that no test can reach.
        const key = String(localStorage.key(i));
        if (key.startsWith(prefix)) {
          out.push(key);
        }
      }
    },
  );

  return out.sort();
}

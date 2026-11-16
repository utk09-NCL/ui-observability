// src/storage/keys.ts
//
// Builds a batch's localStorage key and returns the sorted keys that start with a prefix.
// A sandboxed frame and private mode throw on first access instead of returning null.

import { BATCH_KEY_TIME_WIDTH } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";

/**
 * Formats a storage key with a zero-padded creation time, so the keys sort in FIFO order.
 * Always use batch.createdAt, never Date.now(), or the key won't match the written one.
 * @param prefix Storage key prefix.
 * @param batch The target log batch.
 * @returns The prefixed, timestamp-ordered storage key.
 */
export function batchKey(prefix: string, batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${prefix}${at}.${batch.id}`;
}

/**
 * Returns every localStorage key that starts with the prefix, sorted.
 * @param prefix The storage key prefix to filter by.
 * @param diagnostics Diagnostics reporter.
 * @returns The matching storage keys, sorted.
 */
export function keysWithPrefix(prefix: string, diagnostics: Diagnostics): string[] {
  const out: string[] = [];

  diagnostics.guard(
    "storage.unavailable",
    "The library could not list the localStorage keys.",
    () => {
      for (let i = 0; i < localStorage.length; i++) {
        // localStorage.key(i) is typed string | null, but it can't be null below length. A
        // null check here would add a branch that no test can reach.
        const key = String(localStorage.key(i));
        if (key.startsWith(prefix)) {
          out.push(key);
        }
      }
    },
  );

  return out.sort();
}

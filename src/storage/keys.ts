// src/storage/keys.ts
//
// This module returns the sorted localStorage keys that start with a prefix. A sandboxed
// frame and private mode throw on first access. They do not return null.

import type { Diagnostics } from "../core/diagnostics";

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

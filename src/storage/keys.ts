// src/storage/keys.ts
//
// Enumerates and filters sorted localStorage keys matching a prefix. A sandboxed
// frame and private mode throw on first access rather than returning null.

import type { Diagnostics } from "../core/diagnostics";

/**
 * Returns all sorted localStorage keys matching the specified prefix.
 * @param prefix Storage key prefix to filter by.
 * @param diagnostics Diagnostics reporter.
 * @returns Sorted array of matching storage keys.
 */
export function keysWithPrefix(prefix: string, diagnostics: Diagnostics): string[] {
  const out: string[] = [];

  diagnostics.guard("storage.unavailable", "enumerating localStorage", () => {
    for (let i = 0; i < localStorage.length; i++) {
      // String conversion handles valid indexed key reads without unneeded null branches.
      const key = String(localStorage.key(i));
      if (key.startsWith(prefix)) {
        out.push(key);
      }
    }
  });

  return out.sort();
}

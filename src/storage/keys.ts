// src/storage/keys.ts
//
// Reading a Storage by key, for the two places that keep their batches in one.

import type { Diagnostics } from "../core/diagnostics";

/**
 * Every localStorage key under `prefix`, sorted.
 *
 * A sandboxed frame and a browser in private mode throw on the first access
 * rather than returning nothing, so the whole enumeration is guarded and an
 * unreadable store answers with an empty list.
 *
 * @param prefix What a key must start with. Everything else on the origin is left alone.
 * @param diagnostics Where a store that refuses to be read is reported.
 */
export function keysWithPrefix(prefix: string, diagnostics: Diagnostics): string[] {
  const out: string[] = [];

  diagnostics.guard("storage.unavailable", "enumerating localStorage", () => {
    for (let i = 0; i < localStorage.length; i++) {
      // Stringified rather than null-checked: an index below `length` always
      // names a key, so the null branch is one nothing can take.
      const key = String(localStorage.key(i));
      if (key.startsWith(prefix)) {
        out.push(key);
      }
    }
  });

  return out.sort();
}

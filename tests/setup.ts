// tests/setup.ts
//
// Grows alongside the library. Today it installs the IndexedDB shim and resets
// the two synchronous storages between tests, which is everything the suite
// needs while src/ is still empty.
import "fake-indexeddb/auto";
import { afterEach, vi } from "vitest";

// happy-dom ships no IndexedDB. Without fake-indexeddb, the storage adapter
// and therefore anything that constructs a runtime throws during import.

export const RUNTIME_KEY = Symbol.for("ui-observability.runtime");

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

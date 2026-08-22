// tests/setup.ts   (M0 version, replaced at the end of section 9)
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

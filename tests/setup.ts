// tests/setup.ts
//
// This file grows with the library. The platform cache is the last module-level cache. This file
// resets it. Without the reset, a platform that one test file detects goes into the next file. The
// failure then occurs far from its cause.
import "fake-indexeddb/auto";
import { afterEach, vi } from "vitest";
import { resetPlatformCache } from "../src/utils/platform";

// happy-dom ships no IndexedDB. Without fake-indexeddb, the storage adapter,
// and therefore anything that constructs a runtime, throws during import.

export const RUNTIME_KEY = Symbol.for("ui-observability.runtime");

/** Key of the runtime that shutdown() stopped. A test must not inherit it. */
const STOPPED_KEY = Symbol.for("ui-observability.stopped");

interface DestroyableRuntime {
  destroy?: () => Promise<void>;
}

afterEach(async () => {
  // Shut down the runtime. Do not only forget it. A delete of the symbol leaves a live runtime with
  // no owner. Its retry timer, its unload handlers and its patched fetch stay into the next test
  // file. The failure then occurs in an unrelated place.
  //
  // The runtime does not exist yet. This code uses optional chaining, not a type. It starts to do
  // real work when a runtime exists, with no edit here.
  const registry = globalThis as Record<symbol, DestroyableRuntime | undefined>;
  await registry[RUNTIME_KEY]?.destroy?.();

  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  resetPlatformCache();
  // Use Reflect, not `delete registry[RUNTIME_KEY]`. Lint bans a computed delete. Reflect removes
  // the key fully. It does not leave the key with the value undefined.
  Reflect.deleteProperty(registry, RUNTIME_KEY);
  Reflect.deleteProperty(registry, STOPPED_KEY);
});

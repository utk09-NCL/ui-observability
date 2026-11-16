// tests/setup.ts
//
// This file grows with the library. The platform cache is the last module-level cache, and it is
// reset here. Without the reset, a platform detected in one test file leaks into the next, and the
// failure shows up far from its cause.
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
  // Shut the runtime down rather than only forgetting it. Deleting the symbol leaves a live runtime
  // with no owner, and its retry timer, unload handlers and patched fetch carry over into the next
  // test file. The failure then shows up somewhere unrelated.
  //
  // Not every test starts a runtime, so this uses optional chaining on a minimal shape rather
  // than the runtime's type.
  const registry = globalThis as Record<symbol, DestroyableRuntime | undefined>;
  await registry[RUNTIME_KEY]?.destroy?.();

  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  resetPlatformCache();
  // Use Reflect, not `delete registry[RUNTIME_KEY]`, because lint bans a computed delete. Reflect
  // removes the key entirely instead of leaving it set to undefined.
  Reflect.deleteProperty(registry, RUNTIME_KEY);
  Reflect.deleteProperty(registry, STOPPED_KEY);
});

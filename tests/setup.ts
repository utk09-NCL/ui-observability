// tests/setup.ts
//
// Grows alongside the library. Both module-level caches now exist, and both are
// reset here: leaving them alone is how a platform detected in one test file
// leaks into the next, and the failure then lands nowhere near its cause.
import "fake-indexeddb/auto";
import { afterEach, vi } from "vitest";
import { resetSessionTouch } from "../src/utils/identity";
import { resetPlatformCache } from "../src/utils/platform";

// happy-dom ships no IndexedDB. Without fake-indexeddb, the storage adapter,
// and therefore anything that constructs a runtime, throws during import.

export const RUNTIME_KEY = Symbol.for("ui-observability.runtime");

interface DestroyableRuntime {
  destroy?: () => Promise<void>;
}

afterEach(async () => {
  // Shut down, do not merely forget. Deleting the symbol orphans a live
  // runtime: its retry timer, its unload handlers and its patched fetch all
  // survive into the next test file, and the failure lands somewhere unrelated.
  //
  // The runtime does not exist yet, so this is optional-chained rather than
  // typed. It starts doing real work the moment one lands, with no edit here.
  const registry = globalThis as Record<symbol, DestroyableRuntime | undefined>;
  await registry[RUNTIME_KEY]?.destroy?.();

  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  resetSessionTouch();
  resetPlatformCache();
  // Reflect rather than `delete registry[RUNTIME_KEY]`: a computed delete is
  // banned by lint, and this removes the key outright rather than leaving it
  // present holding undefined.
  Reflect.deleteProperty(registry, RUNTIME_KEY);
});

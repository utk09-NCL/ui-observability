// src/utils/global-scope.ts
//
// Counts open scopes on a global symbol. Two copies of the library on one page then share the
// count. Without it, one copy captures the requests and the console lines of the other copy.

/** Scope that a function runs inside. */
export interface GlobalScope {
  /**
   * Runs a function inside the scope. The scope covers only the synchronous part of the function.
   * @param fn Function to run.
   * @returns The return value of the function.
   */
  run<T>(fn: () => T): T;
  /**
   * Tests if a scope is open.
   * @returns True while a function runs inside the scope.
   */
  open(): boolean;
}

/**
 * Makes a scope whose count is on a global symbol.
 * @param key Key of the global symbol.
 * @returns The scope.
 */
export function globalScope(key: string): GlobalScope {
  const symbol = Symbol.for(key);
  const store = globalThis as unknown as Record<symbol, number | undefined>;
  const depth = (): number => store[symbol] ?? 0;

  return {
    run(fn) {
      // A count stays correct when one scope opens inside another.
      store[symbol] = depth() + 1;

      try {
        return fn();
      } finally {
        store[symbol] = depth() - 1;
      }
    },
    open: () => depth() > 0,
  };
}

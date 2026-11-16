// src/utils/global-scope.ts
//
// Counts open scopes on a global symbol, so two copies of the library on one page share the
// count. Otherwise one copy would capture the other copy's requests and console lines.

/** A scope that a function runs inside. */
export interface GlobalScope {
  /**
   * Runs a function inside the scope. Only the synchronous part of the function is covered.
   * @param fn The function to run.
   * @returns The function's return value.
   */
  run<T>(fn: () => T): T;
  /**
   * Checks whether a scope is open.
   * @returns True while a function is running inside the scope.
   */
  open(): boolean;
}

/**
 * Creates a scope whose count lives on a global symbol.
 * @param key The global symbol's key.
 * @returns The scope.
 */
export function globalScope(key: string): GlobalScope {
  const symbol = Symbol.for(key);
  const store = globalThis as unknown as Record<symbol, number | undefined>;
  const depth = (): number => store[symbol] ?? 0;

  return {
    run(fn) {
      // Counting keeps this correct when one scope opens inside another.
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

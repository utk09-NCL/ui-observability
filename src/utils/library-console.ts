// src/utils/library-console.ts
//
// Marks the console calls that the library makes itself, so the console capture can skip them.
// Without the scope, the capture would record every mirrored line again in an endless loop.

import { LIBRARY_CONSOLE_KEY } from "../constants";
import { globalScope } from "./global-scope";

/** The scope for the library's own console calls. */
const scope = globalScope(LIBRARY_CONSOLE_KEY);

/**
 * Runs a function inside the library console scope.
 * @param fn The function that writes to the console.
 * @returns The function's return value.
 */
export function runAsLibraryConsole<T>(fn: () => T): T {
  return scope.run(fn);
}

/**
 * Checks whether a library console scope is open.
 * @returns True while the library is writing to the console.
 */
export function isLibraryConsole(): boolean {
  return scope.open();
}

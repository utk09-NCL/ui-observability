// src/utils/library-console.ts
//
// Marks the console calls that the library makes itself. The console capture skips a call inside
// this scope. Without the scope, the capture records each mirrored line again, and the loop does
// not stop.

import { LIBRARY_CONSOLE_KEY } from "../constants";
import { globalScope } from "./global-scope";

/** Scope of the library console calls. */
const scope = globalScope(LIBRARY_CONSOLE_KEY);

/**
 * Runs a function inside the library console scope.
 * @param fn Function that writes to the console.
 * @returns The return value of the function.
 */
export function runAsLibraryConsole<T>(fn: () => T): T {
  return scope.run(fn);
}

/**
 * Tests if a library console scope is open.
 * @returns True while the library writes to the console.
 */
export function isLibraryConsole(): boolean {
  return scope.open();
}

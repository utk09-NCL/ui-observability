// src/utils/library-request.ts
//
// Marks the requests that the library starts itself. Network capture skips a request that starts
// inside this scope. A captured library request logs a record. The library then sends that record
// with another request. The loop does not stop.

import { LIBRARY_REQUEST_KEY } from "../constants";
import { globalScope } from "./global-scope";

/** Scope of the library requests. */
const scope = globalScope(LIBRARY_REQUEST_KEY);

/**
 * Runs a function inside the library request scope. The scope covers only the synchronous part
 * of the function. A request that starts after an await is outside the scope.
 * @param fn Function that starts the request.
 * @returns The return value of the function.
 */
export function runAsLibraryRequest<T>(fn: () => T): T {
  return scope.run(fn);
}

/**
 * Tests whether a library request scope is open.
 * @returns True while the library starts a request.
 */
export function isLibraryRequest(): boolean {
  return scope.open();
}

// src/utils/library-request.ts
//
// Marks the requests that the library starts itself. Network capture skips a request that starts
// inside this scope. A captured library request logs a record. The library then sends that record
// with another request. The loop does not stop.

import { LIBRARY_REQUEST_KEY, TRANSPORT_CALL_KEY } from "../constants";
import { globalScope } from "./global-scope";

/** Scope of the library requests. */
const scope = globalScope(LIBRARY_REQUEST_KEY);

/** Global count of the custom transport calls that wait for an answer. */
const calls = Symbol.for(TRANSPORT_CALL_KEY);
const store = globalThis as unknown as Record<symbol, number | undefined>;
const pending = (): number => store[calls] ?? 0;

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
 * Tests if a library request scope is open.
 * @returns True while the library starts a request.
 */
export function isLibraryRequest(): boolean {
  return scope.open();
}

/**
 * Runs a custom transport call and counts it until it settles. The count includes the time after
 * each await, which the library request scope does not cover.
 * @param fn Function that calls the custom transport.
 * @returns Promise that settles with the result of the call.
 */
export async function trackTransportCall<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  store[calls] = pending() + 1;

  try {
    return await fn();
  } finally {
    store[calls] = pending() - 1;
  }
}

/**
 * Tests if a custom transport call waits for an answer.
 * @returns True while a call has not settled.
 */
export function isTransportPending(): boolean {
  return pending() > 0;
}

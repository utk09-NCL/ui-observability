// src/utils/library-request.ts
//
// Marks the requests that the library starts itself, so network capture can skip them. A
// captured library request would log a record, the library would send that record with
// another request, and the loop would never stop.

import { LIBRARY_REQUEST_KEY, TRANSPORT_CALL_KEY } from "../constants";
import { globalScope } from "./global-scope";

/** The scope for the library's own requests. */
const scope = globalScope(LIBRARY_REQUEST_KEY);

/** Global count of custom transport calls that are still waiting for an answer. */
const calls = Symbol.for(TRANSPORT_CALL_KEY);
const store = globalThis as unknown as Record<symbol, number | undefined>;
const pending = (): number => store[calls] ?? 0;

/**
 * Runs a function inside the library request scope. Only the synchronous part of the function
 * is covered, so a request that starts after an await is outside the scope.
 * @param fn The function that starts the request.
 * @returns The function's return value.
 */
export function runAsLibraryRequest<T>(fn: () => T): T {
  return scope.run(fn);
}

/**
 * Checks whether a library request scope is open.
 * @returns True while the library is starting a request.
 */
export function isLibraryRequest(): boolean {
  return scope.open();
}

/**
 * Runs a custom transport call and counts it until it settles. The count includes the time after
 * each await, which the library request scope does not cover.
 * @param fn The function that calls the custom transport.
 * @returns A promise that settles with the call's result.
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
 * Checks whether a custom transport call is still waiting for an answer.
 * @returns True while a call hasn't settled.
 */
export function isTransportPending(): boolean {
  return pending() > 0;
}

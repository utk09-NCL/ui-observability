// src/utils/lock.ts
//
// Coordinates batch draining across the origin with the Web Locks API. Without the lock,
// every window on the origin would drain and send the same batches.

import type { Diagnostics } from "../core/diagnostics";

/** Lock grant object, or null when the lock isn't available. */
type LockGrant = { name: string } | null;

/** Structural interface for navigator.locks operations. */
interface LockManagerLike {
  /**
   * Requests a lock and executes a callback under the acquired lock grant.
   * @param name Lock name.
   * @param options Lock request options.
   * @param callback Callback that runs with the lock grant.
   */
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: LockGrant) => Promise<T>,
  ): Promise<T>;
}

/**
 * Runs an async function under an origin-wide Web Locks API lock. Runs the task directly when
 * the Web Locks API isn't available, or when the lock request fails before it grants anything.
 * @param name Origin-scoped lock identifier.
 * @param diagnostics Diagnostics reporter.
 * @param fn The async task to run while holding the lock.
 * @param options Lock acquisition options.
 * @param options.skipIfBusy When true, the task doesn't run if another context holds the lock.
 * @returns A promise of the task's result. Resolves to undefined when another context holds
 * the lock, or when the task rejects under the lock. A caller that reads undefined as a task
 * result stops rescheduling.
 */
export async function withDrainLock<T>(
  name: string,
  diagnostics: Diagnostics,
  fn: () => Promise<T>,
  { skipIfBusy = true }: { skipIfBusy?: boolean } = {},
): Promise<T | undefined> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;

  // Run the task without a lock when the Web Locks API isn't available.
  if (!locks?.request) {
    return fn();
  }

  try {
    // The task's own failure is caught in the callback, so only the lock manager can reject
    // here. Otherwise a failed task would run a second time without the lock.
    return await locks.request(name, { ifAvailable: skipIfBusy }, (lock) =>
      lock
        ? diagnostics.guardAsync(
            "storage.degraded",
            `The work under the lock ${name} failed. The library skips this run.`,
            fn,
          )
        : Promise.resolve(undefined),
    );
  } catch (error) {
    // An opaque origin rejects every request with a SecurityError, so no other window can hold
    // this lock. Reading that as busy would stop the drain for good.
    diagnostics.report(
      "storage.degraded",
      `The library could not get the lock ${name}. It runs the work without the lock.`,
      undefined,
      error,
    );
    return fn();
  }
}

/**
 * Returns the lock name for one application namespace, so two namespaces on one origin don't
 * wait for each other. Otherwise one application's retry pass would be skipped while the
 * other holds the lock.
 * @param name Base lock name.
 * @param namespace Application storage namespace. An empty value keeps the base name.
 * @returns The lock name for this namespace.
 */
export function lockName(name: string, namespace: string): string {
  return namespace ? `${name}:${encodeURIComponent(namespace)}` : name;
}

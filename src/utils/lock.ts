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
 * the Web Locks API isn't available.
 * @param name Origin-scoped lock identifier.
 * @param diagnostics Diagnostics reporter.
 * @param fn The async task to run while holding the lock.
 * @param options Lock acquisition options.
 * @param options.skipIfBusy When true, the task doesn't run if another context holds the lock.
 * @returns A promise of the task's result. Resolves to undefined when another context holds
 * the lock. A caller that reads undefined as a task result stops rescheduling.
 */
export function withDrainLock<T>(
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

  return diagnostics.guardAsync(
    "storage.degraded",
    `The library could not get the lock ${name}.`,
    () =>
      locks.request(name, { ifAvailable: skipIfBusy }, (lock) =>
        lock ? fn() : Promise.resolve(undefined),
      ),
  );
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

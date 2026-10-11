// src/utils/lock.ts
//
// Coordinates origin-wide batch draining operations using the Web Locks API.
// Without the lock, every window on the origin drains and sends the same batches.

import type { Diagnostics } from "../core/diagnostics";

/** Lock grant object, or null when the lock is not available. */
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
 * Executes an asynchronous function under a Web Locks API origin-wide lock.
 * It runs the task directly when the Web Locks API is not available.
 * @param name Origin-scoped lock identifier.
 * @param diagnostics Diagnostics reporter.
 * @param fn Asynchronous task to execute while holding the lock.
 * @param options Lock acquisition options.
 * @param options.skipIfBusy When true, the task does not run if another context holds the lock.
 * @returns Promise of the task result. It resolves to undefined when another context holds the
 * lock. A caller that reads undefined as a task result stops rescheduling.
 */
export function withDrainLock<T>(
  name: string,
  diagnostics: Diagnostics,
  fn: () => Promise<T>,
  { skipIfBusy = true }: { skipIfBusy?: boolean } = {},
): Promise<T | undefined> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;

  // Run the task without a lock when the Web Locks API is not available.
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

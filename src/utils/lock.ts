// src/utils/lock.ts
//
// Coordinates origin-wide batch draining operations using the Web Locks API.
// Without it every window on the origin drains and sends the same batches

import type { Diagnostics } from "../core/diagnostics";

/** Lock grant object or null if lock acquisition was unavailable. */
type LockGrant = { name: string } | null;

/** Structural interface for navigator.locks operations. */
interface LockManagerLike {
  /**
   * Requests a lock and executes a callback under the acquired lock grant.
   * @param name Lock name.
   * @param options Lock request options.
   * @param callback Callback executed with lock grant.
   */
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: LockGrant) => Promise<T>,
  ): Promise<T>;
}

/**
 * Executes an asynchronous function under a Web Locks API origin-wide lock.
 * Falls back to direct execution in environments without Web Locks support.
 * @param name Origin-scoped lock identifier.
 * @param diagnostics Diagnostics reporter.
 * @param fn Asynchronous task to execute while holding the lock.
 * @param options Lock acquisition options.
 * @param options.skipIfBusy Skips execution if lock is currently held by another context.
 * @returns Promise resolving to the task result, or undefined if the lock was held
 * and nothing ran. A caller that conflates the two stops rescheduling.
 */
export function withDrainLock<T>(
  name: string,
  diagnostics: Diagnostics,
  fn: () => Promise<T>,
  { skipIfBusy = true }: { skipIfBusy?: boolean } = {},
): Promise<T | undefined> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;

  // Falls back to unguarded execution if Web Locks API is unavailable.
  if (!locks?.request) {
    return fn();
  }

  return diagnostics.guardAsync("storage.degraded", `acquiring lock ${name}`, () =>
    locks.request(name, { ifAvailable: skipIfBusy }, (lock) =>
      lock ? fn() : Promise.resolve(undefined),
    ),
  );
}

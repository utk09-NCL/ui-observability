// src/utils/lock.ts
//
// One origin-wide lock around a drain. IndexedDB and localStorage are scoped to
// the origin, not the window, so five same-origin windows share one queue and
// without this each drains and sends the same stored batches. The server
// deduplicates them, but the requests still leave every machine on the desk.
//
// Not leader election: the lock covers one short drain rather than a lifetime,
// so a window that dies holding it costs nothing and needs no recovery.

import type { Diagnostics } from "../core/diagnostics";

/** What the lock manager hands the callback: a grant, or null when another context holds the lock. */
type LockGrant = { name: string } | null;

/** The one `navigator.locks` call this module makes, declared structurally so no DOM lib is required. */
interface LockManagerLike {
  /**
   * Run `callback` under the named lock. Under `ifAvailable` a held lock yields
   * a null grant rather than queueing.
   */
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: LockGrant) => Promise<T>,
  ): Promise<T>;
}

/**
 * Run `fn` under an origin-wide lock.
 *
 * @param name The lock name. Every context on the origin has to spell it the same way.
 * @param diagnostics Where a lock manager that throws is reported.
 * @param fn The work to run while holding the lock.
 * @param options.skipIfBusy Skip this tick when the lock is held, rather than waiting for it.
 * @returns What `fn` returned, or undefined when it never ran. A caller that
 * cannot tell those apart stops rescheduling, and one lost race then ends
 * draining in that window for good.
 */
export function withDrainLock<T>(
  name: string,
  diagnostics: Diagnostics,
  fn: () => Promise<T>,
  { skipIfBusy = true }: { skipIfBusy?: boolean } = {},
): Promise<T | undefined> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;

  // No Web Locks in this host. Running unguarded beats not running: the server
  // still deduplicates on the batch id.
  if (!locks?.request) {
    return fn();
  }

  return diagnostics.guardAsync("storage.degraded", `acquiring lock ${name}`, () =>
    locks.request(name, { ifAvailable: skipIfBusy }, (lock) =>
      lock ? fn() : Promise.resolve(undefined),
    ),
  );
}

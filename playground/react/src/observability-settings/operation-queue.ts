// src/observability-settings/operation-queue.ts
//
// One queue for each call that changes the library: a login, a logout, a restart, a runtime
// configure() from the panel and a run of the cost meter. A rotation takes up to 3 seconds, and
// during it configure() reports config.locked and changes nothing. A restart in the middle of a
// rotation makes the rotation reject. Run one operation at a time and neither can happen.

import { useSyncExternalStore } from "react";

let tail: Promise<void> = Promise.resolve();
let pending = 0;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** True while an operation runs or waits. The panel and the buttons use it to disable input. */
export function isBusy(): boolean {
  return pending > 0;
}

export function subscribeBusy(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Reads the busy state in a component. */
export function useBusy(): boolean {
  return useSyncExternalStore(subscribeBusy, isBusy);
}

/**
 * Runs a task after every earlier task has finished. A task that rejects doesn't stop the queue,
 * and the caller still gets the rejection.
 * @param task The operation to run.
 * @returns The result of the task.
 */
export function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  pending += 1;
  publish();

  const result = tail.then(task);
  const settle = (): void => {
    pending -= 1;
    publish();
  };
  tail = result.then(settle, settle);

  return result;
}

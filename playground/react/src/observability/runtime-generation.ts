// src/observability/runtime-generation.ts
//
// A counter that goes up each time the app starts a new library runtime. shutdown() removes the
// registrations of frames and workers with the old runtime, and a React effect that registered
// them does not run again by itself. A component that lists the generation in the dependencies of
// its effect registers again, so the frame or the worker joins the bus of the new runtime.

import { useSyncExternalStore } from "react";

let generation = 0;
const listeners = new Set<() => void>();

/** Returns the number of runtimes that the app started after the first one. */
export function getRuntimeGeneration(): number {
  return generation;
}

export function subscribeRuntimeGeneration(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Marks a new runtime. Call it after configure() of each shutdown() then configure() path. */
export function bumpRuntimeGeneration(): void {
  generation += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** Reads the generation in a component. */
export function useRuntimeGeneration(): number {
  return useSyncExternalStore(subscribeRuntimeGeneration, getRuntimeGeneration);
}

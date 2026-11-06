import { DEFER_IDLE_TIMEOUT_MS, DEFER_QUEUE_LIMIT } from "../constants";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";

/** Pending logger calls of one runtime. A stopped runtime releases each payload reference. */
interface DeferredQueue {
  work: (() => void)[];
  diagnostics: Diagnostics;
  draining: boolean;
  idle?: number;
  timer?: ReturnType<typeof setTimeout>;
}

const queues = new WeakMap<object, DeferredQueue>();

/** Cancels the scheduled callback before a synchronous drain or a shutdown. */
function cancel(queue: DeferredQueue): void {
  const idle = queue.idle;
  if (idle !== undefined) {
    queue.diagnostics.guard("pipeline.crashed", "The idle callback could not be cancelled.", () => {
      cancelIdleCallback(idle);
    });
    queue.idle = undefined;
  }

  clearTimeout(queue.timer);
  queue.timer = undefined;
}

/** Schedules one idle callback. A timer supports browsers without the idle API. */
function schedule(owner: object, queue: DeferredQueue): void {
  if (typeof requestIdleCallback === "function" && typeof cancelIdleCallback === "function") {
    queue.idle = queue.diagnostics.guard(
      "pipeline.crashed",
      "The idle callback could not be scheduled.",
      () =>
        requestIdleCallback(
          (deadline) => {
            drain(owner, queue, deadline);
          },
          { timeout: DEFER_IDLE_TIMEOUT_MS },
        ),
    );
    if (queue.idle !== undefined) {
      return;
    }
  }

  queue.timer = setTimeout(() => {
    drain(owner, queue);
  }, 0);
  unrefTimer(queue.timer);
}

/** Builds a bounded group of calls. Reentrant calls wait for the next callback. */
function drain(owner: object, queue: DeferredQueue, deadline?: IdleDeadline): void {
  if (queues.get(owner) !== queue || queue.draining) {
    return;
  }

  cancel(queue);
  queue.draining = true;
  const work = queue.work;
  queue.work = [];
  let index = 0;

  while (
    index < work.length &&
    (!deadline || (deadline.didTimeout && index === 0) || deadline.timeRemaining() > 0)
  ) {
    queue.diagnostics.guard(
      "pipeline.crashed",
      "The library could not build a deferred record.",
      work[index],
    );
    index++;
    if (queues.get(owner) !== queue) {
      return;
    }
  }

  queue.work = [...work.slice(index), ...queue.work];
  queue.draining = false;
  if (queue.work.length > 0) {
    schedule(owner, queue);
  } else {
    queues.delete(owner);
  }
}

/** Queues a call without reading its payload. A full queue first builds its pending calls. */
export function deferWrite(
  owner: object,
  work: () => void,
  diagnostics: Diagnostics,
  limit: number,
): void {
  let queue = queues.get(owner);
  const capacity = limit > 0 ? Math.min(limit, DEFER_QUEUE_LIMIT) : DEFER_QUEUE_LIMIT;
  if (queue && queue.work.length >= capacity && !queue.draining) {
    drain(owner, queue);
    queue = queues.get(owner);
  }

  if (queue) {
    if (queue.work.length >= capacity) {
      diagnostics.count("record.dropped_by_ceiling");
      return;
    }
    queue.work.push(work);
    return;
  }

  queue = { work: [work], diagnostics, draining: false };
  queues.set(owner, queue);
  schedule(owner, queue);
}

/** Builds pending calls before a flush, a session change or a delivery identity change. */
export function drainDeferred(owner: object): void {
  const queue = queues.get(owner);
  if (queue) {
    drain(owner, queue);
  }
}

/** Releases calls that a hook queues during shutdown. Those calls have no built records. */
export function cancelDeferred(owner: object): void {
  const queue = queues.get(owner);
  if (queue) {
    cancel(queue);
    queues.delete(owner);
    for (const _work of queue.work) {
      queue.diagnostics.count("record.dropped_by_ceiling");
    }
    queue.work = [];
  }
}

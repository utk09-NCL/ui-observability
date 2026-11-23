// src/storage/emergency-queue.ts
//
// A synchronous localStorage queue that holds oversized batches during unload, to be recovered
// on the next startup. Everything here is synchronous and never throws, because it runs while
// the browser is destroying the document and no promise settles at that point.

import {
  EMERGENCY_LOCK_NAME,
  EMERGENCY_MAX_ENTRIES,
  EMERGENCY_STORAGE_KEY_PREFIX,
  STORAGE_DEADLINE_MS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { isLogBatch, type LogBatch } from "../models/batch";
import type { LossReporter } from "../models/drop";
import type { StorageAdapter } from "../models/storage";
import { withDeadline } from "../utils/deadline";
import { lockName, withDrainLock } from "../utils/lock";
import { batchKey, keysWithPrefix } from "./keys";

/**
 * Parses a raw storage string and validates it as a LogBatch.
 * @param raw The raw serialized string from storage.
 * @param diagnostics Diagnostics reporter.
 * @returns The validated LogBatch, or null if it can't be parsed or is malformed.
 */
function readBatch(raw: string, diagnostics: Diagnostics): LogBatch | null {
  const parsed = diagnostics.guard(
    "storage.degraded",
    "An emergency entry is not valid JSON. The library dropped it.",
    () => JSON.parse(raw) as unknown,
  );

  // The guard above already reported a parse failure.
  if (parsed === undefined) {
    return null;
  }

  if (!isLogBatch(parsed)) {
    diagnostics.report(
      "storage.degraded",
      "An emergency entry is not a batch. The library dropped it.",
    );
    return null;
  }

  return parsed;
}

/**
 * Imports every emergency queue entry into the target adapter, in FIFO order.
 * @param storage The destination storage adapter.
 * @param diagnostics Diagnostics reporter.
 * @returns The total number of recovered batches.
 */
async function importAll(
  storage: StorageAdapter,
  diagnostics: Diagnostics,
  accepts: (batch: LogBatch) => boolean,
  prefix: string,
): Promise<number> {
  let moved = 0;

  for (const key of keysWithPrefix(prefix, diagnostics)) {
    // Read and remove the key in one synchronous step, before the async save, so a second
    // window importing at the same time can't take the same batch. Each entry is parsed once.
    // A batch that belongs to another context stays in the queue.
    const batch = diagnostics.guard(
      "storage.unavailable",
      "The library could not read the emergency queue.",
      (): LogBatch | null => {
        const value = localStorage.getItem(key);
        const parsed = value ? readBatch(value, diagnostics) : null;
        if (parsed && !accepts(parsed)) {
          return null;
        }
        localStorage.removeItem(key);
        return parsed;
      },
    );

    if (!batch) {
      continue;
    }

    try {
      // This runs during startup, so set a deadline. A save that never settles would keep the
      // runtime from becoming ready, and every record would go to the boot buffer.
      await withDeadline(storage.save(batch), STORAGE_DEADLINE_MS);
      moved++;
    } catch (error) {
      diagnostics.report(
        "storage.degraded",
        "The library could not recover an emergency batch.",
        { key },
        error,
      );
    }
  }

  return moved;
}

/**
 * Synchronously writes an unsent batch to the emergency queue during unload.
 * @param batch The oversized log batch.
 * @param diagnostics Diagnostics reporter.
 * @param onLoss Receives the records of old entries the queue drops, and of a batch the
 * store refuses.
 */
export function saveToEmergencyQueue(
  batch: LogBatch,
  diagnostics: Diagnostics,
  onLoss?: LossReporter,
): void {
  // Name the record count, because a full localStorage drops this batch for good. Removing
  // emergency keys can't free quota that other applications' keys are using.
  const prefix = emergencyPrefix(batch.persistenceNamespace);
  const context = `writing the emergency queue, ${String(batch.records.length)} records`;
  const evicted: LogBatch[] = [];

  const saved = diagnostics.guard("storage.quota_exceeded", context, () => {
    const keys = keysWithPrefix(prefix, diagnostics);

    // Remove the oldest entries to keep the queue within its capacity.
    for (const old of keys.slice(0, Math.max(0, keys.length - EMERGENCY_MAX_ENTRIES + 1))) {
      // A key that another window already removed reads as null, and readBatch rejects it.
      const dropped = readBatch(String(localStorage.getItem(old)), diagnostics);
      if (dropped !== null) {
        evicted.push(dropped);
      }
      localStorage.removeItem(old);
    }

    localStorage.setItem(batchKey(prefix, batch), JSON.stringify(batch));
    return true;
  });

  // The exit flush calls this, and a throw here would skip the sender's shutdown.
  diagnostics.guard("pipeline.crashed", "The loss report of the emergency queue failed.", () => {
    if (evicted.length > 0) {
      const records = evicted.flatMap((one) => one.records);
      onLoss?.(
        "exit_queue_full",
        records,
        evicted.map((one) => one.id),
      );
    }

    if (saved !== true) {
      onLoss?.("quota", batch.records, [batch.id]);
    }
  });
}

/**
 * Recovers the batches that earlier shutdowns saved to emergency storage.
 * @param storage The destination storage adapter.
 * @param diagnostics Diagnostics reporter.
 * @returns A promise that resolves to the number of recovered batches.
 */
export async function drainEmergencyQueue(
  storage: StorageAdapter,
  diagnostics: Diagnostics,
  accepts: (batch: LogBatch) => boolean = () => true,
  namespace = "",
): Promise<number> {
  const moved = await withDrainLock(
    lockName(EMERGENCY_LOCK_NAME, namespace),
    diagnostics,
    () => importAll(storage, diagnostics, accepts, emergencyPrefix(namespace)),
    { skipIfBusy: false },
  );

  return moved ?? 0;
}

/**
 * Removes one context's emergency entries, or every entry in its namespace.
 * @param id Delivery context id.
 * @param diagnostics Diagnostics reporter.
 * @param namespace The application's storage namespace.
 * @param all True to remove the entries of every context in this namespace.
 * @returns The context's batches that it removed, so the caller can report their records. With
 * `all` it returns none, because it removes the entries without reading them.
 */
export function clearEmergencyContext(
  id: string,
  diagnostics: Diagnostics,
  namespace = "",
  all = false,
): LogBatch[] {
  const prefix = emergencyPrefix(namespace);
  const removed: LogBatch[] = [];

  diagnostics.guard(
    "storage.unavailable",
    "The library could not clear the retired emergency queue.",
    () => {
      for (const key of keysWithPrefix(prefix, diagnostics)) {
        if (all) {
          localStorage.removeItem(key);
          continue;
        }

        // Another window can remove the key after the list was read, and null isn't a bad entry.
        const raw = localStorage.getItem(key);
        if (raw === null) {
          continue;
        }

        const batch = readBatch(raw, diagnostics);
        if (batch?.routingContextId === id) {
          localStorage.removeItem(key);
          removed.push(batch);
        }
      }
    },
  );

  return removed;
}

/**
 * Returns the emergency storage prefix for one application namespace.
 * @param namespace Application namespace. An empty value uses the previous prefix.
 * @returns The prefix of this application's emergency queue.
 */
function emergencyPrefix(namespace = ""): string {
  return namespace
    ? `ui-observability:namespaced:${encodeURIComponent(namespace)}:emergency:`
    : EMERGENCY_STORAGE_KEY_PREFIX;
}

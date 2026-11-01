// src/storage/emergency-queue.ts
//
// This module keeps a synchronous localStorage queue. It holds oversized batches during unload.
// Startup recovers them. The code is synchronous and never throws. It runs while the browser
// destroys the document. No promise settles at that time.

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
import { withDrainLock } from "../utils/lock";
import { batchKey, keysWithPrefix } from "./keys";

/**
 * Parses a raw storage string and validates it as a LogBatch.
 * @param raw Raw serialized storage string.
 * @param diagnostics Diagnostics reporter.
 * @returns Validated LogBatch or null if unparseable or malformed.
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
 * Imports all emergency queue entries into the target adapter in FIFO order.
 * @param storage Destination storage adapter.
 * @param diagnostics Diagnostics reporter.
 * @returns Total number of recovered batches.
 */
async function importAll(
  storage: StorageAdapter,
  diagnostics: Diagnostics,
  accepts: (batch: LogBatch) => boolean,
  prefix: string,
): Promise<number> {
  let moved = 0;

  for (const key of keysWithPrefix(prefix, diagnostics)) {
    // Read and remove the key in one synchronous step, before the async save. A second window
    // that imports at the same time cannot take the same batch. Parse each entry one time.
    // A batch of another context stays in the queue.
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
      // Set a deadline. This code runs during startup. A save that does not settle keeps the
      // runtime not ready. Each record then goes to the boot buffer.
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
 * Writes an unsent batch to the emergency queue synchronously during unload.
 * @param batch Oversized log batch.
 * @param diagnostics Diagnostics reporter.
 * @param onLoss Receives the records of the old entries that the queue drops, and of a
 * batch that the store refuses.
 */
export function saveToEmergencyQueue(
  batch: LogBatch,
  diagnostics: Diagnostics,
  onLoss?: LossReporter,
): void {
  // Name the record count. A full localStorage drops this batch permanently. Removal of
  // emergency keys cannot free quota that the keys of other applications use.
  const prefix = emergencyPrefix(batch.persistenceNamespace);
  const context = `writing the emergency queue, ${String(batch.records.length)} records`;
  const evicted: LogBatch[] = [];

  const saved = diagnostics.guard("storage.quota_exceeded", context, () => {
    const keys = keysWithPrefix(prefix, diagnostics);

    // Remove the oldest entries to keep the queue within its capacity.
    for (const old of keys.slice(0, Math.max(0, keys.length - EMERGENCY_MAX_ENTRIES + 1))) {
      // A key that another window removed gives null. readBatch then rejects it.
      const dropped = readBatch(String(localStorage.getItem(old)), diagnostics);
      if (dropped !== null) {
        evicted.push(dropped);
      }
      localStorage.removeItem(old);
    }

    localStorage.setItem(batchKey(prefix, batch), JSON.stringify(batch));
    return true;
  });

  // The exit flush calls this function. A throw here skips the shutdown of the sender.
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
 * @param storage Destination storage adapter.
 * @param diagnostics Diagnostics reporter.
 * @returns Promise that resolves to the number of recovered batches.
 */
export async function drainEmergencyQueue(
  storage: StorageAdapter,
  diagnostics: Diagnostics,
  accepts: (batch: LogBatch) => boolean = () => true,
  namespace = "",
): Promise<number> {
  const moved = await withDrainLock(
    EMERGENCY_LOCK_NAME,
    diagnostics,
    () => importAll(storage, diagnostics, accepts, emergencyPrefix(namespace)),
    { skipIfBusy: false },
  );

  return moved ?? 0;
}

/**
 * Removes emergency entries of one context, or all entries in its namespace.
 * @param id Delivery context id.
 * @param diagnostics Diagnostics reporter.
 * @param namespace Application storage namespace.
 * @param all True to remove entries of all contexts in this namespace.
 */
export function clearEmergencyContext(
  id: string,
  diagnostics: Diagnostics,
  namespace = "",
  all = false,
): void {
  const prefix = emergencyPrefix(namespace);
  diagnostics.guard(
    "storage.unavailable",
    "The library could not clear the retired emergency queue.",
    () => {
      for (const key of keysWithPrefix(prefix, diagnostics)) {
        const raw = localStorage.getItem(key);
        if (raw && (all || readBatch(raw, diagnostics)?.routingContextId === id))
          localStorage.removeItem(key);
      }
    },
  );
}

/**
 * Gives the emergency storage prefix of one application namespace.
 * @param namespace Application namespace. An empty value uses the previous prefix.
 * @returns Prefix for this application emergency queue.
 */
function emergencyPrefix(namespace = ""): string {
  return namespace
    ? `ui-observability:namespaced:${encodeURIComponent(namespace)}:emergency:`
    : EMERGENCY_STORAGE_KEY_PREFIX;
}

// src/storage/emergency-queue.ts
//
// Synchronous localStorage queue parking oversized batches during unload for startup recovery.
// Synchronous and never throws. Runs while the document is being destroyed, where
// no promise settles.

import {
  BATCH_KEY_TIME_WIDTH,
  EMERGENCY_LOCK_NAME,
  EMERGENCY_MAX_ENTRIES,
  EMERGENCY_STORAGE_KEY_PREFIX,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { StorageAdapter } from "../models/storage";
import { withDrainLock } from "../utils/lock";
import { keysWithPrefix } from "./keys";

/**
 * Formats a storage key with zero-padded creation time for FIFO sorting.
 * @param batch Target log batch.
 * @returns Prefixed, timestamp-ordered storage key.
 */
function keyFor(batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${EMERGENCY_STORAGE_KEY_PREFIX}${at}.${batch.id}`;
}

/**
 * Parses and validates a raw storage string into a LogBatch object.
 * @param raw Raw serialized storage string.
 * @param diagnostics Diagnostics reporter.
 * @returns Validated LogBatch or null if unparseable or malformed.
 */
function readBatch(raw: string, diagnostics: Diagnostics): LogBatch | null {
  const parsed = diagnostics.guard(
    "storage.degraded",
    "an emergency entry was not JSON and was dropped",
    () => JSON.parse(raw) as unknown,
  );

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const createdAt: unknown = Reflect.get(parsed, "createdAt");
  const records: unknown = Reflect.get(parsed, "records");

  if (typeof createdAt !== "number" || !Array.isArray(records)) {
    diagnostics.report("storage.degraded", "an emergency entry was not a batch and was dropped");
    return null;
  }

  return parsed as LogBatch;
}

/**
 * Imports all emergency queue entries into the target storage adapter in FIFO order.
 * @param storage Destination storage adapter.
 * @param diagnostics Diagnostics reporter.
 * @returns Total number of recovered batches.
 */
async function importAll(storage: StorageAdapter, diagnostics: Diagnostics): Promise<number> {
  let moved = 0;

  for (const key of keysWithPrefix(EMERGENCY_STORAGE_KEY_PREFIX, diagnostics)) {
    // Atomically removes key before async persistence to prevent duplicate recovery.
    // A second window importing at the same time cannot take the same batch.
    const raw = diagnostics.guard("storage.unavailable", "reading the emergency queue", () => {
      const value = localStorage.getItem(key);
      localStorage.removeItem(key);
      return value;
    });

    if (!raw) {
      continue;
    }

    const batch = readBatch(raw, diagnostics);
    if (batch === null) {
      continue;
    }

    try {
      await storage.save(batch);
      moved++;
    } catch (error) {
      diagnostics.report(
        "storage.degraded",
        "an emergency batch could not be recovered",
        { key },
        error,
      );
    }
  }

  return moved;
}

/**
 * Synchronously writes an unsent batch to the emergency queue during document unload.
 * @param batch Oversized log batch.
 * @param diagnostics Diagnostics reporter.
 */
export function saveToEmergencyQueue(batch: LogBatch, diagnostics: Diagnostics): void {
  diagnostics.guard("storage.quota_exceeded", "writing the emergency queue", () => {
    const keys = keysWithPrefix(EMERGENCY_STORAGE_KEY_PREFIX, diagnostics);

    // Evicts oldest entries to enforce capacity ceiling.
    for (const old of keys.slice(0, Math.max(0, keys.length - EMERGENCY_MAX_ENTRIES + 1))) {
      localStorage.removeItem(old);
    }

    localStorage.setItem(keyFor(batch), JSON.stringify(batch));
  });
}

/**
 * Recovers batches parked in emergency storage during prior shutdowns.
 * @param storage Destination storage adapter.
 * @param diagnostics Diagnostics reporter.
 * @returns Promise resolving to the number of recovered batches.
 */
export async function drainEmergencyQueue(
  storage: StorageAdapter,
  diagnostics: Diagnostics,
): Promise<number> {
  const moved = await withDrainLock(
    EMERGENCY_LOCK_NAME,
    diagnostics,
    () => importAll(storage, diagnostics),
    { skipIfBusy: false },
  );

  return moved ?? 0;
}

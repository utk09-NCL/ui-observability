// src/storage/emergency-queue.ts
//
// This module keeps a synchronous localStorage queue. It holds oversized batches during unload.
// Startup recovers them. The code is synchronous and never throws. It runs while the browser
// destroys the document. No promise settles at that time.

import {
  BATCH_KEY_TIME_WIDTH,
  EMERGENCY_LOCK_NAME,
  EMERGENCY_MAX_ENTRIES,
  EMERGENCY_STORAGE_KEY_PREFIX,
  STORAGE_DEADLINE_MS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { isLogBatch, type LogBatch } from "../models/batch";
import type { StorageAdapter } from "../models/storage";
import { withDeadline } from "../utils/deadline";
import { withDrainLock } from "../utils/lock";
import { keysWithPrefix } from "./keys";

/**
 * Formats a storage key with a zero-padded creation time. The keys sort in FIFO
 * order.
 * @param batch Target log batch.
 * @returns Prefixed, timestamp-ordered storage key.
 */
function keyFor(batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${EMERGENCY_STORAGE_KEY_PREFIX}${at}.${batch.id}`;
}

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
async function importAll(storage: StorageAdapter, diagnostics: Diagnostics): Promise<number> {
  let moved = 0;

  for (const key of keysWithPrefix(EMERGENCY_STORAGE_KEY_PREFIX, diagnostics)) {
    // Read and remove the key in one synchronous step, before the async save. A second window
    // that imports at the same time cannot take the same batch.
    const raw = diagnostics.guard(
      "storage.unavailable",
      "The library could not read the emergency queue.",
      () => {
        const value = localStorage.getItem(key);
        localStorage.removeItem(key);
        return value;
      },
    );

    if (!raw) {
      continue;
    }

    const batch = readBatch(raw, diagnostics);
    if (batch === null) {
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
 */
export function saveToEmergencyQueue(batch: LogBatch, diagnostics: Diagnostics): void {
  // Name the record count. A full localStorage drops this batch permanently. Removal of
  // emergency keys cannot free quota that the keys of other applications use.
  const context = `writing the emergency queue, ${String(batch.records.length)} records`;

  diagnostics.guard("storage.quota_exceeded", context, () => {
    const keys = keysWithPrefix(EMERGENCY_STORAGE_KEY_PREFIX, diagnostics);

    // Remove the oldest entries to keep the queue within its capacity.
    for (const old of keys.slice(0, Math.max(0, keys.length - EMERGENCY_MAX_ENTRIES + 1))) {
      localStorage.removeItem(old);
    }

    localStorage.setItem(keyFor(batch), JSON.stringify(batch));
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
): Promise<number> {
  const moved = await withDrainLock(
    EMERGENCY_LOCK_NAME,
    diagnostics,
    () => importAll(storage, diagnostics),
    { skipIfBusy: false },
  );

  return moved ?? 0;
}

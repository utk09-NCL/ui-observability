// src/storage/emergency-queue.ts
//
// Where a batch goes when the document is closing and it is too large to
// beacon. localStorage because it is the only synchronous store: nothing
// asynchronous completes during an unload, IndexedDB writes least of all.
//
// Written by the exit flush, read once at the next startup.

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
 * The key carries the creation time, for the reason `local-storage.ts` spells
 * out: sorting keys is the only ordering a Storage has, and a batch id is
 * random, so keying on it alone evicts an arbitrary entry rather than the
 * oldest.
 */
function keyFor(batch: LogBatch): string {
  const at = String(batch.createdAt).padStart(BATCH_KEY_TIME_WIDTH, "0");
  return `${EMERGENCY_STORAGE_KEY_PREFIX}${at}.${batch.id}`;
}

/**
 * One stored batch, or null when the entry is not one. Anything on the origin
 * can write this key, and an older version of this library may have.
 *
 * @param raw What the key held.
 * @param diagnostics Where an entry that is not a batch is reported.
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

/** Move every entry into `storage`, oldest first. */
async function importAll(storage: StorageAdapter, diagnostics: Diagnostics): Promise<number> {
  let moved = 0;

  for (const key of keysWithPrefix(EMERGENCY_STORAGE_KEY_PREFIX, diagnostics)) {
    // Claimed synchronously, before the save it is waiting on. An entry that
    // cannot be saved is lost, which beats every window reimporting it forever.
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
 * Park one batch. Synchronous by design, and it never throws: this runs as the
 * document is closing, and nothing is left to catch anything.
 *
 * @param batch The batch that could not be sent.
 * @param diagnostics Where a store that refuses the write is reported.
 */
export function saveToEmergencyQueue(batch: LogBatch, diagnostics: Diagnostics): void {
  diagnostics.guard("storage.quota_exceeded", "writing the emergency queue", () => {
    const keys = keysWithPrefix(EMERGENCY_STORAGE_KEY_PREFIX, diagnostics);

    // Make room for this one, oldest first.
    for (const old of keys.slice(0, Math.max(0, keys.length - EMERGENCY_MAX_ENTRIES + 1))) {
      localStorage.removeItem(old);
    }

    localStorage.setItem(keyFor(batch), JSON.stringify(batch));
  });
}

/**
 * Move what survived the last close into real storage. Called once at startup,
 * before anything else writes.
 *
 * @param storage Where the recovered batches go.
 * @param diagnostics Where an unreadable entry is reported.
 * @returns How many batches were recovered.
 */
export async function drainEmergencyQueue(
  storage: StorageAdapter,
  diagnostics: Diagnostics,
): Promise<number> {
  const moved = await withDrainLock(
    EMERGENCY_LOCK_NAME,
    diagnostics,
    () => importAll(storage, diagnostics),
    // One shot at startup, so wait for the other window rather than skip.
    { skipIfBusy: false },
  );

  return moved ?? 0;
}

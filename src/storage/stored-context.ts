// src/storage/stored-context.ts
//
// Reaches the configured store when no delivery stack runs. clearPersistedLogs() and a rotation
// with no old sender need it, because otherwise only a sender opens the store.

import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { LogRecord } from "../models/log-record";
import { type StorageAdapter, storageLimits } from "../models/storage";
import { newId } from "../utils/identity";
import { ContextStorage } from "./context-storage";
import { clearEmergencyContext } from "./emergency-queue";
import { createStorage, storageName } from "./factory";

/** What opening the store needs. The active context is the one in `config.securityContext`. */
export interface StoreAccess {
  /** Active configuration instance. */
  config: ResolvedConfig;
  /** Diagnostics reporter. */
  diagnostics: Diagnostics;
  /** The memory store the runtime keeps across context changes, if it has one. */
  memory: StorageAdapter | undefined;
}

/**
 * Opens the store for the active context, runs the work, then closes the store again. The
 * memory store stays open, because it holds other contexts' records too.
 * @param access The config, the reporter and the kept memory store.
 * @param work What to do with the store.
 * @returns Promise that resolves once the work is done and the store is closed.
 */
async function withStore(
  access: StoreAccess,
  work: (store: ContextStorage) => Promise<void>,
): Promise<void> {
  const { config, diagnostics, memory } = access;
  const { backend, namespace } = config.storage;
  const backing =
    memory ??
    (await createStorage(
      backend,
      storageName(namespace),
      storageLimits(config.retention),
      diagnostics,
      undefined,
      namespace,
    ));
  const store = new ContextStorage(backing, config.securityContext, namespace);
  try {
    await work(store);
  } finally {
    if (backing !== memory) {
      await store.close();
    }
  }
}

/**
 * Removes the active context's stored batches and its emergency entries, or the whole
 * namespace's. A discard rotation with no sender uses it, as Sender.retire() would.
 * @param access The config, the reporter and the kept memory store.
 * @param scope Whose stored records to remove: the context's or the namespace's.
 * @param ids More batches to remove by id, for example the ones a carry left under an older id.
 * @returns Promise that resolves once the batches are removed.
 */
export function clearStored(
  access: StoreAccess,
  scope: "context" | "namespace",
  ids: readonly string[] = [],
): Promise<void> {
  return withStore(access, async (store) => {
    for (const id of ids) {
      await store.remove(id);
    }

    if (scope === "namespace") {
      await store.clearNamespace();
    } else {
      await store.clear();
    }

    const { diagnostics, config } = access;
    clearEmergencyContext(
      config.securityContext.id,
      diagnostics,
      store.namespace,
      scope === "namespace",
    );
  });
}

/**
 * Stores records and batches under the active context, as a retain rotation does with a sender.
 * The records go in one batch. A batch keeps its id, so its older copy is replaced.
 * @param access The config, the reporter and the kept memory store.
 * @param records Records that waited in memory.
 * @param batches Stored batches of an earlier context, for example the ones a carry left.
 * @returns Promise that resolves once each batch is stored.
 */
export function keepStored(
  access: StoreAccess,
  records: readonly LogRecord[],
  batches: readonly LogBatch[],
): Promise<void> {
  return withStore(access, async (store) => {
    const all = [...batches];
    if (records.length > 0) {
      const id = newId(access.diagnostics);
      all.push({ id, records: [...records], createdAt: Date.now(), attempts: 0 });
    }

    for (const batch of all) {
      await store.save({
        ...batch,
        attempts: 0,
        routingContextId: access.config.securityContext.id,
        persistenceNamespace: store.namespace,
      });
    }
  });
}

// src/storage/context-storage.ts
//
// Scopes the shared batch store to one delivery context and one application namespace.

import type { SecurityContextOptions } from "../models/config";
import type { LogBatch } from "../models/batch";
import type { StorageAdapter } from "../models/storage";

/** A view of one slice of the shared store. Other contexts' records are left alone. */
export class ContextStorage implements StorageAdapter {
  /** Name of the underlying adapter. */
  readonly name: string;
  /** False once this context store stops accepting writes. */
  private active = true;
  /** True if a late save has to remove its batch once it finishes. */
  private discard = false;

  /**
   * Scopes a store to one application namespace and delivery context.
   * @param store The underlying batch store.
   * @param policy The active context id and the isolation rule.
   * @param namespace The application's storage namespace.
   */
  constructor(
    private readonly store: StorageAdapter,
    private readonly policy: SecurityContextOptions,
    readonly namespace = "",
  ) {
    this.name = store.name;
  }

  /**
   * Checks whether a batch belongs to this namespace and context.
   * @param batch The batch to check.
   * @returns True if this adapter can accept the batch.
   */
  accepts(batch: LogBatch): boolean {
    return (
      (batch.persistenceNamespace ?? "") === this.namespace &&
      (!this.policy.isolation || !this.policy.id || batch.routingContextId === this.policy.id)
    );
  }

  /**
   * Stores a batch for this context. After a discard, a late save removes its own batch again.
   * @param batch The batch to store.
   * @returns True if the batch is in the store once the save, and any removal, is done.
   */
  async save(batch: LogBatch): Promise<boolean> {
    if (!this.active || !this.accepts(batch)) {
      return false;
    }

    const written = await this.store.save(batch);
    // A slow save can finish after the context change already cleared these records.
    if (this.discard) {
      await this.store.remove(batch.id);
      return false;
    }

    return written;
  }

  /**
   * Reads this context's stored batches, oldest first.
   * @param limit Maximum number of batches to return.
   * @returns The batches in creation order. They are not removed.
   */
  async take(limit: number): Promise<LogBatch[]> {
    // Read only this context's slice. A full read on every retry pass would parse all contexts.
    if (!this.isolated()) {
      return (await this.store.take(limit)).filter((batch) => this.accepts(batch));
    }

    if (this.store.takeContext) {
      return this.store.takeContext(this.policy.id, limit);
    }

    const all = await this.store.take(0xffffffff);
    return all.filter((batch) => this.accepts(batch)).slice(0, limit);
  }

  /**
   * Checks whether reads are limited to the active context.
   * @returns True if isolation is on and the context has an id.
   */
  private isolated(): boolean {
    return this.policy.isolation && this.policy.id !== "";
  }

  /**
   * Removes one stored batch.
   * @param id Batch id.
   * @returns A promise that resolves once the batch is removed.
   */
  remove(id: string): Promise<void> {
    return this.store.remove(id);
  }

  /**
   * Updates a stored batch's attempt count.
   * @param id Batch id.
   * @param attempts The total attempt count to store.
   * @returns A promise that resolves once the change is saved.
   */
  bumpAttempts(id: string, attempts: number): Promise<void> {
    return this.store.bumpAttempts(id, attempts);
  }

  /**
   * Applies the underlying store's retention and capacity limits.
   * @returns A summary of the batches and records it removed.
   */
  prune(): ReturnType<StorageAdapter["prune"]> {
    return this.store.prune();
  }

  /**
   * Counts this context's stored batches.
   * @returns The number of batches in this context.
   */
  async count(): Promise<number> {
    if (!this.isolated()) {
      return this.store.count();
    }

    if (this.store.countContext) {
      return this.store.countContext(this.policy.id);
    }

    return (await this.take(Number.MAX_SAFE_INTEGER)).length;
  }

  /**
   * Removes this context's stored batches.
   * @returns A promise that resolves once they are removed.
   */
  async clear(): Promise<void> {
    for (const batch of await this.take(Number.MAX_SAFE_INTEGER)) await this.store.remove(batch.id);
  }

  /**
   * Stops new writes and, if asked, clears this context. The memory store is left open for
   * other contexts.
   * @param discard True to remove this context's batches before closing the store.
   * @returns A promise that resolves once the removal and the close are done.
   */
  async retire(discard: boolean): Promise<void> {
    this.active = false;
    this.discard = discard;
    if (discard) await this.clear();
    // Keep the memory store around for later context changes. It may hold other contexts' records.
    if (this.name !== "memory") await this.close();
  }

  /**
   * Removes every batch in the application namespace.
   * @returns A promise that resolves once they are removed.
   */
  clearNamespace(): Promise<void> {
    return this.store.clear();
  }

  /**
   * Closes the underlying store.
   * @returns A promise that resolves once it is closed.
   */
  close(): Promise<void> {
    return this.store.close();
  }
}

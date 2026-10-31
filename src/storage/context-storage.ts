// src/storage/context-storage.ts
//
// Gives access to stored batches of one delivery context and one application namespace.

import type { SecurityContextOptions } from "../models/config";
import type { LogBatch } from "../models/batch";
import type { StorageAdapter } from "../models/storage";

/** Gives access to one part of the shared store. Records of other contexts stay stored. */
export class ContextStorage implements StorageAdapter {
  /** Adapter name of the underlying store. */
  readonly name: string;
  /** False after this context store stops accepting writes. */
  private active = true;
  /** True if a late save must remove its batch after it completes. */
  private discard = false;

  /**
   * Builds access to one application namespace and delivery context.
   * @param store Underlying batch store.
   * @param policy Active context id and isolation rule.
   * @param namespace Application storage namespace.
   */
  constructor(
    private readonly store: StorageAdapter,
    private readonly policy: SecurityContextOptions,
    readonly namespace = "",
  ) {
    this.name = store.name;
  }

  /**
   * Checks if a batch belongs to the permitted namespace and context.
   * @param batch Batch to check.
   * @returns True if this adapter can accept the batch.
   */
  accepts(batch: LogBatch): boolean {
    return (
      (batch.persistenceNamespace ?? "") === this.namespace &&
      (!this.policy.isolation || !this.policy.id || batch.routingContextId === this.policy.id)
    );
  }

  /**
   * Stores a batch of this context. A late save removes its batch after a discard.
   * @param batch Batch to store.
   * @returns Promise that resolves when the save and any removal complete.
   */
  async save(batch: LogBatch): Promise<void> {
    if (!this.active || !this.accepts(batch)) return;
    await this.store.save(batch);
    // A slow save can complete after the context change cleared these records.
    if (this.discard) await this.store.remove(batch.id);
  }

  /**
   * Reads stored batches of this context, oldest first.
   * @param limit Maximum batches to return.
   * @returns Batches in creation order. The method does not remove them.
   */
  async take(limit: number): Promise<LogBatch[]> {
    // Read only this part of the store. A full read on each retry pass parses all contexts.
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
   * Checks if reads are limited to the active context.
   * @returns True if isolation is on and the context has an id.
   */
  private isolated(): boolean {
    return this.policy.isolation && this.policy.id !== "";
  }

  /**
   * Removes one stored batch.
   * @param id Batch id.
   * @returns Promise that resolves when removal completes.
   */
  remove(id: string): Promise<void> {
    return this.store.remove(id);
  }

  /**
   * Changes the attempt count of a stored batch.
   * @param id Batch id.
   * @param attempts Total attempt count to store.
   * @returns Promise that resolves when the change completes.
   */
  bumpAttempts(id: string, attempts: number): Promise<void> {
    return this.store.bumpAttempts(id, attempts);
  }

  /**
   * Applies the retention and capacity limits of the underlying store.
   * @returns Summary of the batches and records removed.
   */
  prune(): ReturnType<StorageAdapter["prune"]> {
    return this.store.prune();
  }

  /**
   * Counts stored batches of this context.
   * @returns Number of batches in this context.
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
   * Removes stored batches of this context.
   * @returns Promise that resolves when removal completes.
   */
  async clear(): Promise<void> {
    for (const batch of await this.take(Number.MAX_SAFE_INTEGER)) await this.store.remove(batch.id);
  }

  /**
   * Stops new writes and clears this context if required. Other contexts can keep the memory store.
   * @param discard True to remove this context before closing the store.
   * @returns Promise that resolves when removal and closure complete.
   */
  async retire(discard: boolean): Promise<void> {
    this.active = false;
    this.discard = discard;
    if (discard) await this.clear();
    // Keep the memory store for later context changes. It can hold records of other contexts.
    if (this.name !== "memory") await this.close();
  }

  /**
   * Removes all batches in the application namespace.
   * @returns Promise that resolves when removal completes.
   */
  clearNamespace(): Promise<void> {
    return this.store.clear();
  }

  /**
   * Closes the underlying store.
   * @returns Promise that resolves when closure completes.
   */
  close(): Promise<void> {
    return this.store.close();
  }
}

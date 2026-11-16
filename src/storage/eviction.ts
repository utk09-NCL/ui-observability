// src/storage/eviction.ts
//
// Picks which stored batches to evict. An action is an audit fact, so batches without one go
// first. The walk stops early, because reading the whole store on every save blocks the page.

import { isActionRecord, type LogBatch } from "../models/batch";

/**
 * Checks whether a batch holds an action. Eviction removes such a batch last.
 * @param batch The batch to check.
 * @returns True if any record in the batch is an action.
 */
export function hasAction(batch: LogBatch): boolean {
  // Another script on the origin can write to the database. A throw in a cursor handler would
  // stop the eviction walk, and the walk would never settle.
  return Array.isArray(batch.records) && batch.records.some(isActionRecord);
}

/** Collects the items to evict from an oldest-first walk. */
export class EvictionPick<T> {
  /** Items without an audit fact. */
  private readonly plain: T[] = [];

  /** The oldest items with an audit fact. Only used when there aren't enough plain items. */
  private readonly audit: T[] = [];

  /**
   * @param howMany Number of items to evict.
   * @param isAudit Checks whether an item holds an audit fact.
   */
  constructor(
    private readonly howMany: number,
    private readonly isAudit: (item: T) => boolean,
  ) {}

  /**
   * Adds the next item of the walk.
   * @param item The next oldest item.
   * @returns False once the pick has enough items without an audit fact, which stops the walk.
   */
  add(item: T): boolean {
    if (!this.isAudit(item)) {
      this.plain.push(item);
    } else if (this.audit.length < this.howMany) {
      this.audit.push(item);
    }

    return this.plain.length < this.howMany;
  }

  /**
   * Returns the items to evict, with the ones without an audit fact first.
   * @returns The picked items.
   */
  picked(): T[] {
    return [...this.plain, ...this.audit].slice(0, this.howMany);
  }
}

/**
 * Picks the items to evict from an oldest-first walk, and stops the walk early.
 * @param items Items, oldest first. A generator reads each item only when the walk needs it.
 * @param howMany Number of items to evict.
 * @param isAudit Checks whether an item holds an audit fact.
 * @returns The picked items, with the ones without an audit fact first.
 */
export function pickEvictable<T>(
  items: Iterable<T>,
  howMany: number,
  isAudit: (item: T) => boolean,
): T[] {
  const pick = new EvictionPick(howMany, isAudit);

  for (const item of items) {
    if (!pick.add(item)) {
      break;
    }
  }

  return pick.picked();
}

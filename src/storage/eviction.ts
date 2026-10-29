// src/storage/eviction.ts
//
// This module selects the stored batches to evict. An action is an audit fact. The batches without
// an action go first. The walk stops early. A read of the full store at each save blocks the page.

import { isActionRecord, type LogBatch } from "../models/batch";

/**
 * Tests if a batch holds an action. An eviction removes such a batch last.
 * @param batch Batch to test.
 * @returns True if one record of the batch is an action.
 */
export function hasAction(batch: LogBatch): boolean {
  // Another script on the origin can write to the database. A throw in a cursor handler stops
  // the eviction walk. The walk then never settles.
  return Array.isArray(batch.records) && batch.records.some(isActionRecord);
}

/** Collects the items to evict from a walk in age order, oldest first. */
export class EvictionPick<T> {
  /** Items without an audit fact. */
  private readonly plain: T[] = [];

  /** Oldest items with an audit fact. The pick uses them only when too few plain items exist. */
  private readonly audit: T[] = [];

  /**
   * @param howMany Number of items to evict.
   * @param isAudit Tests if an item holds an audit fact.
   */
  constructor(
    private readonly howMany: number,
    private readonly isAudit: (item: T) => boolean,
  ) {}

  /**
   * Adds the next item of the walk.
   * @param item Next oldest item.
   * @returns False when the pick has enough items without an audit fact. The walk then stops.
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
   * Gives the items to evict. The items without an audit fact come first.
   * @returns The picked items.
   */
  picked(): T[] {
    return [...this.plain, ...this.audit].slice(0, this.howMany);
  }
}

/**
 * Picks the items to evict from a walk in age order. It stops the walk early.
 * @param items Items, oldest first. A generator reads each item only when the walk needs it.
 * @param howMany Number of items to evict.
 * @param isAudit Tests if an item holds an audit fact.
 * @returns The picked items. The items without an audit fact come first.
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

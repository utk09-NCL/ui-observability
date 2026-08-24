// src/core/breadcrumbs.ts
//
// The last few things that happened before an error, kept in memory. Never sent
// on their own; they ride on the record that needed them.
//
// A crumb is a summary, not a record: a timestamp, a category, a string and a
// small optional object. Attaching whole records instead made one error report
// 50 to 100 KB and pushed batches into the server's 413 path.
//
// Storage is a fixed-size ring with a write pointer, so memory is bounded by
// the configured capacity rather than by how long the document has been open.
// Nothing here throws: no platform API is touched and the one consumer-supplied
// value is clamped, so this file has no diagnostics dependency.

import { BREADCRUMB_MIN_CAPACITY } from "../constants";

/**
 * What kind of thing a breadcrumb records.
 *
 * A closed set, because these are what a reader filters an error's trail by and
 * two capture engines spelling one idea differently would make that filter lie.
 */
export type BreadcrumbCategory =
  "log" | "action" | "event" | "click" | "navigation" | "http" | "console";

/** One thing that happened, small enough that fifty fit on an error report. */
export interface Breadcrumb {
  /** When it happened, in epoch milliseconds. Short name: the key repeats once per crumb on the wire. */
  t: number;
  /** Which capture path produced this crumb. Filters a trail down to one kind of activity. */
  category: BreadcrumbCategory;
  /** A human-readable summary, kept short by its producer. */
  message: string;
  /**
   * A few extra scalars, when the message alone loses something that matters,
   * such as a status code or a target selector. Sanitized where the record is
   * built, against the limits in force then.
   */
  data?: Record<string, unknown>;
}

/**
 * A bounded, chronological trail of recent activity.
 *
 * Per runtime instance, so two runtimes in one document do not braid their
 * trails together and a test does not inherit the previous file's crumbs.
 */
export class BreadcrumbBuffer {
  /**
   * The ring. Slots stay typed as possibly empty even after it wraps, so the
   * reader has to prove it is handing out crumbs rather than holes.
   */
  private buffer: (Breadcrumb | undefined)[];

  /** Where the next crumb is written. Also the oldest crumb once the ring has wrapped. */
  private pointer = 0;

  /**
   * Whether the ring has wrapped. The pointer alone cannot separate a ring
   * never written to from one wrapped exactly back to the start.
   */
  private filled = false;

  /** How many crumbs are kept, never below {@link BREADCRUMB_MIN_CAPACITY}. Mutable: a reconfigure can change it. */
  private capacity: number;

  /**
   * @param capacity How many crumbs to keep, from `capture.maxBreadcrumbs`.
   *
   * Clamped rather than rejected. A capacity of zero makes the pointer
   * arithmetic `% 0`, which is NaN, so every crumb is written to index NaN and
   * none is read back. And this runs inside `configure()`, where throwing would
   * take the host application down as it sets logging up. Turning breadcrumbs
   * off is what the capture flags are for.
   *
   * No default value here: the capacity always arrives from the resolved
   * config, and a second copy would be free to drift from it.
   */
  constructor(capacity: number) {
    this.capacity = Math.max(capacity, BREADCRUMB_MIN_CAPACITY);
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
  }

  /**
   * Change how many crumbs are kept, preserving the newest, which are the ones
   * nearest an error. Same clamp as the constructor, so the two cannot disagree.
   *
   * @param capacity The new capacity, from `capture.maxBreadcrumbs`.
   */
  resize(capacity: number): void {
    const clamped = Math.max(capacity, BREADCRUMB_MIN_CAPACITY);
    if (clamped === this.capacity) {
      return;
    }
    // The clamp guarantees a positive count, so this never degrades into
    // `slice(-0)`, which would keep the whole trail instead of the tail of it.
    const kept = this.snapshot().slice(-clamped);
    this.capacity = clamped;
    this.clear();
    for (const crumb of kept) {
      this.push(crumb);
    }
  }

  /**
   * Record one crumb, overwriting the oldest once the ring is full.
   *
   * @param crumb Kept by reference and never copied, so a caller must not
   * mutate a crumb after handing it over.
   */
  push(crumb: Breadcrumb): void {
    this.buffer[this.pointer] = crumb;
    this.pointer = (this.pointer + 1) % this.capacity;
    if (this.pointer === 0) {
      this.filled = true;
    }
  }

  /**
   * The trail as it stands, oldest first.
   *
   * @returns A fresh array each call. Once the ring has wrapped the oldest
   * crumb sits at the write pointer, so the tail of the storage is read before
   * its head. The crumbs in it are the stored objects, not copies.
   */
  snapshot(): Breadcrumb[] {
    const ordered = this.filled
      ? [...this.buffer.slice(this.pointer), ...this.buffer.slice(0, this.pointer)]
      : this.buffer.slice(0, this.pointer);
    return ordered.filter((crumb): crumb is Breadcrumb => crumb !== undefined);
  }

  /**
   * Forget every crumb. Allocates a fresh ring, so the discarded crumbs and
   * anything they reference become collectable immediately.
   */
  clear(): void {
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
    this.pointer = 0;
    this.filled = false;
  }
}

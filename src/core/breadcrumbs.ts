// src/core/breadcrumbs.ts
//
// The last few things that happened before an error, kept in memory so that an
// error report can say what led up to it. Breadcrumbs are local only. They are
// never sent on their own, they ride along on the record that needed them.
//
// Three decisions shape the whole file.
//
//   1. A breadcrumb is a summary, not a record. An earlier design attached
//      fifty complete log records to every error, each one carrying its own
//      full resource block, which made a single error report 50 to 100 KB and
//      pushed batches straight into the server's 413 path. What is stored here
//      is a timestamp, a category, a string, and a small optional object.
//   2. The store is a fixed-size ring with a write pointer, so the memory a
//      long-lived document spends on breadcrumbs is bounded by the configured
//      capacity rather than by how long the document has been open. Writing
//      past the end overwrites the oldest crumb. Nothing grows, nothing is
//      shifted, and every push costs the same.
//   3. Nothing here throws. The buffer touches no platform API, and the one
//      value a consumer controls is clamped rather than rejected, so this is
//      one of the few files with no diagnostics dependency.

import { BREADCRUMB_MIN_CAPACITY } from "../constants";

/**
 * What kind of thing a breadcrumb records.
 *
 * A closed set rather than a free string, because the categories are what a
 * reader filters an error's trail by, and two capture engines spelling the
 * same idea differently would make that filter lie. The capture engines and
 * the public logger each own one of these values.
 */
export type BreadcrumbCategory =
  "log" | "action" | "event" | "click" | "navigation" | "http" | "console";

/**
 * One thing that happened, small enough that fifty of them can be attached to
 * an error without changing the size class of the report.
 */
export interface Breadcrumb {
  /**
   * When it happened, in epoch milliseconds.
   *
   * Short name because a full trail of these is serialized onto a record, and
   * the key is repeated once per crumb.
   */
  t: number;
  /** Which capture path produced this crumb, used to filter a trail down to one kind of activity. */
  category: BreadcrumbCategory;
  /** A human-readable summary. Kept short by its producer, since the whole point is that a trail stays small. */
  message: string;
  /**
   * A few extra fields, when a message alone loses something that matters,
   * such as a status code or a target selector.
   *
   * Optional, and expected to hold a handful of scalars. It is sanitized and
   * size-capped where the record is built, not here, because the limits that
   * govern it come from a config a consumer can replace at any time.
   */
  data?: Record<string, unknown>;
}

/**
 * A bounded, chronological trail of recent activity.
 *
 * Held per runtime instance rather than per module, so two runtimes in one
 * document do not braid their trails together and a test does not inherit the
 * crumbs of whichever test file ran before it.
 */
export class BreadcrumbBuffer {
  /**
   * The ring itself.
   *
   * Slots start empty and stay typed as possibly empty even once the ring has
   * wrapped, because the reader has to prove to the type system that it is
   * handing out real crumbs rather than holes.
   */
  private buffer: (Breadcrumb | undefined)[];

  /** Where the next crumb is written. Also the position of the oldest crumb once the ring has wrapped. */
  private pointer = 0;

  /**
   * Whether the ring has wrapped at least once.
   *
   * Needed because the pointer alone cannot tell a ring that has never been
   * written to from one that has wrapped exactly back to the start. Both read
   * as pointer zero, and they have opposite meanings.
   */
  private filled = false;

  /**
   * How many crumbs are kept. Mutable, since a reconfigure can change it.
   *
   * Never below {@link BREADCRUMB_MIN_CAPACITY}. See the constructor for why
   * that floor is enforced rather than validated.
   */
  private capacity: number;

  /**
   * @param capacity How many crumbs to keep, from `capture.maxBreadcrumbs`.
   *
   * It is clamped up to {@link BREADCRUMB_MIN_CAPACITY} rather than rejected,
   * for two reasons. A capacity of zero would not store nothing, it would make
   * the pointer arithmetic `% 0`, which is NaN, so every crumb would be written
   * to index NaN and none would ever be read back. And this constructor runs
   * inside `configure()`, so throwing here would take the host application down
   * while it was setting logging up. Turning breadcrumbs off is what the
   * capture flags are for, not a capacity of zero.
   *
   * There is deliberately no default value. The capacity always arrives from
   * the resolved config, whose own default lives beside every other default, and
   * a second copy here would be a number free to drift away from that one.
   */
  constructor(capacity: number) {
    this.capacity = Math.max(capacity, BREADCRUMB_MIN_CAPACITY);
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
  }

  /**
   * Change how many crumbs are kept, preserving the newest ones.
   *
   * A consumer can reconfigure at any time, so the capacity has to be able to
   * change after crumbs already exist. Shrinking keeps the newest, because the
   * crumbs nearest an error are the ones that explain it.
   *
   * The clamp is the same one the constructor applies, so the two entry points
   * cannot disagree about what a too-small capacity means.
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
   * @param crumb The crumb to store. It is kept by reference and never copied
   * or inspected, so a caller must not mutate a crumb after handing it over.
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
   * @returns A fresh array on each call, in the order things happened. Once the
   * ring has wrapped the oldest crumb sits at the write pointer, so the tail of
   * the storage is read before its head to undo that rotation. The array is a
   * copy, but the crumbs in it are the stored objects, so a caller that intends
   * to alter one must clone it first.
   */
  snapshot(): Breadcrumb[] {
    const ordered = this.filled
      ? [...this.buffer.slice(this.pointer), ...this.buffer.slice(0, this.pointer)]
      : this.buffer.slice(0, this.pointer);
    return ordered.filter((crumb): crumb is Breadcrumb => crumb !== undefined);
  }

  /**
   * Forget every crumb.
   *
   * Allocates a fresh ring rather than emptying the old one, so that the
   * discarded crumbs, and anything they hold a reference to, become collectable
   * immediately instead of lingering in slots nobody will read.
   */
  clear(): void {
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
    this.pointer = 0;
    this.filled = false;
  }
}

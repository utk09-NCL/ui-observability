// src/core/breadcrumbs.ts
//
// Ring buffer holding a bounded chronological trail of recent user and system
// events. Crumbs are never sent as records. They reach the backend on an error
// record's payload. Nothing here throws.

import { BREADCRUMB_MIN_CAPACITY } from "../constants";

/** Category classification for breadcrumb events. */
export type BreadcrumbCategory =
  "log" | "action" | "event" | "click" | "navigation" | "http" | "console";

/** Lightweight event summary recorded prior to errors. */
export interface Breadcrumb {
  /** Timestamp in epoch milliseconds. */
  t: number;
  /** Event category classification. */
  category: BreadcrumbCategory;
  /** Human-readable event description. */
  message: string;
  /** Optional contextual metadata. */
  data?: Record<string, unknown>;
}

/** Bounded circular ring buffer storing recent breadcrumb events in chronological order. */
export class BreadcrumbBuffer {
  /** Internal storage array for the ring buffer. */
  private buffer: (Breadcrumb | undefined)[];

  /** Next write index in the circular buffer. */
  private pointer = 0;

  /**
   * Indicates whether the buffer has wrapped around its capacity. The pointer alone
   * cannot separate an unwritten ring from one wrapped exactly to the start.
   */
  private filled = false;

  /** Maximum number of breadcrumbs retained in memory. */
  private capacity: number;

  /**
   * @param capacity Maximum breadcrumb capacity, clamped to minimum allowed size.
   */
  constructor(capacity: number) {
    this.capacity = Math.max(capacity, BREADCRUMB_MIN_CAPACITY);
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
  }

  /**
   * Resizes buffer capacity while preserving the newest breadcrumbs.
   * @param capacity New maximum capacity.
   */
  resize(capacity: number): void {
    const clamped = Math.max(capacity, BREADCRUMB_MIN_CAPACITY);
    if (clamped === this.capacity) {
      return;
    }

    // The clamp guarantees a positive count. slice(-0) keeps the whole trail.
    const kept = this.snapshot().slice(-clamped);
    this.capacity = clamped;
    this.clear();
    for (const crumb of kept) {
      this.push(crumb);
    }
  }

  /**
   * Appends a breadcrumb, overwriting the oldest entry when capacity is reached.
   * @param crumb Breadcrumb event to append.
   */
  push(crumb: Breadcrumb): void {
    this.buffer[this.pointer] = crumb;
    this.pointer = (this.pointer + 1) % this.capacity;
    if (this.pointer === 0) {
      this.filled = true;
    }
  }

  /**
   * Returns all stored breadcrumbs ordered from oldest to newest.
   * @returns Chronological list of breadcrumbs.
   */
  snapshot(): Breadcrumb[] {
    const ordered = this.filled
      ? [...this.buffer.slice(this.pointer), ...this.buffer.slice(0, this.pointer)]
      : this.buffer.slice(0, this.pointer);
    return ordered.filter((crumb): crumb is Breadcrumb => crumb !== undefined);
  }

  /** Clears all stored breadcrumbs and resets buffer state. */
  clear(): void {
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
    this.pointer = 0;
    this.filled = false;
  }
}

// src/core/breadcrumbs.ts
//
// This ring buffer keeps a bounded trail of recent user and system events in time order.
// The buffer does not send breadcrumbs as records. Breadcrumbs go to the backend in the
// payload of an error record. No function in this file throws.

import { BREADCRUMB_MIN_CAPACITY } from "../constants";

/** Category of a breadcrumb event. */
export type BreadcrumbCategory =
  "log" | "action" | "event" | "click" | "navigation" | "http" | "console" | "frame" | "custom";

/** Short summary of one event that the buffer keeps for an error record. */
export interface Breadcrumb {
  /** Timestamp in epoch milliseconds. */
  t: number;
  /** Category of the event. */
  category: BreadcrumbCategory;
  /** Description of the event for a person to read. */
  message: string;
  /** Optional contextual metadata. */
  data?: Record<string, unknown>;
}

/** Ring buffer of fixed size. It keeps recent breadcrumbs in time order. */
export class BreadcrumbBuffer {
  /** Storage array of the ring buffer. */
  private buffer: (Breadcrumb | undefined)[];

  /** Next write index in the circular buffer. */
  private pointer = 0;

  /**
   * It is true after the pointer wraps past the capacity. The pointer alone cannot
   * tell an empty ring from a ring that wrapped back to index 0.
   */
  private filled = false;

  /** Maximum number of breadcrumbs that the buffer keeps. */
  private capacity: number;

  /**
   * @param capacity Maximum number of breadcrumbs. A smaller value changes to the minimum size.
   */
  constructor(capacity: number) {
    this.capacity = capacity === 0 ? 0 : Math.max(capacity, BREADCRUMB_MIN_CAPACITY);
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
  }

  /**
   * Changes the capacity and keeps the most recent breadcrumbs that fit.
   * @param capacity New capacity. Set 0 to remove and disable stored breadcrumbs.
   */
  resize(capacity: number): void {
    const recent = this.snapshot().slice(-capacity);
    this.capacity = capacity;
    this.buffer = new Array<Breadcrumb | undefined>(capacity);
    this.pointer = 0;
    this.filled = false;
    if (capacity) for (const crumb of recent) this.push(crumb);
  }

  /**
   * Adds a breadcrumb. When the buffer is full, the new breadcrumb replaces the oldest one.
   * @param crumb Breadcrumb to add.
   */
  push(crumb: Breadcrumb): void {
    if (this.capacity === 0) return;
    this.buffer[this.pointer] = crumb;
    this.pointer = (this.pointer + 1) % this.capacity;
    if (this.pointer === 0) {
      this.filled = true;
    }
  }

  /** Removes all breadcrumbs. A new session must not carry the trail of the previous user. */
  clear(): void {
    this.buffer.fill(undefined);
    this.pointer = 0;
    this.filled = false;
  }

  /**
   * Returns all stored breadcrumbs ordered from oldest to newest.
   * @returns List of breadcrumbs in time order.
   */
  snapshot(): Breadcrumb[] {
    const ordered = this.filled
      ? [...this.buffer.slice(this.pointer), ...this.buffer.slice(0, this.pointer)]
      : this.buffer.slice(0, this.pointer);
    return ordered.filter((crumb): crumb is Breadcrumb => crumb !== undefined);
  }
}

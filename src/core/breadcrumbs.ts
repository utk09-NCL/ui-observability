// src/core/breadcrumbs.ts
//
// A ring buffer that keeps a bounded, time-ordered trail of recent user and system events.
// Breadcrumbs are never sent as records of their own. They reach the backend inside the
// payload of an error record. Nothing in this file throws.

import { BREADCRUMB_MIN_CAPACITY } from "../constants";

/** Category of a breadcrumb event. */
export type BreadcrumbCategory =
  | "log"
  | "action"
  | "event"
  | "click"
  | "navigation"
  | "http"
  | "console"
  | "frame"
  | "profile"
  | "custom";

/** Short summary of one event, kept so an error record can carry it. */
export interface Breadcrumb {
  /** Timestamp in epoch milliseconds. */
  t: number;
  /** Category of the event. */
  category: BreadcrumbCategory;
  /** Human-readable description of the event. */
  message: string;
  /** Optional contextual metadata. */
  data?: Record<string, unknown>;
}

/** Fixed-size ring buffer that keeps recent breadcrumbs in time order. */
export class BreadcrumbBuffer {
  /** The ring's backing array. */
  private buffer: (Breadcrumb | undefined)[];

  /** Next write index in the circular buffer. */
  private pointer = 0;

  /**
   * True once the pointer has wrapped past the capacity. The pointer alone can't tell an
   * empty ring from one that wrapped back to index 0.
   */
  private filled = false;

  /** Maximum number of breadcrumbs the buffer keeps. */
  private capacity: number;

  /**
   * @param capacity Maximum number of breadcrumbs. 0 turns the buffer off. Any other value
   * below the minimum size is raised to it.
   */
  constructor(capacity: number) {
    this.capacity = capacity === 0 ? 0 : Math.max(capacity, BREADCRUMB_MIN_CAPACITY);
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
  }

  /**
   * Changes the capacity, keeping the most recent breadcrumbs that fit.
   * @param capacity New capacity. Pass 0 to drop the stored breadcrumbs and turn the buffer off.
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
   * Adds a breadcrumb. When the buffer is full, it overwrites the oldest one.
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

  /** Removes all breadcrumbs, so a new session never carries the previous user's trail. */
  clear(): void {
    this.buffer.fill(undefined);
    this.pointer = 0;
    this.filled = false;
  }

  /**
   * Returns all stored breadcrumbs, oldest to newest.
   * @returns The breadcrumbs in time order.
   */
  snapshot(): Breadcrumb[] {
    const ordered = this.filled
      ? [...this.buffer.slice(this.pointer), ...this.buffer.slice(0, this.pointer)]
      : this.buffer.slice(0, this.pointer);
    return ordered.filter((crumb): crumb is Breadcrumb => crumb !== undefined);
  }
}

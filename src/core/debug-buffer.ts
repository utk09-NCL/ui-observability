// src/core/debug-buffer.ts
//
// Keeps the recent records that minLevel or sampling dropped. An error record from this context
// sends them out first, so they show what happened before the error.

import { ATTR_DEBUG_BUFFER } from "../constants";
import type { DebugBufferOptions } from "../models/config";
import type { LogRecord } from "../models/log-record";

/** One kept record, with the time the buffer took it. */
interface Kept {
  /** Epoch time in milliseconds when the buffer took the record. */
  at: number;
  /** Built record. The privacy hooks have already run on it. */
  record: LogRecord;
}

/** Bounded list of the records that were dropped by level or by sampling. */
export class DebugBuffer {
  /** Kept records, oldest first. Can grow to twice maxRecords between trims. */
  private kept: Kept[] = [];

  /**
   * @param policy Returns the current settings. A later configure() can change them.
   */
  constructor(private readonly policy: () => DebugBufferOptions) {}

  /**
   * Keeps a record. When the buffer is full, the oldest record goes first.
   * @param record Built record. The privacy hooks have already run on it.
   */
  push(record: LogRecord): void {
    const { enabled, maxRecords } = this.policy();
    if (!enabled) {
      return;
    }

    this.kept.push({ at: Date.now(), record });
    // Trim in steps. Trimming on every push would copy the whole list each time.
    if (this.kept.length >= maxRecords * 2) {
      this.kept = this.kept.slice(-maxRecords);
    }
  }

  /**
   * Takes the kept records that aren't too old and empties the buffer.
   * @returns The records, oldest first, each with `uiobs.debug_buffer: true`.
   */
  drain(): LogRecord[] {
    const kept = this.live();
    this.kept = [];

    return kept.map(({ record }) => ({
      ...record,
      attributes: { ...record.attributes, [ATTR_DEBUG_BUFFER]: true },
    }));
  }

  /**
   * Returns the kept records without taking them.
   * @returns The records, oldest first.
   */
  snapshot(): LogRecord[] {
    return this.live().map(({ record }) => record);
  }

  /**
   * Returns the kept records that the current settings allow. A disabled buffer empties itself.
   * @returns The records, oldest first.
   */
  private live(): Kept[] {
    const { enabled, maxRecords, maxAgeMs } = this.policy();
    if (!enabled) {
      this.kept = [];
      return [];
    }

    const oldest = maxAgeMs === null ? -Infinity : Date.now() - maxAgeMs;

    return this.kept.slice(-maxRecords).filter((entry) => entry.at >= oldest);
  }

  /** Removes every kept record, so nothing from an old session or identity goes out. */
  clear(): void {
    this.kept = [];
  }
}

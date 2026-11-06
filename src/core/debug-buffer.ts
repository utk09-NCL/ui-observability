// src/core/debug-buffer.ts
//
// Keeps the recent records that minLevel or sampling dropped. An error record of this context
// sends them first. They show what happened before the error.

import { ATTR_DEBUG_BUFFER } from "../constants";
import type { DebugBufferPolicy } from "../models/config";
import type { LogRecord } from "../models/log-record";

/** One kept record and the time when the buffer took it. */
interface Kept {
  /** Epoch time in milliseconds when the buffer took the record. */
  at: number;
  /** Built record. The privacy hooks already ran on it. */
  record: LogRecord;
}

/** Bounded list of the records that the library dropped by level or by sampling. */
export class DebugBuffer {
  /** Kept records, oldest first. It can hold up to two times maxRecords between trims. */
  private kept: Kept[] = [];

  /**
   * @param policy Gives the settings in force. A later configure() can change them.
   */
  constructor(private readonly policy: () => DebugBufferPolicy) {}

  /**
   * Keeps a record. When the buffer is full, the oldest record leaves first.
   * @param record Built record. The privacy hooks already ran on it.
   */
  push(record: LogRecord): void {
    const { enabled, maxRecords } = this.policy();
    if (!enabled) {
      return;
    }

    this.kept.push({ at: Date.now(), record });
    // Trim in steps. A trim at each push would copy the whole list each time.
    if (this.kept.length >= maxRecords * 2) {
      this.kept = this.kept.slice(-maxRecords);
    }
  }

  /**
   * Takes the kept records that are not too old, and empties the buffer.
   * @returns The records, oldest first. Each has `uiobs.debug_buffer: true`.
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
   * Gives the kept records without taking them.
   * @returns The records, oldest first.
   */
  snapshot(): LogRecord[] {
    return this.live().map(({ record }) => record);
  }

  /**
   * Gives the kept records that the settings in force permit. A buffer that is off empties itself.
   * @returns The records, oldest first.
   */
  private live(): Kept[] {
    const { enabled, maxRecords, maxAgeMs } = this.policy();
    if (!enabled) {
      this.kept = [];
      return [];
    }

    const oldest = maxAgeMs === 0 ? -Infinity : Date.now() - maxAgeMs;

    return this.kept.slice(-maxRecords).filter((entry) => entry.at >= oldest);
  }

  /** Removes each kept record. The records of an old session or identity must not go out. */
  clear(): void {
    this.kept = [];
  }
}

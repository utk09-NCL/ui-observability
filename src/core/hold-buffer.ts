// src/core/hold-buffer.ts
//
// Holds records while the runtime can't deliver them. An action is an audit fact, so actions
// have their own cap and a storm of other records can't push one out.

import { BUS_MAX_BOOT_BUFFER_ACTIONS, BUS_MAX_BOOT_BUFFER_RECORDS } from "../constants";
import { isActionRecord } from "../models/batch";
import type { LogRecord } from "../models/log-record";

/** Holds records in arrival order. A full buffer drops its oldest record of the same kind. */
export class HoldBuffer {
  /** Held records in arrival order. */
  private held: LogRecord[] = [];

  /** Number of held actions. Counting them spots a full buffer without a scan on every push. */
  private actions = 0;

  /**
   * @param onDrop Receives the record that a full buffer drops.
   */
  constructor(private readonly onDrop: (record: LogRecord) => void) {}

  /** Held records in arrival order. */
  get records(): readonly LogRecord[] {
    return this.held;
  }

  /** Number of held records. */
  get length(): number {
    return this.held.length;
  }

  /**
   * Adds a record. A full buffer drops its oldest record of the same kind.
   * @param record Record to hold.
   */
  push(record: LogRecord): void {
    const action = isActionRecord(record);
    const count = action ? this.actions : this.held.length - this.actions;
    const cap = action ? BUS_MAX_BOOT_BUFFER_ACTIONS : BUS_MAX_BOOT_BUFFER_RECORDS;

    if (count < cap) {
      this.actions += action ? 1 : 0;
    } else {
      // Scan only at the cap. Scanning on every push would be quadratic in a log storm.
      const oldest = this.held.findIndex((one) => isActionRecord(one) === action);
      const [dropped] = this.held.splice(oldest, 1);
      this.onDrop(dropped);
    }

    this.held.push(record);
  }

  /**
   * Removes the held records.
   * @returns The records in arrival order.
   */
  take(): LogRecord[] {
    const records = this.held;
    this.held = [];
    this.actions = 0;
    return records;
  }
}

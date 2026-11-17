// src/core/hold-buffer.ts
//
// Holds records while the runtime can't deliver them. A full buffer keeps its first records,
// because the first error of a failed startup is usually the cause, and drops the oldest record
// after them. An action is an audit fact, so actions have their own lists with their own cap,
// and a storm of other records can't push one out.

import { BUS_MAX_BOOT_BUFFER_ACTIONS, HOLD_BUFFER_HEAD_RECORDS } from "../constants";
import { isActionRecord } from "../models/batch";
import type { LogRecord } from "../models/log-record";

/** One held record. The arrival number puts the lists back into one order. */
interface Held {
  /** The record. */
  record: LogRecord;
  /** Counts up with every push. */
  arrival: number;
}

/** The held records of one kind, oldest first in each list. */
interface Kind {
  /** The first HOLD_BUFFER_HEAD_RECORDS records. A full buffer never drops one of them. */
  head: Held[];
  /** Every later record. A full buffer drops the oldest of them. */
  tail: Held[];
}

/** Holds records and returns them in arrival order. Each kind keeps its head when it is full. */
export class HoldBuffer {
  /** Held actions. */
  private actions: Kind = { head: [], tail: [] };

  /** Held records of every other kind. */
  private others: Kind = { head: [], tail: [] };

  /** Arrival number of the next record. */
  private arrivals = 0;

  /**
   * @param onDrop Receives the record that a full buffer drops.
   */
  constructor(private readonly onDrop: (record: LogRecord) => void) {}

  /** Held records in arrival order. */
  get records(): readonly LogRecord[] {
    return this.inOrder();
  }

  /** Number of held records. */
  get length(): number {
    const { actions, others } = this;
    return actions.head.length + actions.tail.length + others.head.length + others.tail.length;
  }

  /**
   * Adds a record. A full buffer drops its oldest record of the same kind after the head.
   * @param record Record to hold.
   * @param maxRecords Cap on records that aren't actions. The caller reads it from the config
   * on each push, because a record can arrive before the app's configure() sets the cap.
   */
  push(record: LogRecord, maxRecords: number): void {
    const action = isActionRecord(record);
    const kind = action ? this.actions : this.others;
    const cap = action ? BUS_MAX_BOOT_BUFFER_ACTIONS : maxRecords;
    const held = { record, arrival: this.arrivals };
    this.arrivals += 1;

    if (kind.head.length < HOLD_BUFFER_HEAD_RECORDS) {
      kind.head.push(held);
      return;
    }

    kind.tail.push(held);

    if (kind.head.length + kind.tail.length > cap) {
      // The tail holds at least the record just pushed, so it always has a front to drop. It is
      // shift() and not splice(0, 1), because splice moves the whole tail on every drop of a storm.
      const dropped = kind.tail[0];
      kind.tail.shift();
      this.onDrop(dropped.record);
    }
  }

  /**
   * Removes the held records.
   * @returns The records in arrival order.
   */
  take(): LogRecord[] {
    const records = this.inOrder();
    this.actions = { head: [], tail: [] };
    this.others = { head: [], tail: [] };
    this.arrivals = 0;
    return records;
  }

  /**
   * Builds one list from the four. Each list is already sorted, so the sort only merges runs.
   * @returns The held records in arrival order.
   */
  private inOrder(): LogRecord[] {
    const { actions, others } = this;
    return [...actions.head, ...actions.tail, ...others.head, ...others.tail]
      .sort((first, second) => first.arrival - second.arrival)
      .map((held) => held.record);
  }
}

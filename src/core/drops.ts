// src/core/drops.ts
//
// This module collects lost records into onDrop summaries. It sends one summary for each
// reason after the current task. A storm of losses then gives one call, not one per record.

import { ATTR_JOURNEY_ID, DROP_SUMMARY_MAX_ITEMS } from "../constants";
import { attributeOf, isActionRecord } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { DropSummary, LossReason } from "../models/drop";
import type { LogRecord } from "../models/log-record";
import { runAsLibraryConsole } from "../utils/library-console";
import { runAsLibraryRequest } from "../utils/library-request";
import type { Diagnostics } from "./diagnostics";

/**
 * Adds a value to a summary list. The list keeps each value one time, up to the limit.
 * @param list Summary list.
 * @param value Value to add.
 */
function addCapped(list: string[], value: string): void {
  if (list.length < DROP_SUMMARY_MAX_ITEMS && !list.includes(value)) {
    list.push(value);
  }
}

/** Collects lost records and gives one summary for each reason to the onDrop hook. */
export class DropReporter {
  /** Summaries that wait for the end of the task, one for each reason. */
  private readonly pending = new Map<LossReason, DropSummary>();

  /** True while a microtask waits to send the summaries. */
  private scheduled = false;

  /** True while the hook runs. A loss that the hook causes is not reported again. */
  private reporting = false;

  /**
   * @param config Active configuration. The reporter reads `onDrop` from it at each call.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Adds lost records to the summary of their reason. Without an onDrop hook, it does nothing.
   * @param reason Cause of the loss.
   * @param records Lost records.
   * @param batchIds Ids of the lost batches.
   */
  add(reason: LossReason, records: readonly LogRecord[], batchIds: readonly string[] = []): void {
    // A hook that logs can fill a buffer again. A report of that loss starts a loop.
    if (!this.config.onDrop || this.reporting) {
      return;
    }

    // A failed load with an empty buffer loses nothing. A corrupt entry has no id to report.
    if (records.length === 0 && batchIds.length === 0) {
      return;
    }

    let summary = this.pending.get(reason);
    if (!summary) {
      summary = { reason, records: 0, batchIds: [], journeyIds: [], actions: [] };
      this.pending.set(reason, summary);
    }

    summary.records += records.length;
    for (const id of batchIds) {
      addCapped(summary.batchIds, id);
    }

    for (const record of records) {
      // A record from storage can be corrupt. It can be null or have no attributes.
      const journey = attributeOf(record, ATTR_JOURNEY_ID);
      if (typeof journey === "string") {
        addCapped(summary.journeyIds, journey);
      }

      const body: unknown = isActionRecord(record) ? record.body : undefined;
      if (typeof body === "string") {
        addCapped(summary.actions, body);
      }
    }

    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.flush();
      });
    }
  }

  /** Gives each waiting summary to the hook. A hook that throws does not stop the others. */
  private flush(): void {
    this.scheduled = false;
    const summaries = [...this.pending.values()];
    this.pending.clear();

    const onDrop = this.config.onDrop;
    if (!onDrop) {
      return;
    }

    this.reporting = true;
    for (const summary of summaries) {
      this.diagnostics.guard("handler.threw", "The onDrop hook threw an error.", () => {
        // The capture modules skip a request or a console line of the hook. A captured line
        // gives a record. That record can evict one more stored batch.
        runAsLibraryRequest(() => {
          runAsLibraryConsole(() => {
            onDrop(summary);
          });
        });
      });
    }
    this.reporting = false;
  }
}

// src/core/drops.ts
//
// Collects lost records into onDrop summaries and sends one summary per reason after the
// current task. A storm of losses then makes one call, not one per record.

import { ATTR_JOURNEY_ID, DROP_SUMMARY_MAX_ITEMS } from "../constants";
import { attributeOf, isActionRecord } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { DropSummary, LossReason } from "../models/drop";
import type { LogRecord } from "../models/log-record";
import { runAsLibraryConsole } from "../utils/library-console";
import { runAsLibraryRequest } from "../utils/library-request";
import type { Diagnostics } from "./diagnostics";

/**
 * Adds a value to a summary list. The list keeps each value once, up to the limit.
 * @param list Summary list.
 * @param value Value to add.
 */
function addCapped(list: string[], value: string): void {
  if (list.length < DROP_SUMMARY_MAX_ITEMS && !list.includes(value)) {
    list.push(value);
  }
}

/** Collects lost records and hands the onDrop hook one summary per reason. */
export class DropReporter {
  /** Summaries waiting for the end of the task, one per reason. */
  private readonly pending = new Map<LossReason, DropSummary>();

  /** True while a microtask is waiting to send the summaries. */
  private scheduled = false;

  /** True while the hook runs. A loss the hook itself causes isn't reported again. */
  private reporting = false;

  /**
   * @param config Active configuration. `onDrop` is read from it on every call.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Adds lost records to the summary for their reason. Does nothing without an onDrop hook.
   * @param reason Cause of the loss.
   * @param records Lost records.
   * @param batchIds Ids of the lost batches.
   */
  add(reason: LossReason, records: readonly LogRecord[], batchIds: readonly string[] = []): void {
    // A hook that logs can fill a buffer again, and reporting that loss would start a loop.
    if (!this.config.onDrop || this.reporting) {
      return;
    }

    // A failed load with an empty buffer loses nothing, and a corrupt entry has no id to report.
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
      // A record from storage can be corrupt: null, or missing its attributes.
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

  /** Hands every waiting summary to the hook. A hook that throws doesn't stop the others. */
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
        // The capture modules skip any request or console line the hook makes. A captured line
        // would become a record, and that record could evict one more stored batch.
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

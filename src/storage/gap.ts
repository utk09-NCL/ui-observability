// src/storage/gap.ts
//
// Counts and reports the batches a storage adapter drops. Every dropped batch is a loss, and
// the gap handler passes it on to onDrop.

import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { GapReporter, PruneResult } from "../models/storage";

/**
 * Adds one rule's drop to the prune result.
 * @param result The prune result across all rules.
 * @param reason The rule that dropped the batches.
 * @param batches Number of dropped batches.
 * @param records Number of dropped records.
 * @returns The counts for this rule alone, for the gap report.
 */
export function addDrop(
  result: PruneResult,
  reason: PruneResult["reason"],
  batches: number,
  records: number,
): PruneResult {
  result.batches += batches;
  result.records += records;
  result.reason = reason;
  return { batches, records, reason };
}

/**
 * Reports dropped batches to diagnostics and to the gap handler. An empty drop reports nothing.
 * @param diagnostics Diagnostics reporter.
 * @param onGap The adapter's gap handler.
 * @param gap The drop's counts and reason.
 * @param dropped The dropped batches that the adapter could read.
 */
export function reportEviction(
  diagnostics: Diagnostics,
  onGap: GapReporter | undefined,
  gap: PruneResult,
  dropped: readonly LogBatch[],
): void {
  if (gap.batches === 0) {
    return;
  }

  diagnostics.report(
    "storage.evicted",
    `The library dropped ${String(gap.batches)} stored batches (${String(gap.records)} records).`,
    { ...gap },
  );
  onGap?.(gap, dropped);
}

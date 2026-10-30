// src/storage/gap.ts
//
// This module counts and reports the batches that a storage adapter drops. Each dropped batch is a
// loss. The gap handler gives it to onDrop.

import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { GapReporter, PruneResult } from "../models/storage";

/**
 * Adds the drop of one rule to the prune result.
 * @param result Prune result of all rules.
 * @param reason Rule that dropped the batches.
 * @param batches Number of dropped batches.
 * @param records Number of dropped records.
 * @returns The counts of this rule alone, for the gap report.
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
 * @param onGap Gap handler of the adapter.
 * @param gap Counts and reason of the drop.
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

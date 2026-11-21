// src/panels/positions-protocol.ts
//
// The messages between the Positions panel and its worker. The library uses the same channel for
// its own bus messages, so each side checks the shape and ignores any other message.

import type { Pair } from "../api/types";

export interface PositionInput {
  pair: Pair;
  netQty: number;
  avgPrice: number;
}

export interface PnlRow {
  pair: Pair;
  netQty: number;
  avgPrice: number;
  mid: number | null;
  /** Profit or loss in the quote currency, or null before the first price. */
  pnl: number | null;
}

export type ToWorker =
  | { type: "positions"; rows: PositionInput[] }
  | { type: "price"; pair: Pair; bid: number; ask: number };

export interface FromWorker {
  type: "pnl";
  rows: PnlRow[];
  computeMs: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Checks a message of the page. Any other message is not ours.
 * @param value The data of a message event.
 * @returns True for a message of this protocol.
 */
export function isToWorker(value: unknown): value is ToWorker {
  if (!isObject(value)) {
    return false;
  }
  if (value.type === "positions") {
    return Array.isArray(value.rows);
  }

  return (
    value.type === "price" &&
    typeof value.pair === "string" &&
    typeof value.bid === "number" &&
    typeof value.ask === "number"
  );
}

/**
 * Checks a message of the worker. Any other message is not ours.
 * @param value The data of a message event.
 * @returns True for a message of this protocol.
 */
export function isFromWorker(value: unknown): value is FromWorker {
  return isObject(value) && value.type === "pnl" && Array.isArray(value.rows);
}

/**
 * Computes the profit or loss of each position from the mid prices.
 * @param positions The net positions.
 * @param mids The latest mid price of each pair.
 * @returns One row for each position.
 */
export function computePnl(
  positions: readonly PositionInput[],
  mids: ReadonlyMap<string, number>,
): PnlRow[] {
  return positions.map((position) => {
    const mid = mids.get(position.pair) ?? null;

    return {
      ...position,
      mid,
      pnl: mid === null ? null : Number((position.netQty * (mid - position.avgPrice)).toFixed(2)),
    };
  });
}

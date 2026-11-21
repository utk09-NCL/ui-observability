// src/data/market-store.ts
//
// The live prices and the tick rate. The WebSocket handler writes them, and the Prices panel and
// the order ticket read them. One store for the page, so two panels never open two sockets.

import { useSyncExternalStore } from "react";
import { gauge } from "@utk09/ui-observability";
import { PAIRS, type Pair, type Quote } from "../api/types";

export type Direction = "up" | "down" | "flat";

export interface Tile extends Quote {
  direction: Direction;
}

export type Prices = Partial<Record<Pair, Tile>>;

export interface MarketState {
  prices: Prices;
  /** Ticks in the last full second, or null before the first second has passed. */
  ticksPerSecond: number | null;
}

const INITIAL: MarketState = { prices: {}, ticksPerSecond: null };
const RATE_WINDOW_MS = 1000;
/** Mid prices that the chart keeps for each pair. At 4 ticks a second this is one minute. */
const HISTORY_LENGTH = 240;

// The gauge handle is at module scope. It stays valid across configure() and shutdown().
const tickRate = gauge("market.tick_rate", { unit: "{tick}/s" });

let state: MarketState = INITIAL;
let ticks = 0;
const history = new Map<Pair, number[]>(PAIRS.map((pair) => [pair, []]));
const listeners = new Set<() => void>();

function publish(next: MarketState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getMarketState(): MarketState {
  return state;
}

/**
 * Returns the last mid prices of a pair, oldest first. The chart reads it on a timer and not
 * through React state, because 16 ticks a second would make 16 renders for a canvas.
 * @param pair The pair.
 * @returns The mid prices.
 */
export function getHistory(pair: Pair): readonly number[] {
  return history.get(pair) ?? [];
}

export function subscribeMarket(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Reads the market state in a component. */
export function useMarket(): MarketState {
  return useSyncExternalStore(subscribeMarket, getMarketState);
}

/**
 * Stores one tick. The direction compares the new bid with the old one of the same pair.
 * @param pair The pair that ticked.
 * @param bid The new bid.
 * @param ask The new ask.
 */
export function applyTick(pair: Pair, bid: number, ask: number): void {
  ticks += 1;
  const mids = history.get(pair);
  if (mids) {
    mids.push((bid + ask) / 2);
    if (mids.length > HISTORY_LENGTH) {
      mids.shift();
    }
  }
  const previous = state.prices[pair];
  let direction: Direction = "flat";
  if (previous && bid !== previous.bid) {
    direction = bid > previous.bid ? "up" : "down";
  }

  publish({ ...state, prices: { ...state.prices, [pair]: { bid, ask, direction } } });
}

/**
 * Starts the tick-rate meter. Each second it stores the count and sets the gauge. The cleanup
 * stops the timer, so StrictMode can mount, unmount and mount again.
 * @returns Function that stops the meter.
 */
export function startTickRate(): () => void {
  const timer = setInterval(() => {
    const rate = ticks;
    ticks = 0;
    tickRate.set(rate);
    publish({ ...state, ticksPerSecond: rate });
  }, RATE_WINDOW_MS);

  return () => {
    clearInterval(timer);
  };
}

/** Forgets the prices and the rate, for example at logout. */
export function resetMarket(): void {
  ticks = 0;
  for (const mids of history.values()) {
    mids.length = 0;
  }
  publish(INITIAL);
}

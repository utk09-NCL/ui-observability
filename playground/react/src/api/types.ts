// src/api/types.ts
//
// The shapes of tools/mock-app-api.mjs.

export const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"] as const;
export type Pair = (typeof PAIRS)[number];

export type Side = "BUY" | "SELL";
export type OrderStatus = "working" | "filled" | "cancelled";
export type FaultMode = "none" | "slow" | "reject" | "error";

export interface Order {
  id: string;
  pair: Pair;
  side: Side;
  qty: number;
  status: OrderStatus;
  /** Fill price, or null until the order fills. */
  price: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewOrder {
  pair: Pair;
  side: Side;
  qty: number;
}

export interface Tenant {
  id: string;
  name: string;
}

export interface LoginResult {
  token: string;
  user: string;
  tenant: string;
  expiresInMs: number;
}

/** One row of GET /api/positions. The mock API nets the filled orders of the user by pair. */
export interface Position {
  pair: Pair;
  netQty: number;
  avgPrice: number;
}

export interface Quote {
  bid: number;
  ask: number;
}

/** A message of the price stream. */
export type StreamMessage =
  | { type: "price"; pair: Pair; bid: number; ask: number; ts: number }
  | { type: "order"; order: Order };

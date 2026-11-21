import { describe, expect, it } from "vitest";
import { computePnl, isFromWorker, isToWorker } from "./positions-protocol";

describe("computePnl", () => {
  it("multiplies the net quantity by the move of the mid price", () => {
    const rows = computePnl(
      [{ pair: "EURUSD", netQty: 1000, avgPrice: 1.08 }],
      new Map([["EURUSD", 1.0825]]),
    );

    expect(rows).toEqual([{ pair: "EURUSD", netQty: 1000, avgPrice: 1.08, mid: 1.0825, pnl: 2.5 }]);
  });

  it("gives a loss for a short position when the price rises", () => {
    const [row] = computePnl(
      [{ pair: "GBPUSD", netQty: -500, avgPrice: 1.27 }],
      new Map([["GBPUSD", 1.28]]),
    );

    expect(row.pnl).toBe(-5);
  });

  it("gives no P&L before the first price of the pair", () => {
    const [row] = computePnl([{ pair: "AUDUSD", netQty: 100, avgPrice: 0.66 }], new Map());

    expect(row).toMatchObject({ mid: null, pnl: null });
  });
});

describe("message guards", () => {
  it("accepts the two messages of the page", () => {
    expect(isToWorker({ type: "positions", rows: [] })).toBe(true);
    expect(isToWorker({ type: "price", pair: "EURUSD", bid: 1, ask: 1.1 })).toBe(true);
  });

  it("ignores the bus messages of the library and other values", () => {
    expect(isToWorker({ type: "ui-observability.message.hello" })).toBe(false);
    expect(isToWorker({ type: "price", pair: "EURUSD", bid: "1", ask: 1.1 })).toBe(false);
    expect(isToWorker({ type: "positions", rows: "none" })).toBe(false);
    expect(isToWorker(null)).toBe(false);
    expect(isToWorker("price")).toBe(false);
    expect(isFromWorker({ type: "ui-observability.message.hello" })).toBe(false);
    expect(isFromWorker(null)).toBe(false);
  });

  it("accepts the answer of the worker", () => {
    expect(isFromWorker({ type: "pnl", rows: [], computeMs: 0.1 })).toBe(true);
  });
});

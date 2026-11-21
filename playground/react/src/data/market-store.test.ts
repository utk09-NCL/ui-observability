import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTick, getMarketState, resetMarket, startTickRate } from "./market-store";

afterEach(() => {
  resetMarket();
  vi.useRealTimers();
});

describe("market store", () => {
  it("marks the direction of the bid against the last tick of the same pair", () => {
    applyTick("EURUSD", 1.08, 1.0802);
    expect(getMarketState().prices.EURUSD?.direction).toBe("flat");

    applyTick("EURUSD", 1.081, 1.0812);
    expect(getMarketState().prices.EURUSD?.direction).toBe("up");

    applyTick("EURUSD", 1.0805, 1.0807);
    expect(getMarketState().prices.EURUSD?.direction).toBe("down");

    applyTick("EURUSD", 1.0805, 1.0807);
    expect(getMarketState().prices.EURUSD?.direction).toBe("flat");
  });

  it("keeps the pairs apart", () => {
    applyTick("EURUSD", 1.08, 1.0802);
    applyTick("USDJPY", 150.2, 150.23);

    expect(getMarketState().prices.USDJPY?.bid).toBe(150.2);
  });

  it("counts the ticks of each second, and stops its timer", () => {
    vi.useFakeTimers();
    const stop = startTickRate();

    applyTick("EURUSD", 1.08, 1.0802);
    applyTick("EURUSD", 1.0801, 1.0803);
    vi.advanceTimersByTime(1000);
    expect(getMarketState().ticksPerSecond).toBe(2);

    vi.advanceTimersByTime(1000);
    expect(getMarketState().ticksPerSecond).toBe(0);

    stop();
    applyTick("EURUSD", 1.08, 1.0802);
    vi.advanceTimersByTime(5000);
    expect(getMarketState().ticksPerSecond).toBe(0);
  });

  it("forgets the prices and the rate on reset", () => {
    applyTick("EURUSD", 1.08, 1.0802);
    resetMarket();

    expect(getMarketState()).toEqual({ prices: {}, ticksPerSecond: null });
  });
});

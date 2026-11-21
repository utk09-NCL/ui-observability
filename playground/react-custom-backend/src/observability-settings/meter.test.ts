import { describe, expect, it } from "vitest";
import {
  buildPayload,
  MIN_BLOCKS_FOR_P99,
  MIN_TICKS_PER_BLOCK,
  p99Cell,
  percentile,
  pickCallsPerBlock,
  spread,
} from "./meter";

describe("cost meter", () => {
  it("reports percentiles by the nearest-rank rule", () => {
    const samples = Float64Array.from({ length: 100 }, (_, index) => index + 1);

    expect(spread(samples)).toEqual({ p50: 50, p99: 99, max: 100 });
    expect(percentile(Float64Array.from([5]), 0.99)).toBe(5);
  });

  it("does not depend on the order of the samples", () => {
    expect(spread(Float64Array.from([3, 1, 2]))).toEqual({ p50: 2, p99: 3, max: 3 });
  });

  it("picks enough calls for a block to span twice the fewest clock steps", () => {
    // 2,000 ns for a call and a 5 us step: 200 steps are 1,000 us, so 500 calls.
    const calls = pickCallsPerBlock(2000, 5);

    expect(calls).toBe(500);
    expect((calls * 2) / 5).toBeGreaterThanOrEqual(MIN_TICKS_PER_BLOCK);
  });

  it("keeps a block inside the call budget when the clock is coarse", () => {
    // A 100 us step needs 10,000 calls of 2,000 ns. The budget allows a third of 4,000.
    expect(pickCallsPerBlock(2000, 100)).toBe(1333);
  });

  it("keeps a block at 10 calls or more when a call is slow", () => {
    expect(pickCallsPerBlock(500_000, 5)).toBe(10);
  });

  it("prints the max of the blocks when there are too few for a p99", () => {
    const blockNs = { p50: 100, p99: 250, max: 250 };

    expect(p99Cell({ blocks: 8, blockNs })).toBe("max of 8 blocks");
    expect(p99Cell({ blocks: MIN_BLOCKS_FOR_P99, blockNs })).toBe("250");
  });

  it("builds the two payloads of the meter", () => {
    expect(Object.keys(buildPayload("order"))).toContain("orderId");
    expect((buildPayload("blotter").snapshot as unknown[]).length).toBe(500);
  });
});

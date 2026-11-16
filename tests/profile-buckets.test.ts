import { describe, expect, it } from "vitest";
import { bucketOf, percentileOf, pointBuckets, upperOf } from "../src/core/profile-buckets";

const BUCKETS = 368;
const MAX_US = 67_108_863;

// The probe under test starts at this base. Other probes fill the array on either side of it.
const BASE = BUCKETS;
const NOISE = 9;

type Point = ReturnType<typeof pointBuckets>;

const allIndexes = Array.from({ length: BUCKETS }, (_unused, i) => i);

/** Builds three probes in one array. The one at the base has the counts, the others are noise. */
function makeBuckets(counts: Record<number, number>, base = BASE): Uint32Array {
  const buckets = new Uint32Array(BUCKETS * 3).fill(NOISE);

  buckets.fill(0, base, base + BUCKETS);
  for (const [index, count] of Object.entries(counts)) {
    buckets[base + Number(index)] = count;
  }

  return buckets;
}

/** Builds a counts record for the buckets from first to last. */
function rangeOf(first: number, last: number, countOf: (index: number) => number = () => 1) {
  const counts: Record<number, number> = {};

  for (let i = first; i <= last; i++) {
    counts[i] = countOf(i);
  }

  return counts;
}

function totalOf(buckets: Uint32Array, base = BASE): number {
  return buckets.subarray(base, base + BUCKETS).reduce((sum, count) => sum + count, 0);
}

/** Checks the rules every summary point has to follow. */
function expectShape(point: Point, total: number, merge: number): void {
  const size = 2 ** merge;

  expect(Array.isArray(point.bounds)).toBe(true);
  expect(Array.isArray(point.counts)).toBe(true);
  expect(point.counts.length).toBe(point.bounds.length + 1);
  expect(point.counts.reduce((sum, count) => sum + count, 0)).toBe(total);

  for (let i = 1; i < point.bounds.length; i++) {
    expect(point.bounds[i]).toBeGreaterThan(point.bounds[i - 1]);
  }

  // A bound is upperOf(k * 2^merge - 1) in milliseconds, for an integer k.
  for (const bound of point.bounds) {
    const end = bucketOf(Math.round(bound * 1000));

    expect(upperOf(end) / 1000).toBe(bound);
    expect((end + 1) % size).toBe(0);
  }
}

describe("bucketOf", () => {
  it("gives each value from 0 to 15 its own bucket", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1)).toBe(1);
    expect(bucketOf(7)).toBe(7);
    expect(bucketOf(15)).toBe(15);
  });

  it("gives each value from 16 to 31 its own bucket", () => {
    expect(bucketOf(16)).toBe(16);
    expect(bucketOf(17)).toBe(17);
    expect(bucketOf(31)).toBe(31);
  });

  it("puts two values in each bucket of the range 32 to 63", () => {
    expect(bucketOf(32)).toBe(32);
    expect(bucketOf(33)).toBe(32);
    expect(bucketOf(34)).toBe(33);
    expect(bucketOf(62)).toBe(47);
    expect(bucketOf(63)).toBe(47);
  });

  it("puts the edge values of the range 64 to 127 in the correct buckets", () => {
    expect(bucketOf(63)).toBe(47);
    expect(bucketOf(64)).toBe(48);
    expect(bucketOf(67)).toBe(48);
    expect(bucketOf(68)).toBe(49);
    expect(bucketOf(127)).toBe(63);
    expect(bucketOf(128)).toBe(64);
  });

  it("puts the edge values of the range 2^25 to 2^26 - 1 in the correct buckets", () => {
    expect(bucketOf(33_554_431)).toBe(351);
    expect(bucketOf(33_554_432)).toBe(352);
    expect(bucketOf(35_651_583)).toBe(352);
    expect(bucketOf(35_651_584)).toBe(353);
  });

  it("starts bucket 367 at 65,011,712 and ends it at the largest value", () => {
    expect(bucketOf(65_011_711)).toBe(366);
    expect(bucketOf(65_011_712)).toBe(367);
    expect(bucketOf(MAX_US)).toBe(367);
  });

  it("puts a value above the largest value in bucket 367", () => {
    // 2^32 proves that the clamp runs before the 32-bit math.
    expect(bucketOf(2 ** 26)).toBe(367);
    expect(bucketOf(2 ** 30)).toBe(367);
    expect(bucketOf(2 ** 32)).toBe(367);
  });
});

describe("upperOf", () => {
  it("returns the value itself as the bound for buckets 0 to 15", () => {
    for (let i = 0; i < 16; i++) {
      expect(upperOf(i)).toBe(i);
    }
  });

  it("returns a bucket's largest value as its bound", () => {
    expect(upperOf(16)).toBe(16);
    expect(upperOf(31)).toBe(31);
    expect(upperOf(32)).toBe(33);
    expect(upperOf(33)).toBe(35);
    expect(upperOf(47)).toBe(63);
    expect(upperOf(48)).toBe(67);
    expect(upperOf(100)).toBe(671);
    expect(upperOf(352)).toBe(35_651_583);
  });

  it("returns the largest value as the bound of bucket 367", () => {
    expect(upperOf(367)).toBe(MAX_US);
  });

  it("maps the bound of each of the 368 buckets to the same bucket", () => {
    const wrong = allIndexes.filter((i) => bucketOf(upperOf(i)) !== i);

    expect(allIndexes).toHaveLength(368);
    expect(wrong).toEqual([]);
  });

  it("maps the value after the bound of a bucket to the next bucket", () => {
    const wrong = allIndexes.slice(0, -1).filter((i) => bucketOf(upperOf(i) + 1) !== i + 1);

    expect(wrong).toEqual([]);
  });

  it("keeps the width of each bucket from 16 at 1/16 of its bound or less", () => {
    const ratios = allIndexes.slice(16).map((i) => (upperOf(i) - upperOf(i - 1)) / upperOf(i));

    expect(ratios).toHaveLength(352);
    expect(Math.max(...ratios)).toBe(1 / 16);
    expect(ratios.filter((ratio) => ratio > 1 / 16)).toEqual([]);
  });
});

describe("percentileOf", () => {
  // The count is 100: bucket 5 holds 50 values, bucket 20 holds 40 and bucket 100 holds 9.
  const buckets = makeBuckets({ 5: 50, 20: 40, 100: 9, 367: 1 });

  it.each([
    // The rank floor of 1 skips the empty bucket 0.
    { q: 0, expected: 5 },
    { q: 0.5, expected: 5 },
    { q: 0.51, expected: 20 },
    { q: 0.9, expected: 20 },
    { q: 0.99, expected: 671 },
    { q: 1, expected: MAX_US },
  ])("returns $expected microseconds for q = $q", ({ q, expected }) => {
    expect(percentileOf(buckets, BASE, 100, q)).toBe(expected);
  });

  it("ignores the counts of the probes next to it", () => {
    const own = makeBuckets({ 40: 2 });

    expect(percentileOf(own, BASE, 2, 0)).toBe(49);
    expect(percentileOf(own, BASE, 2, 1)).toBe(49);
  });

  it("returns the bound of bucket 367 when the count is too large", () => {
    // The probe holds 3 values but the count claims 100. The next probe has counts too, and
    // must not be read.
    const small = makeBuckets({ 5: 3 });

    expect(percentileOf(small, BASE, 100, 0.99)).toBe(MAX_US);
  });
});

describe("pointBuckets", () => {
  it("returns no bound and one zero count for an empty probe", () => {
    const buckets = makeBuckets({});
    const point = pointBuckets(buckets, BASE);

    expect(point).toEqual({ bounds: [], counts: [0] });
    expectShape(point, 0, 0);
  });

  it("returns no bound and one count for a probe with one filled bucket", () => {
    const buckets = makeBuckets({ 40: 7 });
    const point = pointBuckets(buckets, BASE);

    expect(point).toEqual({ bounds: [], counts: [7] });
    expectShape(point, totalOf(buckets), 0);
  });

  it("gives each bucket its own group when the range has 100 buckets", () => {
    const buckets = makeBuckets(rangeOf(10, 109, (i) => i - 9));
    const point = pointBuckets(buckets, BASE);

    expect(point.counts).toEqual(Array.from({ length: 100 }, (_unused, k) => k + 1));
    expect(point.bounds).toHaveLength(99);
    expect(point.bounds[0]).toBe(0.01);
    expect(point.bounds[98]).toBe(0.927);
    expectShape(point, totalOf(buckets), 0);
  });

  it("merges two buckets in each group when the range has 101 buckets", () => {
    // The first bucket, 11, is odd, so the first group covers buckets 10 and 11.
    const buckets = makeBuckets(rangeOf(11, 111));
    const point = pointBuckets(buckets, BASE);

    expect(point.counts).toEqual([1, ...Array.from({ length: 50 }, () => 2)]);
    expect(point.bounds).toHaveLength(50);
    expect(point.bounds[0]).toBe(0.011);
    expect(point.bounds[1]).toBe(0.013);
    expect(point.bounds[49]).toBe(0.959);
    expectShape(point, 101, 1);
  });

  it("merges four buckets in each group when all 368 buckets have a count", () => {
    const buckets = makeBuckets(rangeOf(0, 367, (i) => i + 1));
    const point = pointBuckets(buckets, BASE);

    expect(point.counts).toEqual(Array.from({ length: 92 }, (_unused, g) => 16 * g + 10));
    expect(point.bounds).toHaveLength(91);
    expect(point.bounds[0]).toBe(0.003);
    expect(point.bounds[1]).toBe(0.007);
    expect(point.bounds[8]).toBe(0.039);
    expect(point.bounds[90]).toBe(58_720.255);
    expectShape(point, totalOf(buckets), 2);
  });

  it("keeps the empty groups between the first and the last filled bucket", () => {
    const buckets = makeBuckets({ 0: 2, 367: 3 });
    const point = pointBuckets(buckets, BASE);

    expect(point.counts).toEqual([2, ...Array.from({ length: 90 }, () => 0), 3]);
    expect(point.bounds).toHaveLength(91);
    expectShape(point, 5, 2);
  });

  it("reads only the buckets of its own probe at a base that is not a multiple of 4", () => {
    const buckets = makeBuckets({ 3: 1, 4: 1, 366: 2, 367: 5 }, 5);
    const point = pointBuckets(buckets, 5);

    expect(point.counts).toEqual([1, 1, ...Array.from({ length: 89 }, () => 0), 7]);
    expect(point.bounds[0]).toBe(0.003);
    expect(point.bounds[1]).toBe(0.007);
    expectShape(point, 9, 2);
  });
});

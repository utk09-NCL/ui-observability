// src/core/profile-buckets.ts
//
// This module maps a duration in microseconds to a bucket of the log-linear profiler histogram.
// It also reads a percentile and builds the explicit bounds of one summary record.

import {
  PROFILE_BUCKETS,
  PROFILE_MAX_US,
  PROFILE_POINT_BUCKETS,
  PROFILE_SUB_BITS,
} from "../constants";

/** Sub-buckets in one power of two. Each value below it has its own bucket. */
const SUB_COUNT = 1 << PROFILE_SUB_BITS;

/** Mask of the sub-bucket bits of a bucket index. */
const SUB_MASK = SUB_COUNT - 1;

/**
 * Gives the bucket of one duration. The hot path calls it for each value.
 * @param us Duration in microseconds. It is a non-negative integer.
 * @returns The bucket index from 0 to 367. A value above PROFILE_MAX_US gives 367.
 */
export function bucketOf(us: number): number {
  // Clamps before the bit math. Math.clz32 and >>> read 32 bits only.
  // A value of 2^32 or more then gives a wrong bucket.
  const value = Math.min(us, PROFILE_MAX_US);

  if (value < SUB_COUNT) {
    return value;
  }

  // Math.clz32 gives the exponent with no loop and no float math. A loop costs up to 26 steps.
  // The shift is the number of low bits below the sub-bucket bits.
  const shift = 31 - Math.clz32(value) - PROFILE_SUB_BITS;
  return ((shift + 1) << PROFILE_SUB_BITS) | ((value >>> shift) & SUB_MASK);
}

/**
 * Gives the largest duration of one bucket. The bucket holds this bound.
 * @param index Bucket index from 0 to 367.
 * @returns The upper bound in microseconds.
 */
export function upperOf(index: number): number {
  if (index < SUB_COUNT) {
    return index;
  }

  // Sets each low bit that bucketOf drops. Without them, the result is the smallest value.
  const shift = (index >>> PROFILE_SUB_BITS) - 1;
  return ((SUB_COUNT + (index & SUB_MASK)) << shift) + (1 << shift) - 1;
}

/**
 * Reads one percentile from the histogram of one probe. It allocates nothing.
 * @param buckets Bucket counts of all probes.
 * @param base Index of the first bucket of the probe.
 * @param count Total of the buckets of the probe. It is larger than 0.
 * @param q Percentile as a fraction, for example 0.99.
 * @returns The upper bound of the bucket that holds the rank, in microseconds.
 */
export function percentileOf(buckets: Uint32Array, base: number, count: number, q: number): number {
  // A rank of 0 matches the first bucket, also when that bucket is empty.
  const rank = Math.max(1, Math.ceil(q * count));
  let sum = 0;

  // Reads the counts in place. A copy or a sort makes garbage at each flush.
  for (let i = 0; i < PROFILE_BUCKETS; i++) {
    sum += buckets[base + i];

    if (sum >= rank) {
      return upperOf(i);
    }
  }

  // Only a wrong count gets here.
  return upperOf(PROFILE_BUCKETS - 1);
}

/**
 * Builds the explicit-bounds histogram of one summary record.
 * @param buckets Bucket counts of all probes.
 * @param base Index of the first bucket of the probe.
 * @returns The bounds in milliseconds and the count of each group. There is one count more than
 * bounds.
 */
export function pointBuckets(
  buckets: Uint32Array,
  base: number,
): { bounds: number[]; counts: number[] } {
  let first = 0;
  while (first < PROFILE_BUCKETS && buckets[base + first] === 0) {
    first++;
  }

  if (first === PROFILE_BUCKETS) {
    return { bounds: [], counts: [0] };
  }

  // The bucket at first is not empty. This loop stops there at the latest.
  let last = PROFILE_BUCKETS - 1;
  while (buckets[base + last] === 0) {
    last--;
  }

  // Groups start at multiples of 2^merge. Each bound is then on one fixed grid for that merge
  // level, and it does not depend on the first bucket of the record.
  let merge = 0;
  while ((last >> merge) - (first >> merge) + 1 > PROFILE_POINT_BUCKETS) {
    merge++;
  }

  const low = first >> merge;
  const high = last >> merge;

  // Plain arrays. The OTLP metrics serializer drops a typed array.
  const counts = Array.from({ length: high - low + 1 }, () => 0);
  for (let i = first; i <= last; i++) {
    counts[(i >> merge) - low] += buckets[base + i];
  }

  // The bound of a group is the bound of its last bucket. The division gives milliseconds.
  const bounds = Array.from(
    { length: high - low },
    (_unused, k) => upperOf(((low + k + 1) << merge) - 1) / 1000,
  );

  return { bounds, counts };
}

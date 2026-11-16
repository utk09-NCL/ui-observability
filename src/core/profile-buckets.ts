// src/core/profile-buckets.ts
//
// Maps a duration in microseconds to a bucket of the profiler's log-linear histogram. Also
// reads percentiles and builds the explicit bounds for a summary record.

import {
  PROFILE_BUCKETS,
  PROFILE_MAX_US,
  PROFILE_POINT_BUCKETS,
  PROFILE_SUB_BITS,
} from "../constants";

/** Sub-buckets per power of two. Values below this each get a bucket of their own. */
const SUB_COUNT = 1 << PROFILE_SUB_BITS;

/** Masks the sub-bucket bits of a bucket index. */
const SUB_MASK = SUB_COUNT - 1;

/**
 * Returns the bucket for a duration. Runs on the hot path, once per value.
 * @param us Duration in microseconds, a non-negative integer.
 * @returns The bucket index, 0 to 367. Anything above PROFILE_MAX_US lands in 367.
 */
export function bucketOf(us: number): number {
  // Clamp before the bit math: Math.clz32 and >>> only look at 32 bits, so a value of 2^32 or
  // more would land in the wrong bucket.
  const value = Math.min(us, PROFILE_MAX_US);

  if (value < SUB_COUNT) {
    return value;
  }

  // Math.clz32 gives us the exponent without a loop (up to 26 steps) or float math.
  // `shift` is how many low bits sit below the sub-bucket bits.
  const shift = 31 - Math.clz32(value) - PROFILE_SUB_BITS;
  return ((shift + 1) << PROFILE_SUB_BITS) | ((value >>> shift) & SUB_MASK);
}

/**
 * Returns the largest duration that still falls into a bucket.
 * @param index Bucket index, 0 to 367.
 * @returns The inclusive upper bound, in microseconds.
 */
export function upperOf(index: number): number {
  if (index < SUB_COUNT) {
    return index;
  }

  // Set all the low bits bucketOf dropped. Without them we'd return the bucket's smallest value.
  const shift = (index >>> PROFILE_SUB_BITS) - 1;
  return ((SUB_COUNT + (index & SUB_MASK)) << shift) + (1 << shift) - 1;
}

/**
 * Reads a percentile from one probe's histogram. Allocates nothing.
 * @param buckets Bucket counts for all probes.
 * @param base Index of the probe's first bucket.
 * @param count Sum of the probe's buckets. Must be above 0.
 * @param q Percentile as a fraction, e.g. 0.99.
 * @returns The upper bound of the bucket that holds the rank, in microseconds.
 */
export function percentileOf(buckets: Uint32Array, base: number, count: number, q: number): number {
  // A rank of 0 would match the first bucket even when it is empty.
  const rank = Math.max(1, Math.ceil(q * count));
  let sum = 0;

  // Walk the counts in place. Copying or sorting would make garbage on every flush.
  for (let i = 0; i < PROFILE_BUCKETS; i++) {
    sum += buckets[base + i];

    if (sum >= rank) {
      return upperOf(i);
    }
  }

  // Only reachable if the caller passed a wrong count.
  return upperOf(PROFILE_BUCKETS - 1);
}

/**
 * Builds the explicit-bounds histogram for a summary record.
 * @param buckets Bucket counts for all probes.
 * @param base Index of the probe's first bucket.
 * @returns Bounds in ms and the count per group. There is one more count than there are bounds.
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

  // The bucket at `first` isn't empty, so this loop stops there at the latest.
  let last = PROFILE_BUCKETS - 1;
  while (buckets[base + last] === 0) {
    last--;
  }

  // Groups start at multiples of 2^merge. That puts every bound on a fixed grid for the merge
  // level, whatever the record's first bucket happens to be.
  let merge = 0;
  while ((last >> merge) - (first >> merge) + 1 > PROFILE_POINT_BUCKETS) {
    merge++;
  }

  const low = first >> merge;
  const high = last >> merge;

  // Plain arrays, because the OTLP metrics serializer drops typed arrays.
  const counts = Array.from({ length: high - low + 1 }, () => 0);
  for (let i = first; i <= last; i++) {
    counts[(i >> merge) - low] += buckets[base + i];
  }

  // A group's bound is the bound of its last bucket. Dividing by 1000 gives ms.
  const bounds = Array.from(
    { length: high - low },
    (_unused, k) => upperOf(((low + k + 1) << merge) - 1) / 1000,
  );

  return { bounds, counts };
}

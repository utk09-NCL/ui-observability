// src/observability-settings/meter.ts
//
// The cost meter. It times log calls under the settings in force, with the method of
// bench/workloads.js: a warm-up, then blocks of N calls, each timed as one span, so the clock
// step is small next to the block. A call of about 2 microseconds is far below the step of
// performance.now() on a page that isn't cross-origin isolated, so no single call can be timed.

import { getLogger, type Logger } from "@utk09/ui-observability";

export type MeterLevel = "INFO" | "DEBUG";
export type MeterPayload = "order" | "blotter";

export interface MeterOptions {
  level: MeterLevel;
  payload: MeterPayload;
  /** Short text of the settings in force, for the history table. */
  summary: string;
}

export interface Spread {
  p50: number;
  p99: number;
  max: number;
}

export interface MeterResult {
  id: number;
  level: MeterLevel;
  payload: MeterPayload;
  summary: string;
  crossOriginIsolated: boolean;
  /** Smallest step of performance.now(), in microseconds. */
  clockStepUs: number;
  callsPerBlock: number;
  blocks: number;
  /** Nanoseconds for one call, from the blocks. */
  blockNs: Spread;
  /** Clock steps in the median block. */
  ticksPerBlock: number;
  /** True when a block spans fewer steps than MIN_TICKS_PER_BLOCK. */
  clockLimited: boolean;
  /** Microseconds for one call, timed one by one. It shows a stall, not the cost of a call. */
  perCallUs: { p99: number; max: number };
  totalCalls: number;
}

/** Fewest clock steps a block may span. The same value as tools/bench-release.mjs. */
export const MIN_TICKS_PER_BLOCK = 100;

/**
 * Fewest blocks that give a p99. With fewer, the p99 of the blocks is the largest block, so the
 * table prints "max of N blocks". The bench has 2,000 blocks. A run of this meter has 3 to 400.
 */
export const MIN_BLOCKS_FOR_P99 = 100;

// A block aims at twice the minimum. The pilot's cost per call is a guess, and a block that
// lands a little under the minimum would be marked clock-limited for no good reason.
const TARGET_TICKS_PER_BLOCK = MIN_TICKS_PER_BLOCK * 2;

const WARMUP_CALLS = 500;
const PILOT_CALLS = 200;
const PER_CALL_SAMPLES = 300;
// With the other calls this keeps a run at about 5,000 calls. The live buffer holds 10,000.
const BLOCK_CALL_BUDGET = 4000;
const MIN_BLOCKS = 3;
const MIN_CALLS_PER_BLOCK = 10;
const CALLS_PER_TASK = 100;
const CLOCK_EDGES = 50;
const US_PER_MS = 1000;
const NS_PER_MS = 1e6;
const NS_PER_US = 1000;
const MESSAGE = "meter call";
const BLOTTER_ROWS = 500;

let runs = 0;

/** One channel for the yields, because a new channel for each yield would add garbage. */
const channel = new MessageChannel();

/**
 * Yields to the event loop so the library's sender can run. A MessageChannel is used because a
 * nested setTimeout(0) is clamped to 4 ms, and the timer would set the pace of the run.
 * @returns Promise that resolves in the next task.
 */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Finds the smallest step of performance.now(). A time below the step reads as zero, so each
 * result carries the step.
 * @returns The step in microseconds.
 */
export function measureClockStepUs(): number {
  let smallest = Infinity;
  let last = performance.now();
  let edges = 0;
  while (edges < CLOCK_EDGES) {
    const now = performance.now();
    if (now !== last) {
      smallest = Math.min(smallest, now - last);
      last = now;
      edges += 1;
    }
  }

  return Math.round(smallest * US_PER_MS * 100) / 100;
}

/**
 * Returns one percentile by the nearest-rank rule, so each value is a real sample.
 * @param sorted Samples in ascending order.
 * @param fraction Percentile as a fraction, for example 0.99.
 * @returns The sample at that rank.
 */
export function percentile(sorted: Float64Array, fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Summarises samples as percentiles. It reports no mean, because a mean hides the tail.
 * @param samples Samples in any order.
 * @returns p50, p99 and max.
 */
export function spread(samples: Float64Array): Spread {
  const sorted = Float64Array.from(samples).sort();

  return {
    p50: round(percentile(sorted, 0.5)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

/**
 * Returns how many calls fill one block. Enough calls that the block spans the target number of
 * clock steps, but not more than the budget allows for the fewest blocks.
 * @param nsPerCall Cost of one call, from the pilot.
 * @param clockStepUs Step of the clock.
 * @returns Calls in one block.
 */
export function pickCallsPerBlock(nsPerCall: number, clockStepUs: number): number {
  const wanted = Math.ceil(
    (TARGET_TICKS_PER_BLOCK * clockStepUs * US_PER_MS) / Math.max(nsPerCall, 1),
  );
  const most = Math.floor(BLOCK_CALL_BUDGET / MIN_BLOCKS);

  return Math.min(most, Math.max(MIN_CALLS_PER_BLOCK, wanted));
}

/**
 * Builds the payload of a call. A blotter snapshot has more rows than the default limit of
 * limits.maxArrayLength, so a lower limit shows in the cost.
 * @param kind The payload to build.
 * @returns A payload object. The meter builds it once, before it times anything.
 */
export function buildPayload(kind: MeterPayload): Record<string, unknown> {
  if (kind === "order") {
    return { orderId: "ORD-1042", pair: "EURUSD", side: "BUY", qty: 250, price: 1.0852 };
  }

  const rows = Array.from({ length: BLOTTER_ROWS }, (_, index) => ({
    id: `ORD-${String(1000 + index)}`,
    pair: "EURUSD",
    side: index % 2 === 0 ? "BUY" : "SELL",
    qty: 100 + index,
    status: "filled",
    price: 1.085 + index / 100000,
  }));

  return { snapshot: rows };
}

/** Makes the function that writes one call at the chosen level. */
function writerFor(log: Logger, level: MeterLevel, payload: Record<string, unknown>): () => void {
  if (level === "DEBUG") {
    return () => {
      log.debug(MESSAGE, payload);
    };
  }

  return () => {
    log.info(MESSAGE, payload);
  };
}

async function runCalls(write: () => void, calls: number): Promise<void> {
  let remaining = calls;
  while (remaining > 0) {
    const inThisTask = Math.min(remaining, CALLS_PER_TASK);
    for (let call = 0; call < inThisTask; call += 1) {
      write();
    }
    remaining -= inThisTask;
    await nextTask();
  }
}

/**
 * Prints the p99 column of a result. Below MIN_BLOCKS_FOR_P99 blocks the p99 is the largest
 * block, and the column says so.
 * @param result One meter result.
 * @returns Text for the table cell.
 */
export function p99Cell(result: Pick<MeterResult, "blocks" | "blockNs">): string {
  if (result.blocks >= MIN_BLOCKS_FOR_P99) {
    return String(Math.round(result.blockNs.p99));
  }

  return `max of ${String(result.blocks)} blocks`;
}

/**
 * Times log calls under the settings in force. The calls are real records in the namespace
 * observability.meter, so they reach the backend.
 * @param options Level, payload and the text of the settings.
 * @returns The result of one run.
 */
export async function runMeter(options: MeterOptions): Promise<MeterResult> {
  const write = writerFor(
    getLogger("observability.meter"),
    options.level,
    buildPayload(options.payload),
  );
  const clockStepUs = measureClockStepUs();

  await runCalls(write, WARMUP_CALLS);

  const pilotStart = performance.now();
  for (let call = 0; call < PILOT_CALLS; call += 1) {
    write();
  }
  const nsPerCall = ((performance.now() - pilotStart) * NS_PER_MS) / PILOT_CALLS;
  await nextTask();

  // Both sample arrays exist before the first timed call, so the timing allocates nothing.
  const callsPerBlock = pickCallsPerBlock(nsPerCall, clockStepUs);
  const blocks = Math.max(MIN_BLOCKS, Math.floor(BLOCK_CALL_BUDGET / callsPerBlock));
  const perCallUs = new Float64Array(PER_CALL_SAMPLES);
  const blockNs = new Float64Array(blocks);

  let timed = 0;
  while (timed < PER_CALL_SAMPLES) {
    const end = Math.min(PER_CALL_SAMPLES, timed + CALLS_PER_TASK);
    while (timed < end) {
      const before = performance.now();
      write();
      perCallUs[timed] = (performance.now() - before) * US_PER_MS;
      timed += 1;
    }
    await nextTask();
  }

  for (let block = 0; block < blocks; block += 1) {
    const before = performance.now();
    for (let call = 0; call < callsPerBlock; call += 1) {
      write();
    }
    blockNs[block] = ((performance.now() - before) * NS_PER_MS) / callsPerBlock;
    await nextTask();
  }

  const blockSpread = spread(blockNs);
  const perCallSpread = spread(perCallUs);
  const ticksPerBlock = Math.round((blockSpread.p50 * callsPerBlock) / NS_PER_US / clockStepUs);
  runs += 1;

  return {
    id: runs,
    level: options.level,
    payload: options.payload,
    summary: options.summary,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    clockStepUs,
    callsPerBlock,
    blocks,
    blockNs: blockSpread,
    ticksPerBlock,
    clockLimited: ticksPerBlock < MIN_TICKS_PER_BLOCK,
    perCallUs: { p99: perCallSpread.p99, max: perCallSpread.max },
    totalCalls: WARMUP_CALLS + PILOT_CALLS + PER_CALL_SAMPLES + blocks * callsPerBlock,
  };
}

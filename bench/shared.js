// bench/shared.js
//
// Helpers that both benchmark pages use: the fixed log call, the yield to the event loop, the
// percentile summary and the library setup with the memory transport.

/* global MessageChannel, performance, setTimeout */

import { configure, createMemoryTransport, flush, info } from "../src/index";

export const US_PER_MS = 1000;
export const MS_PER_SECOND = 1000;
export const NS_PER_MS = 1e6;
export const NS_PER_US = 1000;

/** Every log call in every workload sends this message and this payload. */
export const MESSAGE = "order accepted";
export const PAYLOAD = { orderId: "ORD-1042", side: "BUY", qty: 250, px: 101.25 };

/** How many clock edges the tick search waits for. */
const TICK_EDGES = 50;

/** Lost records and diagnostics, so a run that lost data can't pass as a clean one. */
export const losses = { dropped: 0, dropReasons: [], diagnostics: [] };

/**
 * Adds one onDrop report to the losses.
 * @param summary The library's drop summary.
 */
export function noteDrop(summary) {
  losses.dropped += summary.records;

  if (!losses.dropReasons.includes(summary.reason)) {
    losses.dropReasons.push(summary.reason);
  }
}

/**
 * Adds one diagnostic to the losses. Each distinct text is kept one time.
 * @param event The library's diagnostic event.
 */
export function noteDiagnostic(event) {
  const text = `${event.code}: ${event.message}`;

  if (!losses.diagnostics.includes(text)) {
    losses.diagnostics.push(text);
  }
}

/** One channel for nextTask, because a new channel per yield would add garbage to the run. */
const channel = new MessageChannel();

/**
 * Yields to the event loop so the library's sender can run. A MessageChannel is used because
 * nested setTimeout(0) calls are clamped to 4 ms, and the timer would then set the pace.
 * @returns Promise that resolves in the next task.
 */
export function nextTask() {
  return new Promise((resolve) => {
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(null);
  });
}

/**
 * Waits for a fixed time.
 * @param ms Time to wait, in milliseconds.
 * @returns Promise that resolves after the wait.
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Returns one percentile by the nearest-rank rule, so every reported value is a real sample.
 * @param sorted Samples in ascending order.
 * @param fraction Percentile as a fraction, for example 0.99.
 * @returns The sample at that rank.
 */
function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

/**
 * Summarises samples as percentiles. It reports no mean, because a mean hides the tail.
 * @param samples Unsorted samples.
 * @returns p50, p99, p99.9 and max, rounded to 2 decimals.
 */
export function spread(samples) {
  const sorted = Float64Array.from(samples).sort();
  const round = (value) => Math.round(value * 100) / 100;

  return {
    p50: round(percentile(sorted, 0.5)),
    p99: round(percentile(sorted, 0.99)),
    p999: round(percentile(sorted, 0.999)),
    max: round(sorted[sorted.length - 1]),
  };
}

/**
 * Finds the smallest step of performance.now(). A latency below this step reads as zero, so
 * the result has to carry it.
 * @returns The clock's step in microseconds.
 */
export function clockTickUs() {
  let smallest = Infinity;
  let last = performance.now();

  for (let edges = 0; edges < TICK_EDGES;) {
    const now = performance.now();

    if (now !== last) {
      smallest = Math.min(smallest, now - last);
      last = now;
      edges++;
    }
  }

  return Math.round(smallest * US_PER_MS * 100) / 100;
}

/**
 * Sends one record and waits for it. The library loads its sender on the first record and holds
 * only a few records until then, so a workload that starts earlier loses records at boot.
 * @returns Promise that resolves when the sender has run one time.
 */
export async function loadSender() {
  info(MESSAGE, PAYLOAD);
  await flush();
}

/**
 * Configures the library with the memory transport and no browser storage, so the network and
 * IndexedDB add no noise. The bus is off because each workload has one page.
 * @param extra Config keys a workload adds.
 * @returns The memory transport, emptied after the sender's first batch.
 */
export async function startInMemory(extra = {}) {
  const memory = createMemoryTransport();

  configure({
    serviceName: "bench",
    transport: memory.transport,
    storage: "memory",
    identity: "memory",
    bus: { mode: "off" },
    onDrop: noteDrop,
    onDiagnostic: noteDiagnostic,
    ...extra,
  });

  await loadSender();
  memory.clear();

  return memory;
}

/**
 * Counts the records the memory transport holds, then empties it. A workload calls this after
 * every task, otherwise the transport keeps every record alive and the run measures the GC's
 * work on that pile instead of the library.
 * @param memory The memory transport.
 * @returns Records the transport accepted since the last call.
 */
export function takeAccepted(memory) {
  const count = memory.records().length;
  memory.clear();

  return count;
}

/**
 * Logs a number of records in tasks of a fixed size, and yields between the tasks.
 * @param calls Total info() calls.
 * @param callsPerTask Calls before each yield.
 * @param memory The memory transport to count and empty after each task, or null when the
 *   workload sends over HTTP.
 * @returns Records the memory transport accepted so far. The caller's flush() delivers the rest.
 */
export async function logInTasks(calls, callsPerTask, memory) {
  let accepted = 0;

  for (let done = 0; done < calls;) {
    const end = Math.min(calls, done + callsPerTask);

    for (; done < end; done++) {
      info(MESSAGE, PAYLOAD);
    }

    await nextTask();

    if (memory !== null) {
      accepted += takeAccepted(memory);
    }
  }

  return accepted;
}

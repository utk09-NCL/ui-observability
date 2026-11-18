// bench/workloads.js
//
// The workloads that tools/bench-release.mjs runs in the browser. Each one configures the
// library, applies a fixed load and returns plain numbers. The Node script opens a fresh page
// for every workload, so one workload's buffers and JIT state can't change the next one's result.

/* global crossOriginIsolated, performance, window */

import { configure, flush, getHealth, info } from "../src/index";
import {
  MESSAGE,
  MS_PER_SECOND,
  NS_PER_MS,
  NS_PER_US,
  PAYLOAD,
  US_PER_MS,
  clockTickUs,
  loadSender,
  logInTasks,
  losses,
  nextTask,
  noteDiagnostic,
  noteDrop,
  sleep,
  spread,
  startInMemory,
  takeAccepted,
} from "./shared.js";

/**
 * Times info() two ways after a warm-up. The first pass times every call. One call is shorter
 * than one clock step, so that pass only shows a call that stalls, for example on a GC pause.
 * The second pass times blocks of calls, and a block is long enough for the clock to resolve
 * the cost of a call. Both sample arrays exist before the first call, so the measurement itself
 * allocates nothing.
 * @param params warmupCalls, perCallCalls, callsPerTask, blocks and callsPerBlock.
 * @returns Percentiles of one call in microseconds and of one block in nanoseconds per call.
 */
async function latency({ warmupCalls, perCallCalls, callsPerTask, blocks, callsPerBlock }) {
  const memory = await startInMemory();
  const perCallUs = new Float64Array(perCallCalls);
  const blockNsPerCall = new Float64Array(blocks);
  let accepted = await logInTasks(warmupCalls, callsPerTask, memory);

  for (let done = 0; done < perCallCalls;) {
    const end = Math.min(perCallCalls, done + callsPerTask);

    for (; done < end; done++) {
      const before = performance.now();
      info(MESSAGE, PAYLOAD);
      perCallUs[done] = (performance.now() - before) * US_PER_MS;
    }

    await nextTask();
    accepted += takeAccepted(memory);
  }

  for (let block = 0; block < blocks; block++) {
    const before = performance.now();

    for (let call = 0; call < callsPerBlock; call++) {
      info(MESSAGE, PAYLOAD);
    }

    blockNsPerCall[block] = ((performance.now() - before) * NS_PER_MS) / callsPerBlock;
    await nextTask();
    accepted += takeAccepted(memory);
  }

  await flush();
  accepted += takeAccepted(memory);

  const tickUs = clockTickUs();
  const blockSpread = spread(blockNsPerCall);

  return {
    crossOriginIsolated,
    clockTickUs: tickUs,
    perCallUs: spread(perCallUs),
    blockNsPerCall: blockSpread,
    // Clock steps in the median block. The Node script fails the run when this is too low.
    ticksPerBlock: Math.round((blockSpread.p50 * callsPerBlock) / NS_PER_US / tickUs),
    offered: warmupCalls + perCallCalls + blocks * callsPerBlock,
    accepted,
    ...losses,
  };
}

/**
 * Logs as fast as the page can for a fixed time, then counts what the transport accepted.
 * @param params durationMs and callsPerTask.
 * @returns Offered and accepted records, and accepted records per second.
 */
async function throughput({ durationMs, callsPerTask }) {
  const memory = await startInMemory();
  const start = performance.now();
  let offered = 0;
  let accepted = 0;

  while (performance.now() - start < durationMs) {
    accepted += await logInTasks(callsPerTask, callsPerTask, memory);
    offered += callsPerTask;
  }

  await flush();
  accepted += takeAccepted(memory);

  const elapsedMs = performance.now() - start;

  return {
    offered,
    accepted,
    elapsedMs: Math.round(elapsedMs),
    acceptedPerSecond: Math.round((accepted / elapsedMs) * MS_PER_SECOND),
    ...losses,
  };
}

/** The memory transport of the heap workload. heapRun needs the one heapWarmUp configured. */
let heapMemory = null;

/**
 * Configures the library and sends a first set of records. The Node script takes its first
 * heap read after this, so the library's lazy modules are already loaded. The heap still grows
 * by a fixed amount over the next 130,000 records, which the script reports as the fixed part.
 * @param params warmupCalls and callsPerTick.
 */
async function heapWarmUp({ warmupCalls, callsPerTick }) {
  heapMemory = await startInMemory();
  await logInTasks(warmupCalls, callsPerTick, heapMemory);
  await flush();
  heapMemory.clear();
}

/**
 * Logs one checkpoint's records at a steady pace. The Node script reads the heap after each
 * call, so the records per call are fixed and every run has its checkpoints at the same counts.
 * @param params callsPerCheckpoint, tickMs and callsPerTick.
 * @returns Offered and accepted records of this checkpoint, and the losses since the page loaded.
 */
async function heapRun({ callsPerCheckpoint, tickMs, callsPerTick }) {
  let accepted = 0;

  for (let offered = 0; offered < callsPerCheckpoint; offered += callsPerTick) {
    accepted += await logInTasks(callsPerTick, callsPerTick, heapMemory);
    await sleep(tickMs);
  }

  await flush();
  accepted += takeAccepted(heapMemory);

  return { offered: callsPerCheckpoint, accepted, ...losses };
}

/**
 * Configures the library against a real HTTP endpoint and logs a fixed number of records. The
 * Node script holds the endpoint in an outage, so the batches go to storage.
 * @param params endpoint, records, callsPerTask and the delivery settings.
 */
async function outageLog({ endpoint, records, callsPerTask, delivery }) {
  configure({
    serviceName: "bench",
    endpoint,
    // The server counts records, and it reads plain JSON only.
    compression: "none",
    identity: "memory",
    // An outage must not use up a batch's attempts, or the count after recovery is short.
    retention: { maxAgeMs: null, maxAttempts: null },
    delivery,
    bus: { mode: "off" },
    onDrop: noteDrop,
    onDiagnostic: noteDiagnostic,
  });

  await loadSender();
  // No memory transport here. The Node script's server counts the delivered records.
  await logInTasks(records - 1, callsPerTask, null);
}

/**
 * Returns the delivery state with the losses. The Node script polls it to see the drain end.
 * @returns pending, inFlight and stored counts, the dropped count and the diagnostic codes.
 */
async function deliveryState() {
  return { ...(await getHealth()).delivery, ...losses };
}

window.bench = { latency, throughput, heapWarmUp, heapRun, outageLog, deliveryState };

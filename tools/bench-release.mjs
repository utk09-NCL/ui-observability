// tools/bench-release.mjs
//
// The release benchmark. It serves the library source with Vite, runs the workloads of bench/ in
// Chromium, writes the raw result to bench-results/ and compares each metric with
// bench/budgets.json. It exits 1 when a metric is over its budget, a budget has no measured
// metric, or a workload lost data.
// Run:  pnpm run bench:release

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer as createViteServer } from "vite";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RESULTS_DIR = fileURLToPath(new URL("../bench-results/", import.meta.url));
const BUDGETS_FILE = fileURLToPath(new URL("../bench/budgets.json", import.meta.url));
const REPLAY_PEER = fileURLToPath(new URL("../node_modules/@rrweb/record", import.meta.url));

// Both servers bind to this address and the page uses it in its URLs. With "localhost" a
// second program on the same port can take the IPv4 traffic and the run then measures nothing.
const HOST = "127.0.0.1";
const PAGE_PORT = 5201;
const INGEST_PORT = 8801;
const PAGE_ORIGIN = `http://${HOST}:${PAGE_PORT}`;
const INGEST_URL = `http://${HOST}:${INGEST_PORT}/v1/logs`;

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** How often the outage workload asks the page for its delivery state, in ms. */
const POLL_MS = 20;

/** The outage workload gives up when the drain takes longer than this, in ms. */
const DRAIN_LIMIT_MS = 30_000;

const BYTES_PER_GIB = 1024 ** 3;

/**
 * Fewest clock steps a latency block may span. Chromium adds jitter of about one step to every
 * read, so a shorter block reports the clock and not the call.
 */
const MIN_TICKS_PER_BLOCK = 100;

/** The heap slope is reported for this many records, because one record's share is below a byte. */
const SLOPE_RECORDS = 10_000;

/** The load of every workload. A result is comparable only with a result of the same load. */
const WORKLOAD = {
  latency: {
    warmupCalls: 20_000,
    perCallCalls: 100_000,
    callsPerTask: 100,
    blocks: 2_000,
    callsPerBlock: 500,
  },
  throughput: { durationMs: 5_000, callsPerTask: 500 },
  // The heap grows by a fixed amount over the first 130,000 records and is flat after that, so
  // the first 15 checkpoints only let it settle and the slope comes from the last 15.
  heap: {
    warmupCalls: 5_000,
    settleCheckpoints: 15,
    fitCheckpoints: 15,
    callsPerCheckpoint: 10_000,
    tickMs: 1,
    callsPerTick: 50,
  },
  outage: {
    records: 2_000,
    callsPerTask: 100,
    outageMs: 3_000,
    delivery: { retryBaseDelayMs: 200, retryMaxDelayMs: 1_000, retryIdleDelayMs: 1_000 },
  },
  // The buffer limit is above the default, so the recorder keeps every event of the run.
  replay: { warmupRounds: 200, rounds: 2_000, changesPerRound: 20, maxBufferBytes: 100_000_000 },
};

/** Metrics of this run. One entry is { id, value, unit } and an optional note. */
const metrics = [];

/** Reasons the run fails besides a budget, for example a workload that lost records. */
const problems = [];

/**
 * Calls one function of the page's `bench` object and returns its result.
 * @param page Playwright page.
 * @param name Function name.
 * @param params The function's one argument.
 * @returns The function's result.
 */
function runInPage(page, name, params) {
  return page.evaluate(([fn, arg]) => globalThis.bench[fn](arg), [name, params]);
}

/**
 * Opens a fixture page in a new browser context, so storage and JIT state start empty.
 * @param browser Playwright browser.
 * @param file Fixture page under bench/.
 * @returns The page. Close its context when the workload ends.
 */
async function openFixture(browser, file) {
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("pageerror", (error) => {
    problems.push(`${file} threw an error: ${error.message}`);
  });
  await page.goto(`${PAGE_ORIGIN}/bench/${file}`);
  await page.waitForFunction(() => globalThis.bench !== undefined);

  return page;
}

/**
 * Records a problem when a workload lost records or the library reported a diagnostic. A run
 * with a loss measured a different code path, so its numbers can't be compared with a baseline.
 * @param name Workload name.
 * @param result Workload result with `dropped` and `diagnostics`.
 */
function checkLosses(name, result) {
  if (result.dropped > 0) {
    problems.push(`${name} lost ${result.dropped} records (${result.dropReasons.join(", ")}).`);
  }

  for (const diagnostic of result.diagnostics) {
    problems.push(`${name} got a diagnostic. ${diagnostic}`);
  }
}

/**
 * Records a problem when the memory transport's count differs from the calls. The page empties
 * the transport after every task, so a record that is counted twice or never would show up here.
 * @param name Workload name.
 * @param result Workload result with `offered` and `accepted`.
 */
function checkCounts(name, result) {
  if (result.accepted !== result.offered) {
    problems.push(`${name} logged ${result.offered} records and counted ${result.accepted}.`);
  }
}

/**
 * Measures the time of one info() call.
 * @param browser Playwright browser.
 * @returns The page's result.
 */
async function runLatency(browser) {
  const page = await openFixture(browser, "index.html");
  const result = await runInPage(page, "latency", WORKLOAD.latency);
  await page.context().close();

  checkLosses("latency", result);
  checkCounts("latency", result);

  if (result.ticksPerBlock < MIN_TICKS_PER_BLOCK) {
    problems.push(
      `latency blocks span ${result.ticksPerBlock} clock steps of ${result.clockTickUs} us. ` +
        `They need ${MIN_TICKS_PER_BLOCK}, so raise callsPerBlock.`,
    );
  }

  // One call is shorter than one clock step, so these three only ever read 0, 5 or 10 us.
  const clockLimited = "clock-limited";

  metrics.push(
    { id: "latency.blockP50Ns", value: result.blockNsPerCall.p50, unit: "ns/call" },
    { id: "latency.blockP99Ns", value: result.blockNsPerCall.p99, unit: "ns/call" },
    { id: "latency.blockP999Ns", value: result.blockNsPerCall.p999, unit: "ns/call" },
    { id: "latency.p50Us", value: result.perCallUs.p50, unit: "us", note: clockLimited },
    { id: "latency.p99Us", value: result.perCallUs.p99, unit: "us", note: clockLimited },
    { id: "latency.p999Us", value: result.perCallUs.p999, unit: "us", note: clockLimited },
    { id: "latency.slowestCallUs", value: result.perCallUs.max, unit: "us" },
  );

  return result;
}

/**
 * Measures the records per second that the memory transport accepts under a full load.
 * @param browser Playwright browser.
 * @returns The page's result.
 */
async function runThroughput(browser) {
  const page = await openFixture(browser, "index.html");
  const result = await runInPage(page, "throughput", WORKLOAD.throughput);
  await page.context().close();

  checkLosses("throughput", result);
  checkCounts("throughput", result);
  metrics.push({
    id: "throughput.acceptedPerSecond",
    value: result.acceptedPerSecond,
    unit: "records/s",
  });

  return result;
}

/**
 * Forces a garbage collection, then reads the used JS heap. Without the collection the number
 * includes garbage that is only waiting for the next GC.
 * @param cdp CDP session of the page.
 * @returns Used JS heap in bytes.
 */
async function usedHeapAfterGc(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics: cdpMetrics } = await cdp.send("Performance.getMetrics");

  return cdpMetrics.find((metric) => metric.name === "JSHeapUsedSize").value;
}

/**
 * Fits a straight line through points by least squares.
 * @param points One point is { x, y }.
 * @returns The line's slope, and its y value at x = 0.
 */
function fitLine(points) {
  let sumX = 0;
  let sumY = 0;

  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }

  const meanX = sumX / points.length;
  const meanY = sumY / points.length;
  let covariance = 0;
  let varianceX = 0;

  for (const point of points) {
    covariance += (point.x - meanX) * (point.y - meanY);
    varianceX += (point.x - meanX) ** 2;
  }

  const slope = covariance / varianceX;

  return { slope, intercept: meanY - slope * meanX };
}

/**
 * Measures how the JS heap grows with the number of records. The heap is read after the
 * warm-up and after each checkpoint. A line through the reads after the settle checkpoints
 * splits the growth into a slope, which is what a leak adds per record, and a fixed part,
 * which is one-time growth that stops.
 * @param browser Playwright browser.
 * @returns The heap reads, the fitted slope and fixed part, and the record counts.
 */
async function runHeap(browser) {
  const page = await openFixture(browser, "index.html");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  await runInPage(page, "heapWarmUp", WORKLOAD.heap);
  const startBytes = await usedHeapAfterGc(cdp);
  const { settleCheckpoints, fitCheckpoints } = WORKLOAD.heap;
  const reads = [];
  let offered = 0;
  let accepted = 0;
  let run = null;

  for (let checkpoint = 0; checkpoint < settleCheckpoints + fitCheckpoints; checkpoint++) {
    run = await runInPage(page, "heapRun", WORKLOAD.heap);
    offered += run.offered;
    accepted += run.accepted;
    reads.push({ records: accepted, heapBytes: await usedHeapAfterGc(cdp) });
  }

  await page.context().close();

  // The settle reads stay out of the fit, because the one-time growth in them would look like
  // a slope. The line's value at 0 records is then the heap without any per-record growth.
  const settled = reads.slice(settleCheckpoints);
  const line = fitLine(settled.map((read) => ({ x: read.records, y: read.heapBytes })));

  const result = {
    startBytes,
    reads,
    slopeBytesPer10k: Math.round(line.slope * SLOPE_RECORDS),
    fixedBytes: Math.round(line.intercept - startBytes),
    growthBytes: reads[reads.length - 1].heapBytes - startBytes,
    offered,
    accepted,
    // The page counts its losses from the page load, so the last checkpoint has all of them.
    dropped: run.dropped,
    dropReasons: run.dropReasons,
    diagnostics: run.diagnostics,
  };

  checkLosses("heap", result);
  checkCounts("heap", result);
  metrics.push(
    { id: "heap.slopeBytesPer10k", value: result.slopeBytesPer10k, unit: "bytes/10k" },
    { id: "heap.fixedBytes", value: result.fixedBytes, unit: "bytes" },
  );

  return result;
}

/**
 * Counts the log records in one OTLP JSON body.
 * @param body Request body.
 * @returns Number of log records.
 */
function countLogRecords(body) {
  let count = 0;

  for (const resource of JSON.parse(body).resourceLogs ?? []) {
    for (const scope of resource.scopeLogs ?? []) {
      count += scope.logRecords?.length ?? 0;
    }
  }

  return count;
}

/**
 * Starts an ingest server that answers 503 until `state.healthy` is true.
 * @returns The server and its state.
 * @throws When the port is taken, because the page would then talk to the other program.
 */
async function startIngest() {
  const state = {
    healthy: false,
    refusedRequests: 0,
    acceptedRecords: 0,
    firstAcceptedAt: 0,
    lastAcceptedAt: 0,
  };

  const server = createHttpServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", PAGE_ORIGIN);
    response.setHeader(
      "Access-Control-Allow-Headers",
      request.headers["access-control-request-headers"] ?? "",
    );
    response.setHeader("Access-Control-Max-Age", "600");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!state.healthy) {
        state.refusedRequests++;
        response.writeHead(503).end();
        return;
      }

      state.acceptedRecords += countLogRecords(Buffer.concat(chunks).toString("utf8"));
      state.lastAcceptedAt = performance.now();

      if (state.firstAcceptedAt === 0) {
        state.firstAcceptedAt = state.lastAcceptedAt;
      }

      response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });

  try {
    server.listen(INGEST_PORT, HOST);
    // once() rejects when the server emits "error" before "listening".
    await once(server, "listening");
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new Error(
        `Port ${INGEST_PORT} on ${HOST} is in use, so the outage workload has no server. ` +
          "Stop the other program and run the benchmark again.",
        { cause: error },
      );
    }

    throw error;
  }

  return { server, state };
}

/**
 * Measures the time from the server's recovery to the last stored batch it accepts. The page
 * logs into an outage first, so every batch is in storage when the server recovers.
 * @param browser Playwright browser.
 * @returns The drain time and the record counts.
 */
async function runOutage(browser) {
  const { records, outageMs } = WORKLOAD.outage;
  const { server, state } = await startIngest();
  const page = await openFixture(browser, "index.html");

  await runInPage(page, "outageLog", { endpoint: INGEST_URL, ...WORKLOAD.outage });
  await sleep(outageMs);

  const atRecovery = await runInPage(page, "deliveryState");
  const recoveredAt = performance.now();
  state.healthy = true;

  let delivery = atRecovery;
  let drained = false;

  while (!drained && performance.now() - recoveredAt < DRAIN_LIMIT_MS) {
    await sleep(POLL_MS);
    delivery = await runInPage(page, "deliveryState");
    drained =
      state.acceptedRecords >= records &&
      delivery.stored === 0 &&
      delivery.pending === 0 &&
      delivery.inFlight === 0;
  }

  await page.context().close();
  server.close();

  const result = {
    recoveryToDrainMs: Math.round(state.lastAcceptedAt - recoveredAt),
    // The retry timer has full jitter, so this part is random up to delivery.retryMaxDelayMs.
    recoveryToFirstSendMs: Math.round(state.firstAcceptedAt - recoveredAt),
    // First accepted batch to last accepted batch. The engine sends 20 batches per pass, so
    // 21 stored batches need a second pass, and a setTimeout(0) sits between the two.
    drainMs: Math.round(state.lastAcceptedAt - state.firstAcceptedAt),
    storedBatchesAtRecovery: atRecovery.stored,
    refusedRequests: state.refusedRequests,
    loggedRecords: records,
    deliveredRecords: state.acceptedRecords,
    dropped: delivery.dropped,
    dropReasons: delivery.dropReasons,
    // The library reports each failed send, so diagnostics are normal in this workload.
    diagnostics: delivery.diagnostics,
  };

  if (!drained) {
    problems.push(`outage did not drain in ${DRAIN_LIMIT_MS} ms.`);
  }

  if (result.dropped > 0) {
    problems.push(`outage lost ${result.dropped} records (${result.dropReasons.join(", ")}).`);
  }

  metrics.push(
    { id: "outage.recoveryToDrainMs", value: result.recoveryToDrainMs, unit: "ms" },
    { id: "outage.drainMs", value: result.drainMs, unit: "ms" },
  );

  return result;
}

/**
 * Measures a round of DOM changes with the replay recorder off, then on.
 * @param browser Playwright browser.
 * @returns Both results and the difference, or a note when the recorder isn't installed.
 */
async function runReplay(browser) {
  if (!existsSync(REPLAY_PEER)) {
    return { skipped: "@rrweb/record is not installed." };
  }

  const results = {};

  for (const replayOn of [false, true]) {
    const page = await openFixture(browser, "replay.html");
    const result = await runInPage(page, "replay", { replayOn, ...WORKLOAD.replay });
    await page.context().close();

    checkLosses(`replay ${replayOn ? "on" : "off"}`, result);
    results[replayOn ? "on" : "off"] = result;
  }

  if (results.on.replayEvents === 0) {
    problems.push("replay sent no recorder events, so the recorder did not run.");
  }

  const round = (value) => Math.round(value * 100) / 100;

  metrics.push(
    { id: "replay.offP50Us", value: results.off.perRoundUs.p50, unit: "us" },
    { id: "replay.onP50Us", value: results.on.perRoundUs.p50, unit: "us" },
    { id: "replay.onP99Us", value: results.on.perRoundUs.p99, unit: "us" },
    { id: "replay.onP999Us", value: results.on.perRoundUs.p999, unit: "us" },
    {
      id: "replay.overheadP50Us",
      value: round(results.on.perRoundUs.p50 - results.off.perRoundUs.p50),
      unit: "us",
    },
  );

  return results;
}

/**
 * Describes the machine and the software, because a result means nothing without them.
 * @param browser Playwright browser.
 * @returns Hardware, operating system, browser, Node and library versions.
 */
function describeEnvironment(browser) {
  return {
    cpuModel: os.cpus()[0].model,
    cpuCores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / BYTES_PER_GIB),
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    browser: `chromium ${browser.version()} (headless)`,
    node: process.version,
    library: `${pkg.name} ${pkg.version}`,
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(),
    libraryBuild: "source served by the Vite dev server, not minified",
  };
}

/**
 * Compares every metric with its budget. A budget is { max } or { min }.
 * @param budgets The `budgets` object of bench/budgets.json.
 * @returns One verdict for each metric and each budget: "ok", "over budget", "no budget" or
 *   "no result".
 */
function checkBudgets(budgets) {
  const verdicts = metrics.map((metric) => {
    const budget = budgets[metric.id];
    let verdict = "no budget";

    if (budget?.max !== undefined) {
      verdict = metric.value <= budget.max ? "ok" : "over budget";
    }

    if (budget?.min !== undefined) {
      verdict = metric.value >= budget.min ? "ok" : "over budget";
    }

    return { ...metric, budget: budget ?? null, verdict };
  });

  // A budget without a metric fails the run, otherwise a skipped workload or a renamed metric
  // would pass the gate with nothing measured.
  for (const [id, budget] of Object.entries(budgets)) {
    const measured = metrics.some((metric) => metric.id === id);

    if (!measured) {
      verdicts.push({ id, value: null, unit: "", budget, verdict: "no result" });
    }
  }

  return verdicts;
}

/**
 * Prints one line for each verdict.
 * @param verdicts Result of checkBudgets.
 */
function printVerdicts(verdicts) {
  for (const { id, value, unit, note, budget, verdict } of verdicts) {
    let limit = "";

    if (budget?.max !== undefined) {
      limit = `(max ${budget.max})`;
    }

    if (budget?.min !== undefined) {
      limit = `(min ${budget.min})`;
    }

    const shown = value === null ? "-" : String(value);
    const columns = `${id.padEnd(30)} ${shown.padStart(8)} ${unit.padEnd(10)}`;

    console.log(`bench: ${columns} ${verdict} ${limit} ${note ?? ""}`.trimEnd());
  }
}

const startedAt = new Date();
// The 1 minute load average. A busy machine makes every number worse, so the result carries it.
const loadAverageAtStart = os.loadavg()[0];

mkdirSync(RESULTS_DIR, { recursive: true });

const vite = await createViteServer({
  root: ROOT,
  // The root vite.config.ts is the library build. This server only has to serve the source.
  configFile: false,
  logLevel: "error",
  define: { __UIOBS_VERSION__: JSON.stringify(pkg.version) },
  // The dependency cache stays out of node_modules, which other tools share.
  cacheDir: `${RESULTS_DIR}.vite`,
  optimizeDeps: { include: existsSync(REPLAY_PEER) ? ["@rrweb/record"] : [] },
  server: {
    host: HOST,
    port: PAGE_PORT,
    strictPort: true,
    hmr: false,
    // These two headers make the page cross-origin isolated. Chromium then gives
    // performance.now() a 5 microsecond step instead of 100.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});

await vite.listen();

const browser = await chromium.launch();
const results = {};

try {
  results.latency = await runLatency(browser);
  results.throughput = await runThroughput(browser);
  results.heap = await runHeap(browser);
  results.outage = await runOutage(browser);
  results.replay = await runReplay(browser);
} catch (error) {
  problems.push(`The benchmark stopped: ${error instanceof Error ? error.message : String(error)}`);
}

const environment = {
  ...describeEnvironment(browser),
  loadAverage1m: {
    atStart: Math.round(loadAverageAtStart * 100) / 100,
    atEnd: Math.round(os.loadavg()[0] * 100) / 100,
  },
};

await browser.close();
await vite.close();

const budgetFile = existsSync(BUDGETS_FILE) ? JSON.parse(readFileSync(BUDGETS_FILE, "utf8")) : null;

// Without budgets every metric reads "no budget", so the gate would pass and check nothing.
if (budgetFile === null) {
  problems.push("bench/budgets.json does not exist, so the release gate has nothing to check.");
}

const verdicts = checkBudgets(budgetFile?.budgets ?? {});
const overBudget = verdicts.filter((entry) => entry.verdict === "over budget");
const noResult = verdicts.filter((entry) => entry.verdict === "no result");
const durationSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);

const report = {
  startedAt: startedAt.toISOString(),
  durationSeconds,
  environment,
  workload: WORKLOAD,
  results,
  metrics: verdicts,
  problems,
};

const reportFile = `${RESULTS_DIR}bench-${startedAt.toISOString().replaceAll(":", "-")}.json`;
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `bench: ${environment.cpuModel}, ${environment.cpuCores} cores, ${environment.memoryGiB} GiB`,
);
console.log(
  `bench: ${environment.browser}, node ${environment.node}, commit ${environment.commit}`,
);
const { atStart, atEnd } = environment.loadAverage1m;
console.log(`bench: load average ${atStart} at the start, ${atEnd} at the end`);
printVerdicts(verdicts);

if (results.replay?.skipped !== undefined) {
  console.log(`bench: the replay workload did not run. ${results.replay.skipped}`);
}

if (budgetFile !== null && budgetFile.machine?.cpuModel !== environment.cpuModel) {
  console.log(
    `bench: the budgets come from "${budgetFile.machine?.cpuModel}". ` +
      "The same budgets apply here. Report a failure on this machine to the maintainer.",
  );
}

for (const problem of problems) {
  console.error(`bench: ${problem}`);
}

console.log(`bench: ${durationSeconds} s, raw result in ${reportFile}`);

if (overBudget.length > 0 || noResult.length > 0 || problems.length > 0) {
  console.error(
    `bench: FAILED. ${overBudget.length} over budget, ` +
      `${noResult.length} budgets with no result, ${problems.length} problems.`,
  );
  process.exit(1);
}

console.log("bench: passed.");

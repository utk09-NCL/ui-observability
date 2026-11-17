// tools/check-collector.mjs
//
// Fails if a real OpenTelemetry Collector doesn't accept the library's OTLP output. It starts a
// pinned otelcol-contrib, serves the fixture page in e2e/collector with Vite, lets Chromium send
// logs, metrics and spans from the library source, and reads what the collector's file exporter
// wrote. A mock server can't prove this, because the mock accepts whatever the library sends.
//
// Run: pnpm run test:collector

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, mkdtempSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

/** The pinned collector release. Change it together with each hash in PLATFORMS. */
const COLLECTOR_VERSION = "0.164.0";

/** The repository that publishes the collector's releases. */
const RELEASES_REPO = "https://github.com/open-telemetry/opentelemetry-collector-releases";

/** Where the pinned release's files are. */
const RELEASE_URL = `${RELEASES_REPO}/releases/download/v${COLLECTOR_VERSION}`;

/**
 * One row for each platform the check runs on. The key is `${process.platform}-${process.arch}`.
 * The two hashes are the trust anchor: a download must match archiveSha256, and the binary must
 * match binarySha256 on every run. e2e/collector/README.md says how to get them for a new row.
 */
const PLATFORMS = {
  "darwin-arm64": {
    archive: `otelcol-contrib_${COLLECTOR_VERSION}_darwin_arm64.tar.gz`,
    archiveSha256: "af6a0c56886e3cc36ccebe849fa167bad2bc47a97a48fd8497a0d6f93d0cf73a",
    binarySha256: "4d60abcd101c768268f885e3c42a5d2ca083d9d7461c68c6c77dc044371aa0c5",
  },
};

/** Name of the collector binary inside the archive. */
const BINARY_NAME = "otelcol-contrib";

/** Prefix of the folder in DOWNLOAD_DIR that one download extracts into. */
const STAGING_PREFIX = "staging-";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_DIR = path.join(REPO, "e2e", "collector");
const CONFIG_FILE = path.join(FIXTURE_DIR, "config.yaml");
const DOWNLOAD_DIR = path.join(REPO, ".otelcol");
const PACKAGE = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));

// e2e/collector/config.yaml has the same two addresses, so change them there too.
const PAGE_PORT = 5196;
const PAGE_URL = `http://127.0.0.1:${String(PAGE_PORT)}/`;
const COLLECTOR_URL = "http://127.0.0.1:14318";

/** How long the collector gets to open its port. */
const READY_TIMEOUT_MS = 15_000;

/** How long the collector gets to stop after SIGTERM before the check kills it. */
const STOP_TIMEOUT_MS = 5_000;

/** How long one probe of the collector's port waits for an answer. */
const PROBE_TIMEOUT_MS = 1_000;

/** How long one step in the page gets. A page that failed to load fails the check this fast. */
const PAGE_TIMEOUT_MS = 10_000;

/** Exit code of a run that a signal stopped, which is 128 plus the signal's number. */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/** OTLP severity number of an info log. */
const INFO_SEVERITY_NUMBER = 9;

/** OTLP aggregation temporality of the library's counter. 1 is delta. */
const DELTA_TEMPORALITY = 1;

/** Length of an OTLP trace id and span id, in hex characters. */
const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;

const SERVICE_NAME = "collector-check";
const LOG_BODY = "collector check log";
const COUNTER_NAME = "collector_check.count";
const SPAN_NAME = "collector-check";

/** The attribute that the page puts on each signal. Its value is the run's id. */
const RUN_ATTRIBUTE = "check.run";

/**
 * The two page loads. The plain run proves the JSON body, and the gzip run proves that the
 * collector decodes a body that the library compressed. Each batch is already above the
 * library's compression threshold, and checkRequests() fails if the log batch wasn't gzip.
 */
const RUNS = [
  { id: "plain", compression: "none" },
  { id: "gzip", compression: "gzip" },
];

/**
 * Where an OTLP export request keeps its items. One row is [resource list, scope list, item
 * list], and the row's key is also the URL path and the output file's name.
 */
const SIGNALS = {
  logs: ["resourceLogs", "scopeLogs", "logRecords"],
  metrics: ["resourceMetrics", "scopeMetrics", "metrics"],
  traces: ["resourceSpans", "scopeSpans", "spans"],
};

const runFile = promisify(execFile);

let failed = false;

/**
 * Prints one result line and remembers a failure for the exit code.
 * @param passed True if the collector did what the line says.
 * @param statement What the check expected.
 */
function report(passed, statement) {
  if (passed) {
    console.log(`collector: ${statement}`);

    return;
  }

  failed = true;
  console.error(`collector: FAILED: ${statement}`);
}

/**
 * Checks whether a file exists.
 * @param file Absolute path.
 * @returns True if it does.
 */
async function exists(file) {
  try {
    await access(file);

    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads one file of the pinned release.
 * @param name File name in the release.
 * @returns The file's bytes.
 */
async function download(name) {
  const response = await fetch(`${RELEASE_URL}/${name}`);

  if (!response.ok) {
    throw new Error(`The download of ${name} failed with status ${String(response.status)}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Returns the SHA-256 of a file. It reads the file in chunks, because the binary has 370 MB.
 * @param file Absolute path.
 * @returns The hash as hex.
 */
async function sha256OfFile(file) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

/**
 * Removes the staging folders that earlier downloads left behind. A run that was stopped during
 * the download or the extraction can't remove its own, and one folder can hold 468 MB.
 */
async function removeStaleStaging() {
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  for (const name of await readdir(DOWNLOAD_DIR)) {
    if (name.startsWith(STAGING_PREFIX)) {
      await rm(path.join(DOWNLOAD_DIR, name), { recursive: true, force: true });
    }
  }
}

/**
 * Returns the path of the pinned collector binary. It reuses the installed binary only when its
 * hash matches PLATFORMS, and downloads the archive otherwise. Nothing is extracted from an
 * archive with the wrong hash, and nothing is installed from a binary with the wrong hash.
 * @returns Absolute path of the binary.
 */
async function ensureCollector() {
  const key = `${process.platform}-${process.arch}`;
  const platform = PLATFORMS[key];

  if (platform === undefined) {
    throw new Error(
      `The check has no pinned collector for ${key}. It supports ` +
        `${Object.keys(PLATFORMS).join(", ")}. ` +
        "Add a row to PLATFORMS in tools/check-collector.mjs.",
    );
  }

  await removeStaleStaging();

  const installDir = path.join(DOWNLOAD_DIR, platform.archive.replace(".tar.gz", ""));
  const binary = path.join(installDir, BINARY_NAME);
  const binaryLabel = path.relative(REPO, binary);

  if (await exists(binary)) {
    // The check runs this file, so a binary that changed after its download must not start.
    if ((await sha256OfFile(binary)) === platform.binarySha256) {
      console.log(`collector: reuses ${binaryLabel}, and its SHA-256 matches the pinned value`);

      return binary;
    }

    console.log(`collector: ${binaryLabel} doesn't match the pinned SHA-256, so it is replaced`);
  }

  // Also removes an install folder that has no binary, or the rename below fails on every run.
  await rm(installDir, { recursive: true, force: true });

  console.log(`collector: downloads ${platform.archive}`);

  const archive = await download(platform.archive);
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");

  if (archiveSha256 !== platform.archiveSha256) {
    throw new Error(
      `The SHA-256 of ${platform.archive} doesn't match, so the check didn't extract it. ` +
        `Pinned: ${platform.archiveSha256}. Download: ${archiveSha256}.`,
    );
  }

  // Extract next to the final folder and rename, so a run that stops halfway never leaves a
  // binary that the next run would reuse.
  const staging = await mkdtemp(path.join(DOWNLOAD_DIR, STAGING_PREFIX));

  try {
    const archiveFile = path.join(staging, platform.archive);

    await writeFile(archiveFile, archive);
    await runFile("tar", ["-xzf", archiveFile, "-C", staging, BINARY_NAME]);
    await rm(archiveFile);

    const binarySha256 = await sha256OfFile(path.join(staging, BINARY_NAME));

    if (binarySha256 !== platform.binarySha256) {
      throw new Error(
        `The SHA-256 of the extracted ${BINARY_NAME} doesn't match, so the check didn't ` +
          `install it. Pinned: ${platform.binarySha256}. Extracted: ${binarySha256}.`,
      );
    }

    await rename(staging, installDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });

    throw error;
  }

  console.log(`collector: installed ${binaryLabel}, and the archive and the binary match`);

  return binary;
}

/**
 * Checks whether something answers HTTP on the collector's port. The receiver answers a GET
 * with 405, and any answer shows that the port is open.
 * @returns True if a server answered.
 */
async function collectorAnswers() {
  try {
    await fetch(`${COLLECTOR_URL}/v1/logs`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

    return true;
  } catch {
    return false;
  }
}

/**
 * Returns what the collector wrote to stderr.
 * @param collector The started collector.
 * @returns The text.
 */
function collectorLog(collector) {
  return Buffer.concat(collector.stderr).toString("utf8");
}

/**
 * Stops the collector and waits for its exit, because the file exporter writes its buffer
 * when the collector shuts down. Does nothing for a collector that already stopped.
 * @param collector The result of spawnCollector().
 */
async function stopCollector(collector) {
  const { child } = collector;

  // A binary that failed to start has no pid and never emits "exit", so the wait would hang.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, "exit");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);

  child.kill("SIGTERM");
  await exited;
  clearTimeout(killTimer);
}

/**
 * Fails if another server has the collector's port, because it would answer the readiness
 * probe and then get the page's batches.
 */
async function requireFreePort() {
  if (await collectorAnswers()) {
    throw new Error(`Another server already answers on ${COLLECTOR_URL}. Stop it and run again.`);
  }
}

/**
 * Starts the collector's process and returns at once. The caller keeps the result before the
 * collector is ready, so a signal during the start can still stop the process.
 * @param binary Absolute path of the collector binary.
 * @param outputDir Folder for the file exporter's output.
 * @returns The child process, and the chunks that it writes to stderr.
 */
function spawnCollector(binary, outputDir) {
  const child = spawn(binary, ["--config", CONFIG_FILE], {
    env: { ...process.env, CHECK_OUTPUT_DIR: outputDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];

  // The collector logs to stderr. Keep it, so a failed start can show the collector's reason.
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return { child, stderr };
}

/**
 * Waits until the collector's receiver answers.
 * @param collector The result of spawnCollector().
 */
async function waitForCollector(collector) {
  const { child } = collector;

  // Rejects with the OS error when the binary can't start, for example after a broken download.
  await once(child, "spawn");

  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The collector stopped before it was ready, with exit code ${String(child.exitCode)}.\n` +
          `${collectorLog(collector)}`,
      );
    }

    if (await collectorAnswers()) {
      return;
    }

    await delay(100);
  }

  await stopCollector(collector);

  throw new Error(
    `The collector did not answer on ${COLLECTOR_URL} in ${String(READY_TIMEOUT_MS)} ms.\n` +
      `${collectorLog(collector)}`,
  );
}

/**
 * Starts the Vite server that serves the fixture page and the library source.
 * @param cacheDir Folder for Vite's cache, so this server shares no cache with another one.
 * @returns The listening server.
 */
async function startPageServer(cacheDir) {
  const ownListeners = process.listeners("SIGTERM");
  const server = await createServer({
    root: FIXTURE_DIR,
    // The repo's vite.config.ts builds the library, and the page needs none of it.
    configFile: false,
    cacheDir,
    // The library source reads its version from this constant, as in the repo's vite.config.ts.
    define: { __UIOBS_VERSION__: JSON.stringify(PACKAGE.version) },
    logLevel: "error",
    server: { host: "127.0.0.1", port: PAGE_PORT, strictPort: true, hmr: false },
  });

  // Vite adds its own SIGTERM listener, which closes only Vite and then calls process.exit().
  // That exit comes before stopOnSignal() has stopped the collector and removed the work folder.
  for (const listener of process.listeners("SIGTERM")) {
    if (!ownListeners.includes(listener)) {
      process.off("SIGTERM", listener);
    }
  }

  await server.listen();

  return server;
}

/**
 * Loads the fixture page, lets it send one run's signals, and records each POST that the page
 * sent to the collector.
 * @param browser The Chromium instance.
 * @param run One row of RUNS.
 * @returns The page's report and the POST requests.
 */
async function sendRun(browser, run) {
  const page = await browser.newPage();
  const posts = [];

  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  // Without this line, a page that throws at load shows up only as a timeout.
  page.on("pageerror", (error) => console.error("collector: the fixture page threw.", error));

  page.on("response", (response) => {
    const request = response.request();

    if (request.method() === "POST" && request.url().startsWith(COLLECTOR_URL)) {
      posts.push({
        path: new URL(request.url()).pathname,
        status: response.status(),
        encoding: request.headers()["content-encoding"] ?? "",
        bytes: request.postDataBuffer()?.length ?? 0,
      });
    }
  });

  try {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => typeof globalThis.sendSignals === "function");

    const pageReport = await page.evaluate((options) => globalThis.sendSignals(options), {
      collectorUrl: COLLECTOR_URL,
      serviceName: SERVICE_NAME,
      compression: run.compression,
      runId: run.id,
      logBody: LOG_BODY,
      counterName: COUNTER_NAME,
      spanName: SPAN_NAME,
    });

    return { pageReport, posts };
  } finally {
    await page.close();
  }
}

/**
 * Turns an OTLP attribute list into a plain object. An OTLP value is an object with one key,
 * for example { stringValue: "a" }, and the key's name doesn't matter here.
 * @param keyValues The OTLP attribute list, or undefined.
 * @returns Attribute values by key.
 */
function attributesOf(keyValues) {
  return Object.fromEntries(
    (keyValues ?? []).map((entry) => [entry.key, Object.values(entry.value ?? {})[0]]),
  );
}

/**
 * Reads every item of one signal from the file exporter's output. Each line of the file is one
 * export request.
 * @param outputDir Folder of the file exporter's output.
 * @param signal A key of SIGNALS.
 * @returns One entry for each log record, metric or span, with its service name.
 */
async function readItems(outputDir, signal) {
  const [resourceList, scopeList, itemList] = SIGNALS[signal];
  const file = path.join(outputDir, `${signal}.jsonl`);

  // The exporter creates the file with the first batch, so no file means no accepted batch.
  if (!(await exists(file))) {
    return [];
  }

  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
  const items = [];

  for (const line of lines) {
    for (const resourceEntry of JSON.parse(line)[resourceList] ?? []) {
      const serviceName = attributesOf(resourceEntry.resource?.attributes)["service.name"];

      for (const scopeEntry of resourceEntry[scopeList] ?? []) {
        for (const item of scopeEntry[itemList] ?? []) {
          items.push({ serviceName, item });
        }
      }
    }
  }

  return items;
}

/**
 * Checks what the page saw during one run: an accepted POST for each signal, the expected
 * Content-Encoding, and no record that the library lost.
 * @param run One row of RUNS.
 * @param sent The result of sendRun().
 */
function checkRequests(run, sent) {
  const { pageReport, posts } = sent;

  for (const signal of Object.keys(SIGNALS)) {
    const post = posts.find((entry) => entry.path === `/v1/${signal}`);
    const detail =
      post === undefined
        ? "the page sent no POST"
        : `status ${String(post.status)}, ${String(post.bytes)} bytes, ` +
          `Content-Encoding "${post.encoding}"`;

    report(
      post?.status === 200,
      `${run.id} run: the collector answered 200 to POST /v1/${signal} (${detail})`,
    );
  }

  const logPost = posts.find((entry) => entry.path === "/v1/logs");
  const expectedEncoding = run.compression === "gzip" ? "gzip" : "";

  report(
    logPost?.encoding === expectedEncoding,
    `${run.id} run: the log batch had Content-Encoding "${expectedEncoding}"`,
  );
  report(
    pageReport.drops.length === 0 && pageReport.diagnostics.length === 0,
    `${run.id} run: the library reported no drop and no diagnostic ` +
      `(${JSON.stringify(pageReport)})`,
  );
}

/**
 * Checks whether an OTLP id has the given number of hex characters. An id of only zeros fails,
 * because OTLP reads it as "no id".
 * @param value The id from the collector's output.
 * @param length Expected number of hex characters.
 * @returns True if the id is valid.
 */
function isHexId(value, length) {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/.test(value) &&
    !/^0+$/.test(value)
  );
}

/**
 * Checks whether an OTLP time is set. The collector writes a time as a decimal string of
 * nanoseconds, and it leaves the field out or writes "0" when the sender gave none.
 * @param value The time from the collector's output.
 * @returns True if the time is above zero.
 */
function isSetTime(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

/**
 * Returns the named fields of an item as text, so a result line shows what the collector wrote.
 * A field that the collector dropped is missing from the text.
 * @param item A log record, a sum or a span from the collector's output, or undefined.
 * @param names The fields to show.
 * @returns The fields as JSON.
 */
function fieldsOf(item, names) {
  return JSON.stringify(Object.fromEntries(names.map((name) => [name, item?.[name]])));
}

/**
 * Checks that the collector's output has the run's log record, counter point and span, each
 * with the service name and the run attribute, and that each one kept its required fields. The
 * collector drops a misspelled field or an empty id without an error, so only the output shows it.
 * @param run One row of RUNS.
 * @param received The items of each signal, by signal name.
 */
function checkReceived(run, received) {
  const fromService = (entry) => entry.serviceName === SERVICE_NAME;
  const ofRun = (item) => attributesOf(item.attributes)[RUN_ATTRIBUTE] === run.id;

  const log = received.logs.find(
    (entry) => fromService(entry) && entry.item.body?.stringValue === LOG_BODY && ofRun(entry.item),
  )?.item;

  report(
    log !== undefined,
    `${run.id} run: logs.jsonl has the record "${LOG_BODY}" with service.name and ${RUN_ATTRIBUTE}`,
  );
  report(
    log?.severityNumber === INFO_SEVERITY_NUMBER && isSetTime(log.timeUnixNano),
    `${run.id} run: the log record has severityNumber ${String(INFO_SEVERITY_NUMBER)} and a ` +
      `timeUnixNano above zero (${fieldsOf(log, ["severityNumber", "timeUnixNano"])})`,
  );

  // A counter is an OTLP sum, and the run attribute is on the data point, not on the metric.
  const sums = received.metrics
    .filter((entry) => fromService(entry) && entry.item.name === COUNTER_NAME)
    .map((entry) => entry.item.sum)
    .filter((sum) => (sum?.dataPoints ?? []).some(ofRun));
  const points = sums.flatMap((sum) => sum.dataPoints.filter(ofRun));
  const value = points.length === 1 ? Number(points[0].asInt ?? points[0].asDouble) : NaN;

  report(
    value === 1,
    `${run.id} run: metrics.jsonl has one point of "${COUNTER_NAME}" with the value 1, ` +
      `service.name and ${RUN_ATTRIBUTE}`,
  );
  report(
    sums[0]?.aggregationTemporality === DELTA_TEMPORALITY && sums[0].isMonotonic === true,
    `${run.id} run: the sum has aggregationTemporality ${String(DELTA_TEMPORALITY)} and ` +
      `isMonotonic true (${fieldsOf(sums[0], ["aggregationTemporality", "isMonotonic"])})`,
  );

  const span = received.traces.find(
    (entry) => fromService(entry) && entry.item.name === SPAN_NAME && ofRun(entry.item),
  )?.item;

  report(
    span !== undefined,
    `${run.id} run: traces.jsonl has the span "${SPAN_NAME}" with service.name and ` +
      `${RUN_ATTRIBUTE}`,
  );
  report(
    isHexId(span?.traceId, TRACE_ID_LENGTH) && isHexId(span.spanId, SPAN_ID_LENGTH),
    `${run.id} run: the span has a traceId of ${String(TRACE_ID_LENGTH)} hex characters and a ` +
      `spanId of ${String(SPAN_ID_LENGTH)} (${fieldsOf(span, ["traceId", "spanId"])})`,
  );
  report(
    isSetTime(span?.startTimeUnixNano) &&
      isSetTime(span.endTimeUnixNano) &&
      BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano),
    `${run.id} run: the span has a start time above zero and an end time that isn't before it ` +
      `(${fieldsOf(span, ["startTimeUnixNano", "endTimeUnixNano"])})`,
  );
}

// The collector's output and Vite's cache go here, and releaseRun() removes the folder. The sync
// call leaves no moment where the folder exists and a signal handler can't see it.
const workDir = mkdtempSync(path.join(tmpdir(), "uiobs-collector-check-"));
let collector;
let pageServer;
let browser;

/** The one run of the cleanup. A signal and the normal end both wait for the same one. */
let cleanup;

/** The signal that stopped the run, or undefined if no signal came. */
let stopSignal;

/**
 * Stops the collector, closes the browser and Vite, and removes the work folder. Call it
 * through cleanUp().
 */
async function releaseRun() {
  // The collector goes first, because it would keep its port after this process exits.
  if (collector !== undefined) {
    await stopCollector(collector);
  }

  await browser?.close();
  await pageServer?.close();
  await rm(workDir, { recursive: true, force: true });
}

/**
 * Starts the cleanup on the first call and returns the same promise on a later call, because a
 * signal can arrive while the normal end already cleans up.
 * @returns A promise that resolves when nothing of the run is left.
 */
function cleanUp() {
  cleanup ??= releaseRun();

  return cleanup;
}

/**
 * Cleans up and exits with the signal's code. Without it, a stopped run leaves the collector on
 * its port, so the next run fails, and it leaves the work folder.
 * @param signal "SIGINT" or "SIGTERM". Node passes the name to the handler.
 */
async function stopOnSignal(signal) {
  // A second signal must not cut the cleanup short. The cleanup ends by itself in a few seconds.
  if (stopSignal !== undefined) {
    return;
  }

  stopSignal = signal;
  console.error(`collector: stopped by ${signal}. The check cleans up and exits.`);

  try {
    await cleanUp();
  } catch (error) {
    console.error("collector: the cleanup after the signal failed.", error);
  }

  process.exit(SIGNAL_EXIT_CODES[signal]);
}

process.on("SIGINT", stopOnSignal);
process.on("SIGTERM", stopOnSignal);

try {
  const binary = await ensureCollector();

  await requireFreePort();
  collector = spawnCollector(binary, workDir);
  await waitForCollector(collector);
  console.log(`collector: otelcol-contrib ${COLLECTOR_VERSION} answers on ${COLLECTOR_URL}`);

  pageServer = await startPageServer(path.join(workDir, "vite-cache"));
  // Playwright's own signal handlers call process.exit() before stopOnSignal() has cleaned up.
  browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false });

  const sentRuns = [];

  for (const run of RUNS) {
    sentRuns.push(await sendRun(browser, run));
  }

  // Stop the collector before the read, so the file exporter has written every accepted batch.
  await stopCollector(collector);

  const received = {};

  for (const signal of Object.keys(SIGNALS)) {
    received[signal] = await readItems(workDir, signal);
  }

  RUNS.forEach((run, index) => {
    checkRequests(run, sentRuns[index]);
    checkReceived(run, received);
  });

  if (failed) {
    console.error(`collector: the collector's log follows.\n${collectorLog(collector)}`);
  }
} catch (error) {
  failed = true;

  // After a signal, a step fails only because stopOnSignal() closed the browser under it.
  if (stopSignal === undefined) {
    console.error("collector: the check could not complete.", error);
  }
} finally {
  await cleanUp();
}

// A run that a signal stopped exits in stopOnSignal(), with the signal's code.
if (failed && stopSignal === undefined) {
  process.exit(1);
}

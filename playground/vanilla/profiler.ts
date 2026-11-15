// playground/vanilla/profiler.ts
//
// Overhead benchmark of the profiler. Three modes time one begin() and end() pair. The baseline
// mode times a plain loop with a counter and has no pair. No capture runs on this page. The sender,
// the profiler timer and the calibration can still run between two runs. A timed loop is
// synchronous. None of them interrupts it. Each number belongs to this browser and machine.

import { configure, createMemoryTransport, flush, profiler } from "../../src/index";

/** Default number of measured runs of each mode. */
const DEFAULT_RUNS = 101;

/** Default number of pairs in one run. */
const DEFAULT_PAIRS = 500_000;

/** Largest number of runs that the page accepts. */
const MAX_RUNS = 10_000;

/** Largest number of pairs in one run that the page accepts. */
const MAX_PAIRS = 50_000_000;

/** A mode with fewer clock ticks in its p50 run gets the mark low resolution. */
const LOW_RESOLUTION_TICKS = 100;

/** Number of characters of a refused text that the page shows. */
const SHOWN_TEXT_LENGTH = 20;

/** Hosts that can receive the report, besides the host of the page. */
const REPORT_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Runs of each mode that the result ignores. */
const WARMUP_RUNS = 3;

/** Interval of the profiler timer in milliseconds. The library permits no smaller value. */
const FLUSH_INTERVAL_MS = 1000;

/** Extra wait after one interval, so that the timer collect has finished. */
const TIMER_MARGIN_MS = 250;

/** Spans that give the profiler data for the last timer collect. */
const OVERHEAD_SPANS = 1000;

/** The sampleEvery value of the sampled mode. */
const SAMPLED_EVERY = 64;

/** Clock edges that the tick search waits for. */
const TICK_EDGES = 50;

/** Longest time of the tick search, in milliseconds. */
const TICK_BUDGET_MS = 200;

/** Longest wait for the report request, in milliseconds. */
const REPORT_TIMEOUT_MS = 5000;

/** Nanoseconds in one millisecond. */
const NS_PER_MS = 1e6;

/** Name of the profiler summary record. */
const PROFILE_RECORD = "ui.profile.duration";

/** Attribute that holds the calibrated cost of one pair. */
const OVERHEAD_KEY = "profile.overhead_ns";

/** The four modes, in measurement order. */
type Mode = "baseline" | "off" | "on" | "sampled";

/** Percentiles and maximum of a list of runs. */
interface Spread {
  p50: number;
  p99: number;
  max: number;
}

/** Result of one mode. */
interface ModeResult {
  mode: Mode;
  runs: number;
  /** Nanoseconds per pair. */
  nsPerPair: Spread;
  /** The p50 run time divided by the clock tick, or null when the page saw no tick. */
  ticksPerRun: number | null;
}

/** Result of the whole benchmark. It is the JSON of the page. */
interface BenchResult {
  userAgent: string;
  crossOriginIsolated: boolean;
  /** Smallest non-zero step of performance.now(), in milliseconds. */
  clockTickMs: number | null;
  /** The smallest difference in nanoseconds per pair that one run can show. */
  nsStep: number | null;
  runs: number;
  pairs: number;
  warmupRuns: number;
  /** Value of profile.overhead_ns from the library, or null when no record has it. */
  libraryOverheadNs: number | null;
  baselineChecksum: number;
  /** Codes of the diagnostic events that the library reported during the run. */
  diagnostics: string[];
  modes: ModeResult[];
}

/** One mode, with the state of the profiler and the loop that it times. */
interface BenchCase {
  mode: Mode;
  profilerOn: boolean;
  loop: (pairs: number) => void;
}

/** Name, default and upper limit of a count that the page reads. The lower limit is 1. */
interface CountRule {
  name: string;
  fallback: number;
  max: number;
}

/** A count in force and the note about a text that the page refused. */
interface Count {
  value: number;
  note: string | null;
}

/** Target of the report and the note about a value that the page ignored. */
interface ReportTarget {
  url: string | null;
  note: string | null;
}

/**
 * Queries a DOM element by selector, throwing if missing.
 * @param selector CSS selector string.
 * @returns Matched DOM element.
 */
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`profiler page: no element matches ${selector}`);
  }
  return found;
};

/**
 * Normalizes caught errors into string messages.
 * @param err Unknown caught error.
 * @returns Formatted message string.
 */
const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Waits for a time.
 * @param ms Time in milliseconds. Zero gives the event loop one turn.
 * @returns A promise that resolves after the time.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Rounds a number.
 * @param value The number.
 * @param digits Digits after the decimal point.
 * @returns The rounded number.
 */
const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const RUNS_RULE: CountRule = { name: "runs", fallback: DEFAULT_RUNS, max: MAX_RUNS };
const PAIRS_RULE: CountRule = { name: "pairs", fallback: DEFAULT_PAIRS, max: MAX_PAIRS };

/**
 * Reads a count. The text must give a safe integer from 1 to the limit of the rule. Text such as
 * 500_000 gives NaN. A prefix parse would read it as 500. The page refuses it.
 * @param text Text of an input or of a URL parameter. Null means that the parameter is absent.
 * @param rule The rule of the count.
 * @returns The value in force and a note when the page refused the text.
 */
function readCount(text: string | null, rule: CountRule): Count {
  if (text === null) {
    return { value: rule.fallback, note: null };
  }

  const value = Number(text);
  if (Number.isSafeInteger(value) && value >= 1 && value <= rule.max) {
    return { value, note: null };
  }

  const shown = text.slice(0, SHOWN_TEXT_LENGTH);
  return {
    value: rule.fallback,
    note:
      `The ${rule.name} value "${shown}" is not valid. ` +
      `The limits are 1 to ${String(rule.max)}. The page uses ${String(rule.fallback)}.`,
  };
}

/**
 * Checks the report parameter. A report can leave the page only for the host of the page or for
 * a local host. Another target would receive the user agent text of the visitor.
 * @param text Text of the report parameter. Null means that the parameter is absent.
 * @returns The target, or null and a note when the page ignored the value.
 */
function readReportUrl(text: string | null): ReportTarget {
  if (text === null) {
    return { url: null, note: null };
  }

  const hosts = [...new Set([location.hostname, ...REPORT_HOSTS])];
  if (URL.canParse(text, location.href)) {
    const url = new URL(text, location.href);
    if ((url.protocol === "http:" || url.protocol === "https:") && hosts.includes(url.hostname)) {
      return { url: url.href, note: null };
    }
  }

  return {
    url: null,
    note:
      `The report parameter is ignored. Its host must be ${hosts.join(" or ")}. ` +
      "Its protocol must be http or https.",
  };
}

const params = new URLSearchParams(location.search);
const runsInput = el("#runs") as HTMLInputElement;
const pairsInput = el("#pairs") as HTMLInputElement;
const startButton = el("#bench-start") as HTMLButtonElement;
const copyButton = el("#copy-json") as HTMLButtonElement;
const statusLine = el("#status");
const resultTable = el("#result-table") as HTMLTableElement;
const envTable = el("#env-table") as HTMLTableElement;
const resultJson = el("#result-json");
const settingsNote = el("#settings-note");

runsInput.max = String(MAX_RUNS);
pairsInput.max = String(MAX_PAIRS);

const urlRuns = readCount(params.get("runs"), RUNS_RULE);
const urlPairs = readCount(params.get("pairs"), PAIRS_RULE);
const reportTarget = readReportUrl(params.get("report"));

/** Notes about the URL parameters that the page refused. The page shows them at each start. */
const urlNotes = [urlRuns.note, urlPairs.note, reportTarget.note];

/** The memory transport keeps each record in the page. The loop uses no network. */
const memory = createMemoryTransport();

/** Codes of the diagnostic events of the library. */
const diagnostics = new Set<string>();

configure({
  serviceName: "profiler-bench",
  transport: memory.transport,
  storage: "none",
  identity: "memory",
  bus: { mode: "off" },
  capture: {
    errors: false,
    rejections: false,
    resourceErrors: false,
    fetch: false,
    xhr: false,
    httpMetrics: false,
    interactions: false,
    navigation: false,
    webVitals: false,
    longFrames: false,
    console: false,
    webSocket: false,
    uncleanExit: false,
    userTiming: false,
    serverTiming: false,
    reports: false,
    resourceTiming: false,
    lifecycle: false,
  },
  profiler: { enabled: true, flushIntervalMs: FLUSH_INTERVAL_MS },
  onDiagnostic: (event) => {
    // Each later configure() call reports config.reconfigured. It is not a fault.
    if (event.code !== "config.reconfigured") {
      diagnostics.add(event.code);
    }
  },
});

const offProbe = profiler.probe("bench.off");
const onProbe = profiler.probe("bench.on", { sampleEvery: 1 });
const sampledProbe = profiler.probe("bench.sampled", { sampleEvery: SAMPLED_EVERY });

/** Sum of the baseline loop. The page prints it. Without this use, the JIT can remove the loop. */
let checksum = 0;

/**
 * Runs the loop of the baseline mode. It has no probe.
 * @param pairs Number of loop turns.
 */
function baselineLoop(pairs: number): void {
  let sum = 0;
  for (let i = 0; i < pairs; i++) {
    sum = (sum + i) | 0;
  }
  checksum = (checksum + sum) | 0;
}

// Each mode has its own loop. A shared loop has one call site for three probes. The JIT can then
// optimise the first mode more than the later modes.

/**
 * Runs pairs on a probe while the profiler is off.
 * @param pairs Number of pairs.
 */
function offLoop(pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    const token = offProbe.begin();
    offProbe.end(token);
  }
}

/**
 * Runs pairs on a probe that measures each span.
 * @param pairs Number of pairs.
 */
function onLoop(pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    const token = onProbe.begin();
    onProbe.end(token);
  }
}

/**
 * Runs pairs on a probe that measures one span of each 64 spans.
 * @param pairs Number of pairs.
 */
function sampledLoop(pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    const token = sampledProbe.begin();
    sampledProbe.end(token);
  }
}

/** The modes, in measurement order. The baseline is first, because the other modes need its p50. */
const CASES: readonly BenchCase[] = [
  { mode: "baseline", profilerOn: true, loop: baselineLoop },
  { mode: "off", profilerOn: false, loop: offLoop },
  { mode: "on", profilerOn: true, loop: onLoop },
  { mode: "sampled", profilerOn: true, loop: sampledLoop },
];

/**
 * Gives the value at a percentile with the nearest-rank rule.
 * @param sorted Values in ascending order.
 * @param p Percentile from 1 to 100.
 * @returns The value at that rank.
 */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[rank - 1];
}

/**
 * Gives the p50, the p99 and the maximum of a list.
 * @param values Values of the runs of one mode.
 * @returns The three values.
 */
function summarize(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Rounds each value of a spread.
 * @param spread The spread.
 * @returns The new spread, rounded to three decimals.
 */
function roundSpread(spread: Spread): Spread {
  return {
    p50: round(spread.p50, 3),
    p99: round(spread.p99, 3),
    max: round(spread.max, 3),
  };
}

/**
 * Times one run.
 * @param loop The loop of a mode.
 * @param pairs Number of pairs in the run.
 * @returns Nanoseconds per pair.
 */
function timeRun(loop: (pairs: number) => void, pairs: number): number {
  const start = performance.now();
  loop(pairs);
  const elapsedMs = performance.now() - start;
  return (elapsedMs * NS_PER_MS) / pairs;
}

/**
 * Warms up and then measures one mode. It yields to the event loop after each run.
 * @param item The mode.
 * @param runs Number of measured runs.
 * @param pairs Number of pairs in each run.
 * @param progress Shows a progress text.
 * @returns Nanoseconds per pair of each measured run.
 */
async function measureCase(
  item: BenchCase,
  runs: number,
  pairs: number,
  progress: (text: string) => void,
): Promise<number[]> {
  configure({ profiler: { enabled: item.profilerOn } });

  for (let i = 0; i < WARMUP_RUNS; i++) {
    progress(`${item.mode}: warm-up ${String(i + 1)} of ${String(WARMUP_RUNS)}`);
    timeRun(item.loop, pairs);
    await sleep(0);
  }

  const values: number[] = [];
  for (let i = 0; i < runs; i++) {
    progress(`${item.mode}: run ${String(i + 1)} of ${String(runs)}`);
    values.push(timeRun(item.loop, pairs));
    await sleep(0);
  }
  return values;
}

/**
 * Finds the smallest non-zero step of the clock.
 * @returns The step in milliseconds, or null if the clock showed no step in the time budget.
 */
function observeTick(): number | null {
  const stop = performance.now() + TICK_BUDGET_MS;
  let previous = performance.now();
  let smallest: number | null = null;
  let edges = 0;

  while (edges < TICK_EDGES) {
    const now = performance.now();
    if (now > stop) {
      break;
    }

    if (now > previous) {
      smallest = smallest === null ? now - previous : Math.min(smallest, now - previous);
      previous = now;
      edges++;
    }
  }
  return smallest === null ? null : round(smallest, 6);
}

/**
 * Reads the overhead that the library calibrated. Only a timer collect gives it, so the page
 * waits for one timer flush.
 * @returns Value of profile.overhead_ns, or null if no record has it.
 */
async function readOverhead(): Promise<number | null> {
  memory.clear();
  onLoop(OVERHEAD_SPANS);
  await sleep(FLUSH_INTERVAL_MS + TIMER_MARGIN_MS);
  await flush();

  let found: number | null = null;
  for (const record of memory.records()) {
    const value = record.attributes[OVERHEAD_KEY];
    if (record.attributes["metric.name"] === PROFILE_RECORD && typeof value === "number") {
      found = value;
    }
  }
  return found;
}

/**
 * Runs the four modes and reads the library overhead.
 * @param runs Number of measured runs of each mode.
 * @param pairs Number of pairs in each run.
 * @param progress Shows a progress text.
 * @returns The result.
 */
async function runBenchmark(
  runs: number,
  pairs: number,
  progress: (text: string) => void,
): Promise<BenchResult> {
  const clockTickMs = observeTick();
  const modes: ModeResult[] = [];

  for (const item of CASES) {
    const spread = summarize(await measureCase(item, runs, pairs, progress));
    const runMs = (spread.p50 * pairs) / NS_PER_MS;
    modes.push({
      mode: item.mode,
      runs,
      nsPerPair: roundSpread(spread),
      ticksPerRun: clockTickMs === null ? null : round(runMs / clockTickMs, 2),
    });
  }

  progress("library overhead: waiting for one timer flush");
  const libraryOverheadNs = await readOverhead();

  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: window.crossOriginIsolated,
    clockTickMs,
    nsStep: clockTickMs === null ? null : round((clockTickMs * NS_PER_MS) / pairs, 3),
    runs,
    pairs,
    warmupRuns: WARMUP_RUNS,
    libraryOverheadNs,
    baselineChecksum: checksum,
    diagnostics: [...diagnostics],
    modes,
  };
}

/**
 * Appends one row to a table section.
 * @param parent Head or body of a table.
 * @param tag Cell tag.
 * @param cells Text of each cell.
 */
function addRow(parent: HTMLElement, tag: "th" | "td", cells: readonly string[]): void {
  const row = parent.appendChild(document.createElement("tr"));
  for (const text of cells) {
    row.appendChild(document.createElement(tag)).textContent = text;
  }
}

/**
 * Replaces the content of a table.
 * @param table The table.
 * @param head Text of each head cell.
 * @param rows Text of each body cell.
 */
function fillTable(
  table: HTMLTableElement,
  head: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  table.replaceChildren();
  addRow(table.createTHead(), "th", head);
  const body = table.createTBody();
  for (const cells of rows) {
    addRow(body, "td", cells);
  }
}

/**
 * Shows the result as two tables and as JSON.
 * @param result The result.
 * @returns The JSON text.
 */
function showResult(result: BenchResult): string {
  const fixed = (value: number): string => value.toFixed(2);

  fillTable(
    resultTable,
    ["mode", "runs", "p50", "p99", "max", "ticks per run", "mark"],
    result.modes.map((item) => [
      item.mode,
      String(item.runs),
      fixed(item.nsPerPair.p50),
      fixed(item.nsPerPair.p99),
      fixed(item.nsPerPair.max),
      item.ticksPerRun === null ? "null" : item.ticksPerRun.toFixed(1),
      item.ticksPerRun !== null && item.ticksPerRun < LOW_RESOLUTION_TICKS ? "low resolution" : "",
    ]),
  );

  fillTable(
    envTable,
    ["name", "value"],
    [
      ["navigator.userAgent", result.userAgent],
      ["crossOriginIsolated", String(result.crossOriginIsolated)],
      ["clock tick (ms)", String(result.clockTickMs)],
      ["clock step per run (ns per pair)", String(result.nsStep)],
      ["runs", String(result.runs)],
      ["pairs per run", String(result.pairs)],
      ["warm-up runs (ignored)", String(result.warmupRuns)],
      [OVERHEAD_KEY, String(result.libraryOverheadNs)],
      ["baseline checksum", String(result.baselineChecksum)],
      ["library diagnostics", result.diagnostics.join(", ") || "none"],
    ],
  );

  const json = JSON.stringify(result, null, 2);
  resultJson.textContent = json;
  return json;
}

/**
 * Shows a text in the status line.
 * @param text The text.
 */
function setStatus(text: string): void {
  statusLine.textContent = text;
}

/**
 * Sends the JSON as a plain text POST request. It has no custom header, so it needs no preflight.
 * @param url Target of the report.
 * @param json The JSON text.
 * @returns A text for the status line.
 */
async function sendReport(url: string, json: string): Promise<string> {
  try {
    await fetch(url, {
      method: "POST",
      body: json,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    return "The report request completed.";
  } catch (error) {
    // A server on another port without a CORS header also gives this error. The server still
    // receives the body.
    return `The report request failed. ${toMessage(error)}`;
  }
}

/**
 * Shows the values in force and each note about a refused value.
 * @param runs Number of runs in force.
 * @param pairs Number of pairs in force.
 * @param inputNotes Notes about the text of the inputs.
 */
function showSettings(runs: number, pairs: number, inputNotes: readonly (string | null)[]): void {
  const notes = [...urlNotes, ...inputNotes].filter((note): note is string => note !== null);
  settingsNote.textContent = [
    `The page uses ${String(runs)} runs and ${String(pairs)} pairs per run.`,
    ...notes,
  ].join(" ");
}

/** Tracks a running benchmark. A second start while it runs does nothing. */
let running = false;

/** Runs the benchmark, shows the result and sends the report. */
async function start(): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  startButton.disabled = true;
  copyButton.disabled = true;
  document.title = "running";

  try {
    const runs = readCount(runsInput.value, RUNS_RULE);
    const pairs = readCount(pairsInput.value, PAIRS_RULE);
    runsInput.value = String(runs.value);
    pairsInput.value = String(pairs.value);
    showSettings(runs.value, pairs.value, [runs.note, pairs.note]);

    const result = await runBenchmark(runs.value, pairs.value, setStatus);
    const json = showResult(result);
    copyButton.disabled = false;

    setStatus(reportTarget.url ? `Done. ${await sendReport(reportTarget.url, json)}` : "Done.");
    document.title = "done";
  } catch (error) {
    setStatus(`The benchmark failed. ${toMessage(error)}`);
    document.title = "failed";
  } finally {
    running = false;
    startButton.disabled = false;
  }
}

runsInput.value = String(urlRuns.value);
pairsInput.value = String(urlPairs.value);
showSettings(urlRuns.value, urlPairs.value, []);

startButton.addEventListener("click", () => {
  void start();
});

copyButton.addEventListener("click", () => {
  navigator.clipboard
    .writeText(resultJson.textContent)
    .then(() => {
      setStatus("The JSON is in the clipboard.");
    })
    .catch((error: unknown) => {
      setStatus(`The copy failed. ${toMessage(error)}`);
    });
});

if (params.get("autorun") === "1") {
  void start();
}

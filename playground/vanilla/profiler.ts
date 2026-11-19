// playground/vanilla/profiler.ts
//
// Overhead benchmark for the profiler. Three modes time a begin()/end() pair, and a baseline
// mode times a plain counting loop with no pair. No capture runs on this page. The sender, the
// profiler timer and the calibration can still run between runs, but a timed loop is synchronous
// so none of them can interrupt it. The numbers only mean something for this browser and machine.

import { configure, createMemoryTransport, flush, profiler } from "../../src/index";

/** Measured runs per mode, by default. */
const DEFAULT_RUNS = 101;

/** Pairs per run, by default. */
const DEFAULT_PAIRS = 500_000;

/** Most runs the page accepts. */
const MAX_RUNS = 10_000;

/** Most pairs per run the page accepts. */
const MAX_PAIRS = 50_000_000;

/** A mode whose p50 run spans fewer clock ticks than this is flagged as low resolution. */
const LOW_RESOLUTION_TICKS = 100;

/** How much of a rejected input the page echoes back. */
const SHOWN_TEXT_LENGTH = 20;

/** Hosts the report may be sent to, besides the page's own. */
const REPORT_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Runs per mode that are thrown away as warmup. */
const WARMUP_RUNS = 3;

/** Profiler timer interval in ms. The library doesn't allow anything shorter. */
const FLUSH_INTERVAL_MS = 1000;

/** Extra wait after an interval, so the timer's collect has definitely finished. */
const TIMER_MARGIN_MS = 250;

/** Spans that give the profiler something to send on the last timer collect. */
const OVERHEAD_SPANS = 1000;

/** sampleEvery for the sampled mode. */
const SAMPLED_EVERY = 64;

/** How many clock edges the tick search waits for. */
const TICK_EDGES = 50;

/** Time limit for the tick search, in ms. */
const TICK_BUDGET_MS = 200;

/** Time limit for the report request, in ms. */
const REPORT_TIMEOUT_MS = 5000;

const NS_PER_MS = 1e6;

/** Name of the profiler's summary record. */
const PROFILE_RECORD = "ui.profile.duration";

/** Attribute with the calibrated cost of one pair. */
const OVERHEAD_KEY = "profile.overhead_ns";

/** The four modes, in the order they are measured. */
type Mode = "baseline" | "off" | "on" | "sampled";

/** Percentiles and max over a list of runs. */
interface Spread {
  p50: number;
  p99: number;
  max: number;
}

/** Result for one mode. */
interface ModeResult {
  mode: Mode;
  runs: number;
  /** Nanoseconds per pair. */
  nsPerPair: Spread;
  /** p50 run time divided by the clock tick, or null if the page never saw a tick. */
  ticksPerRun: number | null;
}

/** The whole benchmark result. This is the JSON the page prints. */
interface BenchResult {
  userAgent: string;
  crossOriginIsolated: boolean;
  /** Smallest non-zero step of performance.now(), in ms. */
  clockTickMs: number | null;
  /** Smallest difference in ns per pair that a single run can resolve. */
  nsStep: number | null;
  runs: number;
  pairs: number;
  warmupRuns: number;
  /** profile.overhead_ns as reported by the library, or null if no record has it. */
  libraryOverheadNs: number | null;
  baselineChecksum: number;
  /** Codes of the diagnostics the library reported during the run. */
  diagnostics: string[];
  modes: ModeResult[];
}

/** One mode: the profiler state it needs and the loop it times. */
interface BenchCase {
  mode: Mode;
  profilerOn: boolean;
  loop: (pairs: number) => void;
}

/** Name, default and upper limit for a count the page reads. The lower limit is always 1. */
interface CountRule {
  name: string;
  fallback: number;
  max: number;
}

/** The count in effect, plus a note if the page rejected what was typed. */
interface Count {
  value: number;
  note: string | null;
}

/** Where the report goes, plus a note if the page ignored the value. */
interface ReportTarget {
  url: string | null;
  note: string | null;
}

/**
 * Finds an element by selector and throws if it isn't there.
 * @param selector CSS selector.
 * @returns The element.
 */
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`profiler page: no element matches ${selector}`);
  }
  return found;
};

/**
 * Turns a caught error into a message.
 * @param err Whatever was caught.
 * @returns The message.
 */
const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Waits.
 * @param ms Time in ms. Zero just yields to the event loop for one turn.
 * @returns A promise that resolves after the wait.
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
 * Reads a count. The text has to be a safe integer between 1 and the rule's limit. Something
 * like 500_000 parses to NaN and is rejected. A prefix parse would have quietly read it as 500.
 * @param text Text from an input or a URL parameter. Null means the parameter isn't there.
 * @param rule The rule for this count.
 * @returns The value in effect, plus a note if the text was rejected.
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
 * Checks the report parameter. The report may only go to the page's own host or to a local
 * one, because any other target would receive the visitor's user agent string.
 * @param text Text of the report parameter. Null means the parameter isn't there.
 * @returns The target, or null and a note if the value was ignored.
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

/** Notes about rejected URL parameters. The page shows them on every start. */
const urlNotes = [urlRuns.note, urlPairs.note, reportTarget.note];

/** The memory transport keeps every record in the page, so the loop never touches the network. */
const memory = createMemoryTransport();

/** Diagnostic codes the library reported. */
const diagnostics = new Set<string>();

configure({
  serviceName: "profiler-bench",
  transport: memory.transport,
  storage: { backend: "none" },
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
  profiler: { enabled: true },
  metrics: { intervalMs: FLUSH_INTERVAL_MS },
  onDiagnostic: (event) => {
    // Every later configure() call reports config.reconfigured. That one isn't a fault.
    if (event.code !== "config.reconfigured") {
      diagnostics.add(event.code);
    }
  },
});

const offProbe = profiler.probe("bench.off");
const onProbe = profiler.probe("bench.on", { sampleEvery: 1 });
const sampledProbe = profiler.probe("bench.sampled", { sampleEvery: SAMPLED_EVERY });

/** Sum from the baseline loop. The page prints it, otherwise the JIT could drop the loop. */
let checksum = 0;

/**
 * The baseline loop. No probe.
 * @param pairs Number of iterations.
 */
function baselineLoop(pairs: number): void {
  let sum = 0;
  for (let i = 0; i < pairs; i++) {
    sum = (sum + i) | 0;
  }
  checksum = (checksum + sum) | 0;
}

// Each mode gets its own loop. A shared loop would have one call site for three probes, and the
// JIT could then optimise the first mode harder than the ones after it.

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
 * Runs pairs on a probe that measures every span.
 * @param pairs Number of pairs.
 */
function onLoop(pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    const token = onProbe.begin();
    onProbe.end(token);
  }
}

/**
 * Runs pairs on a probe that measures one span in 64.
 * @param pairs Number of pairs.
 */
function sampledLoop(pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    const token = sampledProbe.begin();
    sampledProbe.end(token);
  }
}

/** The modes in the order they are measured. Baseline goes first: the others need its p50. */
const CASES: readonly BenchCase[] = [
  { mode: "baseline", profilerOn: true, loop: baselineLoop },
  { mode: "off", profilerOn: false, loop: offLoop },
  { mode: "on", profilerOn: true, loop: onLoop },
  { mode: "sampled", profilerOn: true, loop: sampledLoop },
];

/**
 * Nearest-rank percentile.
 * @param sorted Values in ascending order.
 * @param p Percentile, 1 to 100.
 * @returns The value at that rank.
 */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[rank - 1];
}

/**
 * Returns the p50, p99 and max of a list.
 * @param values One mode's runs.
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
 * Rounds every value in a spread.
 * @param spread The spread.
 * @returns A new spread, rounded to three decimals.
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
 * @param loop A mode's loop.
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
 * Warms up one mode, then measures it. Yields to the event loop after every run.
 * @param item The mode.
 * @param runs Number of measured runs.
 * @param pairs Number of pairs per run.
 * @param progress Shows progress text.
 * @returns Nanoseconds per pair, one value per measured run.
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
 * Finds the clock's smallest non-zero step.
 * @returns The step in ms, or null if the clock never stepped within the time limit.
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
 * Reads the overhead the library calibrated. Only a timer collect produces it, so this waits
 * for one timer flush.
 * @returns The profile.overhead_ns value, or null if no record has it.
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
 * Runs the four modes and reads the library's overhead.
 * @param runs Number of measured runs per mode.
 * @param pairs Number of pairs per run.
 * @param progress Shows progress text.
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
 * Appends a row to a table section.
 * @param parent The table's head or body.
 * @param tag Cell tag.
 * @param cells Text for each cell.
 */
function addRow(parent: HTMLElement, tag: "th" | "td", cells: readonly string[]): void {
  const row = parent.appendChild(document.createElement("tr"));
  for (const text of cells) {
    row.appendChild(document.createElement(tag)).textContent = text;
  }
}

/**
 * Replaces a table's content.
 * @param table The table.
 * @param head Text for each header cell.
 * @param rows Text for each body cell.
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
 * Renders the result as two tables and as JSON.
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
 * Sets the status line.
 * @param text The text to show.
 */
function setStatus(text: string): void {
  statusLine.textContent = text;
}

/**
 * POSTs the JSON as plain text. No custom headers, so there is no preflight.
 * @param url Where the report goes.
 * @param json The JSON text.
 * @returns Text for the status line.
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
    // A server on another port without CORS headers also ends up here, even though it did
    // receive the body.
    return `The report request failed. ${toMessage(error)}`;
  }
}

/**
 * Shows the values in effect, along with a note for each value that was rejected.
 * @param runs Number of runs in effect.
 * @param pairs Number of pairs in effect.
 * @param inputNotes Notes about what was typed into the inputs.
 */
function showSettings(runs: number, pairs: number, inputNotes: readonly (string | null)[]): void {
  const notes = [...urlNotes, ...inputNotes].filter((note): note is string => note !== null);
  settingsNote.textContent = [
    `The page uses ${String(runs)} runs and ${String(pairs)} pairs per run.`,
    ...notes,
  ].join(" ");
}

/** True while a benchmark is running. Starting again in the meantime does nothing. */
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

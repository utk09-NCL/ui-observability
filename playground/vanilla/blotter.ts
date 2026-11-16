// playground/vanilla/blotter.ts
//
// A 5,000-row blotter timed by the profiler. The page exercises every profiler feature in a
// real browser. The numbers only mean something for this browser and machine.

import {
  configure,
  createMemoryTransport,
  flush,
  getLogger,
  type LogRecord,
  profiler,
} from "../../src/index";

/** Rows in the blotter. */
const ROW_COUNT = 5000;

/** Rows changed by one update. */
const UPDATE_COUNT = 500;

/** Rows the forced-layout action reads. Every read lays out all 5,000 rows again. */
const THRASH_COUNT = 100;

/** How long the fake row load takes, in ms. */
const LOAD_WAIT_MS = 30;

/** Profiler timer interval in ms. The library doesn't allow anything shorter. */
const FLUSH_INTERVAL_MS = 1000;

/** How long we give the browser to report a long animation frame, in ms. */
const FRAME_REPORT_WAIT_MS = 300;

/** Name of the profiler's summary record. */
const PROFILE_RECORD = "ui.profile.duration";

/** Name of the frame phase metric. */
const PHASE_RECORD = "ui.profile.frame.duration";

/** Symbols for the fake orders. */
const SYMBOLS = ["VOD", "BARC", "HSBA", "AZN", "BP", "GSK", "RIO", "ULVR"];

/** One order in the blotter. */
interface Order {
  id: number;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  status: string;
}

/** One row of the probe table. */
interface ProbeRow {
  probe: string;
  count: number;
  sum: number;
  p50: number;
  p99: number;
  max: number;
  selfP99: number | null;
}

/** One row of the phase table. */
interface PhaseRow {
  probe: string;
  phase: string;
  count: number;
  sum: number;
}

/**
 * Finds an element by id. The page can't work without it, so a miss throws.
 * @param id Element id.
 * @returns The element.
 */
function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`The page has no element with the id ${id}.`);
  }

  return found;
}

/** The memory transport keeps every record in the page, so nothing touches the network. */
const memory = createMemoryTransport();

/** Diagnostic codes the library reported. */
const diagnostics = new Set<string>();

configure({
  serviceName: "profiler-blotter",
  transport: memory.transport,
  storage: "none",
  identity: "memory",
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
  profiler: {
    enabled: true,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    framePhases: true,
    framePacing: true,
  },
  onDiagnostic: (event) => {
    diagnostics.add(event.code);
  },
});

// A draw nests three probes: blotter.draw > blotter.rows > blotter.row.
const drawProbe = profiler.probe("blotter.draw", { slowMs: 16 });
const rowsProbe = profiler.probe("blotter.rows");
const rowProbe = profiler.probe("blotter.row", { sampleEvery: 64 });
const updateProbe = profiler.probe("blotter.update", { slowMs: 16 });
const thrashProbe = profiler.probe("blotter.thrash", { slowMs: 16 });
const loadProbe = profiler.probe("blotter.load", { async: true });

const body = element("blotter-body");
const status = element("status");

/** The orders, in display order. */
let orders: Order[] = [];

/** PRNG state. A fixed seed gives the same blotter on every load. */
let seed = 42;

/**
 * Returns the next number of a fixed pseudo-random sequence.
 * @returns A number in [0, 1).
 */
function nextRandom(): number {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
}

/**
 * Generates the orders for a fresh blotter.
 * @returns The orders.
 */
function makeOrders(): Order[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: index + 1,
    symbol: SYMBOLS[Math.floor(nextRandom() * SYMBOLS.length)],
    side: nextRandom() < 0.5 ? "BUY" : "SELL",
    quantity: 100 + Math.floor(nextRandom() * 9900),
    price: Math.round((1 + nextRandom() * 999) * 100) / 100,
    status: "NEW",
  }));
}

/**
 * Builds the table row for an order.
 * @param order The order to show.
 * @returns The row.
 */
function makeRow(order: Order): HTMLTableRowElement {
  const token = rowProbe.begin();
  const row = document.createElement("tr");
  const cells = [
    String(order.id),
    order.symbol,
    order.side,
    String(order.quantity),
    order.price.toFixed(2),
    (order.quantity * order.price).toFixed(2),
    order.status,
  ];

  for (const text of cells) {
    const cell = document.createElement("td");
    cell.textContent = text;
    row.append(cell);
  }

  rowProbe.end(token);
  return row;
}

/** Redraws every row. The span ends once the browser has painted them. */
function draw(): void {
  const token = drawProbe.begin();
  const rowsToken = rowsProbe.begin();
  const rows = orders.map(makeRow);
  rowsProbe.end(rowsToken);
  body.replaceChildren(...rows);
  drawProbe.endAfterPaint(token);
}

/** Sorts the orders by price and redraws. time() times the sort. */
function sortByPrice(): void {
  orders = profiler.time("blotter.sort", () =>
    [...orders].sort((left, right) => left.price - right.price),
  );
  draw();
}

/** Changes the price of some orders and rewrites just those cells. */
function update(): void {
  const token = updateProbe.begin();

  for (let step = 0; step < UPDATE_COUNT; step++) {
    const index = Math.floor(nextRandom() * orders.length);
    const order = orders[index];
    const row = body.children[index];
    order.price = Math.round((1 + nextRandom() * 999) * 100) / 100;
    order.status = "AMENDED";
    row.children[4].textContent = order.price.toFixed(2);
    row.children[5].textContent = (order.quantity * order.price).toFixed(2);
    row.children[6].textContent = order.status;
  }

  updateProbe.endAfterPaint(token);
}

/**
 * Writes a style and then reads a size, for the first rows. Every read forces a layout, which
 * is exactly the bug the forced-layout phase is there to show.
 * @returns The sum of the row heights.
 */
function thrash(): number {
  const token = thrashProbe.begin();
  let total = 0;

  for (let index = 0; index < THRASH_COUNT; index++) {
    const row = body.children[index] as HTMLElement;
    row.style.lineHeight = `${String(1.2 + nextRandom() * 0.2)}em`;
    total += row.offsetHeight;
  }

  thrashProbe.end(token);
  return total;
}

/**
 * Loads the orders after a wait, like a request would. The async probe's span includes the wait.
 * @returns A promise that resolves after the draw.
 */
async function load(): Promise<void> {
  const token = loadProbe.begin();
  await new Promise((resolve) => setTimeout(resolve, LOAD_WAIT_MS));
  orders = makeOrders();
  loadProbe.end(token);
  draw();
}

/**
 * Waits for the next paint and for the browser's frame report.
 * @returns A promise that resolves after the wait.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, FRAME_REPORT_WAIT_MS);
    });
  });
}

/**
 * Reads a numeric attribute from a record.
 * @param record Record from the memory transport.
 * @param key Attribute key.
 * @returns The number, or 0 if the value isn't one.
 */
function numberOf(record: LogRecord, key: string): number {
  const value = record.attributes[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Adds up the profiler records per probe.
 * @param records Records from the memory transport.
 * @returns One row per probe.
 */
function probeRows(records: readonly LogRecord[]): ProbeRow[] {
  const rows = new Map<string, ProbeRow>();

  for (const record of records) {
    if (record.attributes["metric.name"] !== PROFILE_RECORD) {
      continue;
    }

    const probe = String(record.attributes["profile.probe"]);
    const self = record.attributes["profile.self_p99"];
    const row = rows.get(probe) ?? {
      probe,
      count: 0,
      sum: 0,
      p50: 0,
      p99: 0,
      max: 0,
      selfP99: null,
    };

    // Two intervals of the same probe give two records. Keep the larger percentile.
    row.count += numberOf(record, "metric.count");
    row.sum += numberOf(record, "metric.sum");
    row.p50 = Math.max(row.p50, numberOf(record, "profile.p50"));
    row.p99 = Math.max(row.p99, numberOf(record, "profile.p99"));
    row.max = Math.max(row.max, numberOf(record, "metric.max"));
    if (typeof self === "number") {
      row.selfP99 = Math.max(row.selfP99 ?? 0, self);
    }

    rows.set(probe, row);
  }

  return [...rows.values()];
}

/**
 * Adds up the frame phase records per probe and phase.
 * @param records Records from the memory transport.
 * @returns One row per probe and phase.
 */
function phaseRows(records: readonly LogRecord[]): PhaseRow[] {
  const rows = new Map<string, PhaseRow>();

  for (const record of records) {
    if (record.attributes["metric.name"] !== PHASE_RECORD) {
      continue;
    }

    const probe = String(record.attributes["profile.probe"]);
    const phase = String(record.attributes["profile.frame_phase"]);
    const key = `${probe} ${phase}`;
    const row = rows.get(key) ?? { probe, phase, count: 0, sum: 0 };

    // A record without a count is a single value. A summary record has a count and a sum.
    row.count += numberOf(record, "metric.count") || 1;
    row.sum += numberOf(record, "metric.sum") || numberOf(record, "metric.value");
    rows.set(key, row);
  }

  return [...rows.values()];
}

/**
 * Fills a table.
 * @param id Element id of the table.
 * @param head Column titles.
 * @param rows Cell text for each row.
 */
function fillTable(id: string, head: string[], rows: string[][]): void {
  const table = element(id);
  const lines = [head, ...rows].map((cells, index) => {
    const line = document.createElement("tr");

    for (const text of cells) {
      const cell = document.createElement(index === 0 ? "th" : "td");
      cell.textContent = text;
      line.append(cell);
    }

    return line;
  });

  table.replaceChildren(...lines);
}

/** Sends the open profiler interval and shows the page's records. */
async function report(): Promise<void> {
  // Breadcrumbs ride on error records, so log one to read the profiler's breadcrumbs back.
  getLogger("blotter").error("blotter report", new Error("This error only carries breadcrumbs."));
  await flush();

  const records = memory.records();
  const probes = probeRows(records);
  const phases = phaseRows(records);
  const carrier = records.filter((record) => record.body === "blotter report").at(-1);
  const crumbs = (
    (carrier?.attributes.breadcrumbs ?? []) as { category: string; message: string }[]
  )
    .filter((crumb) => crumb.category === "profile")
    .map((crumb) => crumb.message);

  const fixed = (value: number): string => value.toFixed(3);
  fillTable(
    "probe-table",
    ["probe", "count", "sum", "p50", "p99", "max", "self p99"],
    probes.map((row) => [
      row.probe,
      String(row.count),
      fixed(row.sum),
      fixed(row.p50),
      fixed(row.p99),
      fixed(row.max),
      row.selfP99 === null ? "none" : fixed(row.selfP99),
    ]),
  );
  fillTable(
    "phase-table",
    ["probe", "phase", "count", "sum"],
    phases.map((row) => [row.probe, row.phase, String(row.count), fixed(row.sum)]),
  );
  element("crumbs").textContent = crumbs.join("\n");
  element("result-json").textContent = JSON.stringify(
    {
      userAgent: navigator.userAgent,
      rows: body.children.length,
      probes,
      phases,
      crumbs,
      diagnostics: [...diagnostics],
    },
    null,
    2,
  );
}

/**
 * Runs one action, waits for its paint and shows the records.
 * @param name Text for the status line.
 * @param action The action to run.
 */
async function run(name: string, action: () => unknown): Promise<void> {
  document.title = "running";
  status.textContent = `Running. ${name}`;

  try {
    await action();
    await settle();
    await report();
    document.title = "done";
    status.textContent = `Done. ${name}`;
  } catch (error) {
    document.title = "failed";
    status.textContent = `The page failed. ${String(error)}`;
  }
}

/** Runs every action once, with a paint between actions. */
async function runAll(): Promise<void> {
  await load();
  await settle();
  sortByPrice();
  await settle();
  update();
  await settle();
  thrash();
}

element("blotter-render").addEventListener("click", () => {
  void run("Draw 5,000 rows.", draw);
});
element("blotter-sort").addEventListener("click", () => {
  void run("Sort by price.", sortByPrice);
});
element("blotter-update").addEventListener("click", () => {
  void run("Update 500 rows.", update);
});
element("blotter-thrash").addEventListener("click", () => {
  void run("Read 100 row heights.", thrash);
});
element("blotter-load").addEventListener("click", () => {
  void run("Load rows later.", load);
});
element("blotter-all").addEventListener("click", () => {
  void run("Each action.", runAll);
});

orders = makeOrders();

if (new URLSearchParams(location.search).get("autorun") === "1") {
  void run("Each action.", runAll);
} else {
  draw();
}

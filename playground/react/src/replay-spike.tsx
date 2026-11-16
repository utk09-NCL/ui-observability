// playground/react/src/replay-spike.tsx
//
// Session replay example and measurement. The page draws a 5,000-row blotter and times two
// actions with `replay.enabled` off and on. Then a render error triggers an upload. The page
// keeps the segments in IndexedDB, and replay-viewer.html plays them back. The numbers only
// mean something for this browser and machine.

import {
  configure,
  createMemoryTransport,
  flush,
  type ReplayPluginLoader,
  type ReplaySegment,
} from "@utk09/ui-observability";
import { memo, type ReactElement, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ObservabilityErrorBoundary } from "./observability";
import { listRecordings, saveRecording, STORE_LIMITS } from "./replay-store";

/** Rows in the blotter. */
const ROW_COUNT = 5000;

/** Rows changed by one update. */
const UPDATE_COUNT = 500;

/** Measured runs per action, per mode. */
const RUNS = 30;

/** Runs per action that are thrown away as warmup. */
const WARMUP_RUNS = 5;

/** Symbols for the fake orders. */
const SYMBOLS = ["VOD", "BARC", "HSBA", "AZN", "BP", "GSK", "RIO", "ULVR"];

/** One order in the blotter. */
interface Order {
  id: number;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
}

/** Percentiles and max over a list of runs, in ms. */
interface Spread {
  p50: number;
  p90: number;
  max: number;
}

/** Timings for one action in one mode. */
interface ActionResult {
  /** The state change plus its microtasks. That is where the recorder reads its mutations. */
  script: Spread;
  /** From the state change to the first task after the paint. */
  toPaint: Spread;
}

/** How long the library keeps sending events after an error, in ms. */
const AFTER_ERROR_MS = 1000;

/** How long a partial segment waits before it is sent, in ms. */
const FLUSH_INTERVAL_MS = 500;

/** The memory transport keeps every record in the page, so no logs are sent anywhere. */
const memory = createMemoryTransport();

/** Segments the library has handed to the page. */
let segments: ReplaySegment[] = [];

/** Diagnostic codes the library reported. */
const diagnostics: string[] = [];

/** Resolves once the library has created the plugins. It starts the recorder right after. */
let recorderReady: () => void = () => undefined;

/** Record plugins for the upload run. The app owns every import. */
const uploadPlugins: ReplayPluginLoader[] = [
  // Numbers every event, so a server can prove none went missing.
  async () =>
    (await import("@rrweb/rrweb-plugin-sequential-id-record")).getRecordSequentialIdPlugin(),
  // Warnings and errors only, with short values.
  async () =>
    (await import("@rrweb/rrweb-plugin-console-record")).getRecordConsolePlugin({
      level: ["warn", "error"],
      lengthThreshold: 100,
      stringifyOptions: { stringLengthLimit: 500, numOfKeysLimit: 20, depthOfLimit: 2 },
    }),
  // No headers, no bodies. The library's helper skips its own requests and strips the query.
  async ({ transformRequest }) =>
    (await import("@rrweb/rrweb-plugin-network-record")).getRecordNetworkPlugin({
      initiatorTypes: ["fetch", "xmlhttprequest"],
      recordHeaders: false,
      recordBody: false,
      transformRequestFn: transformRequest,
    }),
];

// At module scope, once, before the first render. An effect would run twice under StrictMode.
configure({
  transport: memory.transport,
  serviceName: "replay-example",
  console: false,
  bus: { mode: "off" },
  // Both the library's network capture and the network plugin wrap fetch.
  capture: { errors: true, rejections: true, fetch: true },
  replay: {
    enabled: false,
    // The recorder only ever loads through this import. The library doesn't ship one.
    loader: () => import("@rrweb/record"),
    // In the playground the page keeps the segments. A real app would set replay.endpoint.
    onSegment: (segment) => {
      segments.push(segment);
    },
    afterErrorMs: AFTER_ERROR_MS,
    flushIntervalMs: FLUSH_INTERVAL_MS,
  },
  onDiagnostic: (event) => {
    if (event.code !== "config.reconfigured") {
      diagnostics.push(event.code);
    }
  },
});

/**
 * Turns session replay on and waits for the recorder.
 * @param plugins Record plugins for this run.
 * @returns Time from the call to the first frame after the recorder started, in ms.
 */
async function replayOn(plugins: ReplayPluginLoader[] = []): Promise<number> {
  const started = performance.now();
  const ready = new Promise<void>((resolve) => {
    recorderReady = resolve;
  });

  configure({
    replay: {
      enabled: true,
      // The library creates the plugins right before it starts the recorder.
      plugins: [
        ...plugins,
        () => {
          recorderReady();
          return { name: "example/ready@1", options: {} };
        },
      ],
    },
  });
  await ready;
  await afterPaint();

  return performance.now() - started;
}

/**
 * Turns session replay off.
 * @returns A promise that resolves once the recorder has stopped.
 */
async function replayOff(): Promise<void> {
  configure({ replay: { enabled: false } });
  await flush();
  await afterPaint();
}

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
    symbol: SYMBOLS[Math.floor(nextRandom() * SYMBOLS.length)] ?? "VOD",
    side: nextRandom() < 0.5 ? "BUY" : "SELL",
    quantity: 100 + Math.floor(nextRandom() * 9900),
    price: Math.round((1 + nextRandom() * 999) * 100) / 100,
  }));
}

/** One row. memo keeps unchanged rows out of the render when an update comes in. */
const Row = memo(function Row({ order }: { order: Order }): ReactElement {
  return (
    <tr>
      <td>{order.id}</td>
      <td>{order.symbol}</td>
      <td>{order.side}</td>
      <td>{order.quantity}</td>
      <td>{order.price.toFixed(2)}</td>
      <td>{(order.quantity * order.price).toFixed(2)}</td>
    </tr>
  );
});

/** Sets the orders from outside the component. The measurement loop uses it. */
let setOrders: (next: Order[]) => void = () => undefined;

/** Makes the blotter throw on its next render. */
let failRender: () => void = () => undefined;

/**
 * The spike's blotter.
 * @returns The table.
 */
function Blotter(): ReactElement {
  const [orders, set] = useState(makeOrders);
  const [failed, setFailed] = useState(false);
  setOrders = set;
  failRender = () => {
    setFailed(true);
  };

  if (failed) {
    throw new Error("The spike failed a render on purpose.");
  }

  return (
    <table>
      <tbody>
        {orders.map((order) => (
          <Row key={order.id} order={order} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * Computes percentiles for a list of durations.
 * @param values Durations in ms.
 * @returns The p50, the p90 and the max.
 */
function spread(values: number[]): Spread {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number): number => sorted[Math.ceil(q * sorted.length) - 1] ?? 0;
  const round = (value: number): number => Math.round(value * 100) / 100;

  return { p50: round(at(0.5)), p90: round(at(0.9)), max: round(sorted.at(-1) ?? 0) };
}

/**
 * Waits for the first task after the next paint.
 * @returns A promise that resolves after the paint.
 */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        resolve();
      };
      channel.port2.postMessage(0);
    });
  });
}

/**
 * Measures one action.
 * @param change Returns the next orders, given the current ones.
 * @param current The orders before the first run.
 * @returns The result, and the orders after the last run.
 */
async function measure(
  change: (orders: Order[]) => Order[],
  current: Order[],
): Promise<{ result: ActionResult; orders: Order[] }> {
  const script: number[] = [];
  const toPaint: number[] = [];
  let orders = current;

  for (let run = 0; run < WARMUP_RUNS + RUNS; run++) {
    const next = change(orders);

    const started = performance.now();
    flushSync(() => {
      setOrders(next);
    });
    // The recorder's mutation observer runs in a microtask, before we get past this await.
    await Promise.resolve();
    const afterScript = performance.now();
    await afterPaint();
    const painted = performance.now();

    orders = next;
    if (run >= WARMUP_RUNS) {
      script.push(afterScript - started);
      toPaint.push(painted - started);
    }
  }

  return { orders, result: { script: spread(script), toPaint: spread(toPaint) } };
}

/**
 * Changes the price of some orders. Every changed order is a new object.
 * @param orders Current orders.
 * @returns The next orders.
 */
function updateSome(orders: Order[]): Order[] {
  const next = [...orders];

  for (let step = 0; step < UPDATE_COUNT; step++) {
    const index = Math.floor(nextRandom() * next.length);
    next[index] = { ...next[index], price: Math.round((1 + nextRandom() * 999) * 100) / 100 };
  }

  return next;
}

/**
 * Reverses the rows, which makes React move every row in the DOM.
 * @param orders Current orders.
 * @returns The next orders.
 */
function reverse(orders: Order[]): Order[] {
  return [...orders].reverse();
}

/**
 * Measures both actions in one mode.
 * @param orders The orders before the first run.
 * @returns The results, and the orders after the last run.
 */
async function measureMode(
  orders: Order[],
): Promise<{ update: ActionResult; sort: ActionResult; orders: Order[] }> {
  const update = await measure(updateSome, orders);
  const sort = await measure(reverse, update.orders);

  return { update: update.result, sort: sort.result, orders: sort.orders };
}

/**
 * Runs the spike and shows the result.
 * @returns A promise that resolves once the result is on the page.
 */
async function runSpike(): Promise<void> {
  const output = document.getElementById("result-json");
  const status = document.getElementById("status");
  if (!output || !status) {
    throw new Error("The page is missing its result elements.");
  }

  document.title = "running";
  status.textContent = "Running. Replay off.";
  await afterPaint();
  const off = await measureMode(makeOrders());

  // The measured runs use no plugins, so they show the cost of the recorder and the buffer alone.
  status.textContent = "Running. Replay on.";
  const startMs = await replayOn();
  const on = await measureMode(off.orders);
  await replayOff();

  // Running with replay off a second time shows how much the page drifts between modes.
  status.textContent = "Running. Replay off again.";
  const offAgain = await measureMode(on.orders);

  // A render error goes through the error boundary to the logger, and the library uploads.
  status.textContent = "Running. Upload after a render error.";
  segments = [];
  await replayOn(uploadPlugins);
  flushSync(() => {
    setOrders(updateSome(offAgain.orders));
  });
  await afterPaint();
  // Text sitting directly in a shadow root, changed after the snapshot. The recorder doesn't
  // mask that in a mutation. The library does.
  const host = document.getElementById("shadow-host");
  const shadowText = document.createTextNode("shadow-first");
  (host?.shadowRoot ?? host?.attachShadow({ mode: "open" }))?.replaceChildren(shadowText);
  await afterPaint();
  shadowText.data = "shadow-secret";
  await afterPaint();

  // One request and one warning give each of the two plugins an event. The network plugin's
  // event shows up later, after the request's resource timing entry.
  await fetch("/replay-spike.html?token=spike-token");
  console.warn("spike warning for the console plugin");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  flushSync(() => {
    failRender();
  });
  // The library sends the events from the live period, then the last partial segment.
  await new Promise((resolve) => setTimeout(resolve, AFTER_ERROR_MS + FLUSH_INTERVAL_MS + 500));
  await replayOff();
  await flush();

  // In the playground, IndexedDB stands in for the replay service.
  const store = await saveRecording(segments);
  const stored = await listRecordings();
  const text = segments.map((segment) => segment.payload).join("");
  const uploaded = segments.flatMap(
    (segment) => JSON.parse(segment.payload) as { _sid?: number; data?: { plugin?: string } }[],
  );
  const pluginEvents = (name: string): number =>
    uploaded.filter((event) => event.data?.plugin === name).length;
  const records = memory.records();

  output.textContent = JSON.stringify(
    {
      userAgent: navigator.userAgent,
      rows: ROW_COUNT,
      updatedRows: UPDATE_COUNT,
      runs: RUNS,
      warmupRuns: WARMUP_RUNS,
      off: { update: off.update, sort: off.sort },
      on: { update: on.update, sort: on.sort },
      offAgain: { update: offAgain.update, sort: offAgain.sort },
      // Time to load the recorder, take the first snapshot and paint one frame.
      replayStartMs: Math.round(startMs * 100) / 100,
      upload: {
        segments: segments.map(({ payload: _payload, ...head }) => head),
        // Every record carries the replay id while the recorder is running.
        errorRecordHasReplayId: records.some(
          (record) =>
            record.severityText === "ERROR" &&
            record.attributes["replay.id"] === segments[0]?.["replay.id"],
        ),
      },
      diagnostics,
      plugins: {
        // The ids have to go up by 1 from the first event of the upload.
        sequentialIdsInOrder: uploaded.every(
          (event, index) => event._sid === (uploaded[0]?._sid ?? 0) + index,
        ),
        consoleEvents: pluginEvents("rrweb/console@1"),
        networkEvents: pluginEvents("rrweb/network@1"),
        tokenOfTheUrlInClear: text.includes("spike-token"),
        // The library's network capture should still see the request underneath the plugin.
        // It adds a breadcrumb, and the error record carries the breadcrumbs.
        libraryHttpBreadcrumbs: records
          .flatMap(
            (record) =>
              (record.attributes.breadcrumbs ?? []) as { category: string; message: string }[],
          )
          .filter((crumb) => crumb.category === "http" && crumb.message.includes("replay-spike"))
          .length,
      },
      store: {
        savedId: store.saved?.id ?? null,
        removed: store.removed,
        recordings: stored.length,
        bytes: stored.reduce((sum, head) => sum + head.bytes, 0),
        limits: STORE_LIMITS,
      },
      masking: {
        // The heading has the unmask attribute. The cells and the password input don't.
        unmaskedHeadingInClear: text.includes("replay spike heading"),
        cellTextInClear: text.includes("BARC") || text.includes("HSBA"),
        passwordInClear: text.includes("spike-secret"),
        hiddenInputInClear: text.includes("hidden-secret"),
        shadowTextInClear: text.includes("shadow-first") || text.includes("shadow-secret"),
      },
    },
    null,
    2,
  );
  document.title = "done";
  status.textContent = "Done.";
}

/**
 * The spike page.
 * @returns Root element.
 */
function SpikePage(): ReactElement {
  return (
    <>
      <h1 data-observability-unmask="">replay spike heading</h1>
      <p>
        The page measures an update of 500 rows and a move of 5,000 rows, with the session replay
        off and on. Then a render error uploads the replay buffer as segments in the console.
      </p>
      <p>
        <button
          type="button"
          onClick={() => {
            void runSpike().catch((error: unknown) => {
              document.title = "failed";
              console.error(error);
            });
          }}
        >
          Run the spike
        </button>{" "}
        <input
          type="password"
          defaultValue="spike-secret"
          aria-label="A password that no replay shows"
        />
      </p>
      <input type="hidden" defaultValue="hidden-secret" />
      <div id="shadow-host" />
      <p id="status">Idle.</p>
      <pre id="result-json"></pre>
      <ObservabilityErrorBoundary fallback={<p>The blotter failed on purpose.</p>}>
        <Blotter />
      </ObservabilityErrorBoundary>
    </>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("replay-spike.html is missing #root");
}

createRoot(container).render(
  <StrictMode>
    <SpikePage />
  </StrictMode>,
);

if (new URLSearchParams(location.search).get("autorun") === "1") {
  void afterPaint().then(runSpike, (error: unknown) => {
    document.title = "failed";
    console.error(error);
  });
}

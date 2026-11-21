// src/observability-settings/hints.ts
//
// The hint catalog. One entry for each setting of the panel: the config key it sets, the value
// that costs less, what that value costs you, and how sure the claim is. The catalog is also the
// map from a setting to its config, so a wrong key name fails hints.test.ts.

import type { LogLevel, ObservabilityConfig } from "@utk09/ui-observability";
import { TRACE_TARGETS, TRACES_ENDPOINT } from "./app-routes";
import type { Settings, SettingKey } from "./settings";

export type Group = "Logging" | "Capture" | "Delivery" | "Privacy and metadata";

/** "runtime" applies through configure() at once. "restart" needs shutdown() and configure(). */
export type Applies = "runtime" | "restart";

/**
 * How sure the claim is. "measured" has a benchmark. "measure here" has a result in the cost
 * meter of this panel. "expected" comes from reading the code and nobody measured it.
 */
export type Evidence = "measured" | "measure here" | "expected";

export interface HintOf<K extends SettingKey> {
  key: K;
  /** The config key that the setting sets. */
  path: string;
  group: Group;
  label: string;
  /** The values that the panel offers. */
  options: readonly Settings[K][];
  /** The value that costs less, or null when no value is known to be cheaper. */
  faster: Settings[K] | null;
  /** What the faster value costs you. */
  cost: string;
  applies: Applies;
  evidence: Evidence;
  /** Why the faster value costs less. */
  why: string;
  /** Unit that the panel prints after a number. */
  unit?: string;
  /** Returns the config that this setting contributes, given all the settings. */
  toConfig: (settings: Settings) => Partial<ObservabilityConfig>;
}

export type Hint = { [K in SettingKey]: HintOf<K> }[SettingKey];

const LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN"];

/**
 * A stable function, because configure() treats a function as the same setting only when it is
 * the same reference. The literal URL form is the one that Vite bundles as a worker.
 * @returns A new module worker.
 */
const createTransportWorker = (): Worker =>
  new Worker(new URL("./transport.worker.ts", import.meta.url), { type: "module" });

/**
 * Click capture and click text are one config key, so both hints use this function. Each of them
 * gives the same capture.interactions value for the same settings.
 * @param s The settings.
 * @returns The capture.interactions part of the config.
 */
function interactionsConfig(s: Settings): Partial<ObservabilityConfig> {
  return { capture: { interactions: s.interactions ? { text: s.interactionText } : false } };
}

/**
 * These two hints are routing settings, so they also go into the routing of each rotation.
 * config.ts calls their toConfig() directly.
 */
export const TRANSPORT_WORKER_HINT: HintOf<"transportWorker"> = {
  key: "transportWorker",
  path: "transportWorker",
  group: "Delivery",
  label: "Transport worker",
  options: [false, true],
  faster: true,
  cost: "The app ships a second copy of the library core for the worker. With the uilogs serializer only metric and span batches use the worker.",
  applies: "restart",
  evidence: "expected",
  why: "The worker encodes, compresses and sends those batches off the main thread.",
  toConfig: (s) => (s.transportWorker ? { transportWorker: createTransportWorker } : {}),
};

export const SPANS_HINT: HintOf<"spans"> = {
  key: "spans",
  path: "tracesEndpoint",
  group: "Delivery",
  label: "Spans",
  options: [true, false],
  faster: false,
  cost: "The backend gets no root, client or measure spans. Records keep their trace id.",
  applies: "restart",
  evidence: "expected",
  why: "Each trace, API call and measure is one more record that is built and sent.",
  toConfig: (s) => ({ tracesEndpoint: s.spans ? TRACES_ENDPOINT : null }),
};

export const HINTS: readonly Hint[] = [
  {
    key: "consoleOutput",
    path: "consoleOutput",
    group: "Logging",
    label: "Console output",
    options: [true, false],
    faster: false,
    cost: "DevTools shows no record lines.",
    applies: "runtime",
    evidence: "measure here",
    why: "Each record that the console prints is formatted and written on the main thread.",
    toConfig: (s) => ({ consoleOutput: s.consoleOutput }),
  },
  {
    key: "minLevel",
    path: "minLevel",
    group: "Logging",
    label: "Lowest level sent",
    options: LEVELS,
    faster: "INFO",
    cost: "The backend gets no DEBUG records. With console output on, DevTools still prints them.",
    applies: "runtime",
    evidence: "measure here",
    why: "A call below the level builds no record and adds no breadcrumb, unless the console prints it.",
    toConfig: (s) => ({ minLevel: s.minLevel }),
  },
  {
    key: "payloadMode",
    path: "payloadMode",
    group: "Logging",
    label: "Payload mode",
    options: ["copy", "defer"],
    faster: "defer",
    cost: "A payload that the app changes after the call shows its new value in the record.",
    applies: "runtime",
    evidence: "measure here",
    why: "With defer most calls only keep a reference, and the library builds the records in idle time. A full queue of 1,000 calls builds inside one call, so the p50 drops and the max shows the stall.",
    toConfig: (s) => ({ payloadMode: s.payloadMode }),
  },
  {
    key: "priceSampling",
    path: "sampling.rates",
    group: "Logging",
    label: "Keep rate of market.prices",
    options: [1, 0.5, 0.1, 0],
    faster: 0.1,
    cost: "The backend gets a part of the price ticks. Each tick still adds a breadcrumb, also a sampled-out tick when a processor is set, so a trail of 50 crumbs holds about 3 seconds. Only the lowest level INFO removes ticks from the trail.",
    applies: "runtime",
    evidence: "expected",
    why: "A sampled-out record isn't sent. With a processor set, the library still builds it for a breadcrumb, so the saving is in delivery.",
    toConfig: (s) => ({ sampling: { rates: { "market.prices": s.priceSampling } } }),
  },
  {
    key: "maxArrayLength",
    path: "limits.maxArrayLength",
    group: "Logging",
    label: "Longest array",
    options: [10, 20, 50, 100, 500],
    faster: 20,
    unit: "items",
    cost: "The record keeps the first items of a longer array, such as a blotter snapshot.",
    applies: "restart",
    evidence: "measure here",
    why: "The sanitizer walks at most this many items of an array.",
    toConfig: (s) => ({ limits: { maxArrayLength: s.maxArrayLength } }),
  },
  {
    key: "maxDepth",
    path: "limits.maxDepth",
    group: "Logging",
    label: "Deepest object",
    options: [2, 3, 4, 6, 8],
    faster: 3,
    unit: "levels",
    cost: "The record cuts the part of an object below that depth.",
    applies: "restart",
    evidence: "measure here",
    why: "The sanitizer stops at this depth.",
    toConfig: (s) => ({ limits: { maxDepth: s.maxDepth } }),
  },
  {
    key: "maxNodes",
    path: "limits.maxNodes",
    group: "Logging",
    label: "Most values in a payload",
    options: [100, 1000, 5000, 10000],
    faster: 1000,
    unit: "values",
    cost: "The record cuts a payload that has more values.",
    applies: "restart",
    evidence: "measure here",
    why: "One sanitize pass stops after this many values. The blotter payload is cut to Longest array first, so set Longest array to 500 before you compare this setting.",
    toConfig: (s) => ({ limits: { maxNodes: s.maxNodes } }),
  },
  {
    key: "diagnosticRecords",
    path: "diagnostics.records",
    group: "Logging",
    label: "Diagnostics as records",
    options: [true, false],
    faster: false,
    cost: "The backend gets no record of the library's own faults. onDiagnostic still runs.",
    applies: "runtime",
    evidence: "expected",
    why: "Each reported diagnostic is built and sent as one more record.",
    toConfig: (s) => ({ diagnostics: { records: s.diagnosticRecords } }),
  },
  {
    key: "webSocket",
    path: "capture.webSocket",
    group: "Capture",
    label: "WebSocket capture",
    options: [true, false],
    faster: false,
    cost: "No open, close and error records, and no message count of the price stream.",
    applies: "runtime",
    evidence: "expected",
    why: "The capture wraps WebSocket and counts every message.",
    toConfig: (s) => ({ capture: { webSocket: s.webSocket } }),
  },
  {
    key: "fetch",
    path: "capture.fetch, capture.httpMetrics",
    group: "Capture",
    label: "Fetch capture",
    options: [true, false],
    faster: false,
    cost: "No request records, no request duration points, no client spans and no traceparent.",
    applies: "runtime",
    evidence: "expected",
    why: "Each fetch is wrapped and timed, and each API call gets a client span.",
    // The trace targets need the fetch capture. Without it the library reports config.invalid.
    toConfig: (s) => ({
      capture: {
        fetch: s.fetch,
        httpMetrics: s.fetch,
        propagateTraceHeaderTo: s.fetch ? TRACE_TARGETS : [],
      },
    }),
  },
  {
    key: "interactions",
    path: "capture.interactions",
    group: "Capture",
    label: "Click capture",
    options: [true, false],
    faster: false,
    cost: "Records carry no click breadcrumbs. A click no longer starts a trace, so an order and its client span share the trace of all earlier records.",
    applies: "runtime",
    evidence: "expected",
    why: "One click listener builds a breadcrumb and starts a new trace for each click.",
    toConfig: interactionsConfig,
  },
  {
    key: "interactionText",
    path: "capture.interactions.text",
    group: "Capture",
    label: "Click text",
    options: [true, false],
    faster: false,
    cost: "Click breadcrumbs carry no text. This is also the safer value, because text can hold personal data.",
    applies: "runtime",
    evidence: "expected",
    why: "The capture reads the text of each clicked element.",
    toConfig: interactionsConfig,
  },
  {
    key: "console",
    path: "capture.console",
    group: "Capture",
    label: "Console capture",
    options: [true, false],
    faster: false,
    cost: "console.error and console.warn calls of the app are not recorded.",
    applies: "runtime",
    evidence: "expected",
    why: "The capture wraps both methods and reads the arguments of each call.",
    toConfig: (s) => ({ capture: { console: s.console } }),
  },
  TRANSPORT_WORKER_HINT,
  {
    key: "compression",
    path: "compression",
    group: "Delivery",
    label: "Compression",
    options: ["gzip", "none"],
    faster: null,
    cost: "gzip sends fewer bytes and spends encode work. none sends more bytes and spends none. No value is known to be faster. A backend that can't decode gzip answers 400, and the library drops the batch.",
    applies: "runtime",
    evidence: "expected",
    why: "The library compresses a body of 1 KiB or more, so a small batch is the same for both.",
    toConfig: (s) => ({ compression: s.compression }),
  },
  {
    key: "logBatchSize",
    path: "batching.logBatchSize",
    group: "Delivery",
    label: "Records in a batch",
    // 500 is the normal maximum of the uilogs server. A request above it gets 413, and the
    // library splits it, see the README.
    options: [10, 50, 100, 250, 500],
    faster: 500,
    unit: "records",
    cost: "A batch waits longer to fill, and a failed batch loses more records. The uilogs server takes 500 records at most in a request.",
    applies: "restart",
    evidence: "expected",
    why: "A larger batch needs fewer requests.",
    toConfig: (s) => ({ batching: { logBatchSize: s.logBatchSize } }),
  },
  {
    key: "logFlushIntervalMs",
    path: "batching.logFlushIntervalMs",
    group: "Delivery",
    label: "Wait of a partial batch",
    options: [500, 2000, 10000],
    faster: 10000,
    unit: "ms",
    cost: "Records reach the backend later, and more of them wait in memory.",
    applies: "restart",
    evidence: "expected",
    why: "A longer wait needs fewer requests.",
    toConfig: (s) => ({ batching: { logFlushIntervalMs: s.logFlushIntervalMs } }),
  },
  {
    key: "storageBackend",
    path: "storage.backend",
    group: "Delivery",
    label: "Store for failed batches",
    options: ["auto", "none"],
    faster: "none",
    cost: "A batch that fails to send is lost at once, and onDrop reports not_stored. An exit batch above about 60 KB is lost too. A 413 from the backend loses the whole batch, because the halves have no place to wait.",
    applies: "restart",
    evidence: "expected",
    why: "With auto, a batch that fails to send waits in storage for a later drain of the same page. This app starts a new security context at each load, so it does not resume a stored batch after a reload.",
    toConfig: (s) => ({ storage: { backend: s.storageBackend } }),
  },
  SPANS_HINT,
  {
    key: "pageUrl",
    path: "metadata.pageUrl",
    group: "Privacy and metadata",
    label: "Page URL on records",
    options: [true, false],
    faster: false,
    cost: "page.url is empty, so a record doesn't say where the user was.",
    applies: "runtime",
    evidence: "expected",
    why: "Each record reads the URL and cuts its query and fragment.",
    toConfig: (s) => ({ metadata: { pageUrl: s.pageUrl } }),
  },
  {
    key: "userAgent",
    path: "metadata.userAgent",
    group: "Privacy and metadata",
    label: "User agent",
    options: [true, false],
    faster: false,
    cost: "The userAgent field of the uilogs body is missing.",
    applies: "runtime",
    evidence: "expected",
    why: "The serializer writes the user agent once for each request, so the body is a little smaller.",
    toConfig: (s) => ({ metadata: { userAgent: s.userAgent } }),
  },
  {
    key: "breadcrumbs",
    path: "captureLimits.breadcrumbs",
    group: "Privacy and metadata",
    label: "Breadcrumbs kept",
    options: [0, 10, 25, 50, 100],
    faster: 10,
    unit: "crumbs",
    cost: "An error record shows fewer events from before the error.",
    applies: "runtime",
    evidence: "expected",
    why: "An error record copies the whole trail.",
    toConfig: (s) => ({ captureLimits: { breadcrumbs: s.breadcrumbs } }),
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges config parts one level deep, because two settings can write into one section, for
 * example capture.fetch and capture.console.
 * @param parts The config of each hint.
 * @returns One config.
 */
function mergeConfigs(parts: Partial<ObservabilityConfig>[]): Partial<ObservabilityConfig> {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      const current = merged[key];
      merged[key] =
        isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
    }
  }

  return merged;
}

/**
 * Builds the config of the settings, for the hints that apply the given way.
 * @param settings The settings to map.
 * @param applies Only the hints that apply this way. Without it, every hint.
 * @returns A config for configure().
 */
export function configFor(settings: Settings, applies?: Applies): Partial<ObservabilityConfig> {
  return mergeConfigs(
    HINTS.filter((hint) => applies === undefined || hint.applies === applies).map((hint) =>
      hint.toConfig(settings),
    ),
  );
}

/**
 * Returns the settings with each faster value of the catalog. A setting without one stays.
 * @param settings The settings to start from.
 * @returns New settings.
 */
export function withFasterValues(settings: Settings): Settings {
  const next = { ...settings };
  for (const hint of HINTS) {
    if (hint.faster !== null) {
      // Reflect.set because hint.key and hint.faster are unions, and TypeScript can't pair them.
      Reflect.set(next, hint.key, hint.faster);
    }
  }

  return next;
}

/**
 * Prints a setting value for the panel.
 * @param value The value.
 * @param unit Unit to add after a number.
 * @returns Text of the value.
 */
export function formatValue(value: boolean | number | string, unit?: string): string {
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }

  return unit ? `${String(value)} ${unit}` : String(value);
}

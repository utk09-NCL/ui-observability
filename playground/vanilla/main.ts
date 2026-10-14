// playground/vanilla/main.ts
//
// Manual test harness. Every button goes through the package's public entry
// point, so a gap in the facade shows up here as a button that cannot be built.

import {
  configure,
  endJourney,
  getDiagnosticCounters,
  getJourneyToken,
  getLogger,
  getQueueDepth,
  startJourney,
  startTrace,
} from "../../src/index";

/** Base URL for the local mock ingest server. */
const MOCK_SERVER = "http://localhost:8787";

/** Target HTTP endpoint for log ingest requests. */
const INGEST_ENDPOINT = `${MOCK_SERVER}/v1/logs`;

/** Number of log records generated in a single test burst. */
const BURST_SIZE = 250;

/** Time that the long frame button blocks the main thread, in milliseconds. */
const LONG_FRAME_MS = 300;

/** Query parameter carrying the journey token to a second window. */
const JOURNEY_PARAM = "__uiobs_journey";

/**
 * Queries a DOM element by selector, throwing if missing.
 * @param selector CSS selector string.
 * @returns Matched DOM element.
 */
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`playground: no element matches ${selector}`);
  }
  return found;
};

/** Diagnostic output container in the playground DOM. */
const out = el("#diagnostics");

/**
 * Prepends a timestamped message to the diagnostics panel.
 * @param code Diagnostic event code.
 * @param message Event description.
 */
const note = (code: string, message: string): void => {
  out.textContent = `${new Date().toISOString()}  ${code}  ${message}\n${out.textContent}`;
};

/**
 * Normalizes caught errors into string messages.
 * @param err Unknown caught error.
 * @returns Formatted message string.
 */
const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Binds a click listener to a DOM element by ID.
 * @param id Element ID without prefix.
 * @param fn Click callback.
 */
const on = (id: string, fn: () => void): void => {
  el(`#${id}`).addEventListener("click", fn);
};

// Storage, transport, retry, the pipeline, the bus, the exit flush and every
// capture module are built by this one call. The runtime registers itself for
// same-origin children synchronously, before it starts anything asynchronous,
// so a child frame that boots first still finds a direct link to it.
configure({
  endpoint: INGEST_ENDPOINT,
  serviceName: "playground",
  serviceVersion: "0.0.0-dev",
  environment: "local",
  minLevel: "DEBUG",
  // Mirrors every record to the devtools console from DEBUG up.
  console: "DEBUG",
  // Reads sampling rules from the X-UiObs-Sampling header of the mock server.
  sampling: { remote: true },
  // Origins allowed to transmit records over the window bus.
  bus: { trustedOrigins: [location.origin, "http://localhost:5174"] },
  capture: {
    errors: true,
    rejections: true,
    resourceErrors: true,
    fetch: true,
    xhr: true,
    interactions: true,
    navigation: true,
    webVitals: true,
    // Literal specifier resolved by the bundler. The library's default loader
    // holds it in a variable so a bundler cannot resolve it at build time,
    // which leaves the browser unable to resolve the bare specifier at runtime.
    webVitalsLoader: () => import("web-vitals"),
    longFrames: true,
    // Records console.error and console.warn. console.info gives a breadcrumb.
    console: ["error", "warn", "info"],
  },
  onDiagnostic: (event) => {
    note(event.code, event.message);
  },
});

/** Namespaced logger for records this harness emits by hand. */
const log = getLogger("playground");

on("info", () => {
  log.info("hello from the playground", { clicked: true });
});

on("action", () => {
  log.logAction("ORDER_SUBMIT", { orderId: "ORD-1001", qty: 100 });
});

on("metric", () => {
  log.logMetric("grid.render", 42.5, "ms", "histogram");
});

on("error", () => {
  log.error("something went wrong", new Error("boom"));
});

on("journey-start", () => {
  const started = startJourney("order-lifecycle");
  note("playground.journey", `started ${started.name} (${started.id})`);
});

on("journey-end", () => {
  endJourney();
  note("playground.journey", "ended");
});

on("open-window", () => {
  const url = new URL("/playground/vanilla/index.html", location.href);
  const token = getJourneyToken();
  if (token) {
    url.searchParams.set(JOURNEY_PARAM, token);
  }

  window.open(url, "_blank");
  note("playground.window", token ? "opened carrying the journey token" : "opened with no journey");
});

on("throw", () => {
  // Triggers uncaught exception to test error auto-capture.
  setTimeout(() => {
    throw new Error("uncaught from a timeout");
  });
});

on("reject", () => {
  // Triggers unhandled rejection to test rejection auto-capture.
  void Promise.reject(new Error("nobody caught me"));
});

on("fetch-500", () => {
  // Sends failing HTTP request to test network auto-capture.
  void fetch(`${MOCK_SERVER}/does-not-exist`)
    .then((res) => {
      note("playground.fetch_done", `mock server answered ${String(res.status)}`);
    })
    .catch((err: unknown) => {
      note("playground.fetch_failed", toMessage(err));
    });
});

on("circular", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  a.el = document.body;

  log.info("circular payload", a);
});

on("long-frame", () => {
  // Blocks the main thread. The long frame capture records ui.long_frame.duration.
  const end = performance.now() + LONG_FRAME_MS;
  while (performance.now() < end) {
    // Wait.
  }
});

on("console-error", () => {
  // The console capture records this call as an ERROR record.

  console.error("grid failed to render", new Error("row 7 has no id"), { grid: "blotter" });
});

on("burst", () => {
  // Generates records exceeding batch capacity to verify buffer splitting.
  for (let i = 0; i < BURST_SIZE; i++) {
    // Rotates the trace id per record: sampling keys on it, so without this all
    // 250 share one key and a rate keeps or drops the whole burst.
    startTrace();

    log.debug(`burst ${String(i)}`, { i });
  }

  // Sampling evaluates synchronously inside the log call. The counter is typed
  // as a number but the key is absent until a record is dropped, so a widened
  // read is what keeps this line from printing "total undefined".
  const counters: Record<string, number | undefined> = getDiagnosticCounters();
  const dropped = counters["record.dropped_by_sampling"] ?? 0;
  note(
    "playground.burst",
    `pushed ${String(BURST_SIZE)}, record.dropped_by_sampling total ${String(dropped)}`,
  );
});

/** Tracks whether the mock server sends sampling rules. */
let remoteSampling = false;

on("remote-sampling", () => {
  remoteSampling = !remoteSampling;
  // Keeps 10% of the "playground" records for one minute. The next accepted batch carries the rules.
  const rules = remoteSampling ? '{"v":1,"ttlMs":60000,"rates":{"playground":0.1}}' : "";
  const control = `${MOCK_SERVER}/__sampling?rules=${encodeURIComponent(rules)}`;

  void fetch(control, { method: "POST" })
    .then(() => {
      note("playground.remote_sampling", `server sends sampling rules: ${String(remoteSampling)}`);
    })
    .catch((err: unknown) => {
      note("playground.control_failed", toMessage(err));
    });
});

on("queue", () => {
  getQueueDepth()
    .then((waiting) => {
      note("playground.queue", `${String(waiting)} batch(es) waiting in storage`);
    })
    .catch((error: unknown) => {
      note("playground.queue_failed", toMessage(error));
    });
});

/** Tracks mock server failure simulation state. */
let failing = false;

on("offline", () => {
  failing = !failing;
  const control = `${MOCK_SERVER}/__control?status=${failing ? "503&retryAfter=3" : "200"}`;

  void fetch(control, { method: "POST" })
    .then(() => {
      note("playground.server_forced", `server forced failure: ${String(failing)}`);
    })
    .catch((err: unknown) => {
      note("playground.control_failed", toMessage(err));
    });
});

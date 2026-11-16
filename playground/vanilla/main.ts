// playground/vanilla/main.ts
//
// Manual test harness. Every button goes through the package's public entry
// point, so a gap in the facade shows up here as a button that cannot be built.

import {
  configure,
  endJourney,
  flush,
  getDiagnosticCounters,
  getJourneyToken,
  getLogger,
  getQueueDepth,
  profiler,
  registerFrame,
  startJourney,
  startMeasure,
  startTrace,
} from "../../src/index";

/** Base URL for the local mock ingest server. */
const MOCK_SERVER = "http://localhost:8787";

/** Endpoint the log batches are posted to. */
const INGEST_ENDPOINT = `${MOCK_SERVER}/v1/logs`;

/** The page picks the transport before the delivery stack loads. */
const workerEnabled = new URLSearchParams(location.search).get("worker") === "1";
const transportWorker = workerEnabled
  ? () => new Worker(new URL("./transport-worker.ts", import.meta.url), { type: "module" })
  : undefined;

/** How long each phase of the sample measure lasts. */
const MEASURE_PHASE_MS = 50;

/** Number of log records in one test burst. */
const BURST_SIZE = 250;

/** How long the long frame button blocks the main thread, in milliseconds. */
const LONG_FRAME_MS = 300;

/** Query parameter that carries the journey token to a second window. */
const JOURNEY_PARAM = "__uiobs_journey";

/** How many spans the profiler button measures. */
const PROFILER_SPANS = 10_000;

/** How many values each measured sort orders. */
const SORT_ROWS = 32;

/**
 * Finds an element by selector and throws if it is missing.
 * @param selector CSS selector.
 * @returns The element.
 */
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`playground: no element matches ${selector}`);
  }
  return found;
};

/** The panel where diagnostics are shown. */
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
 * Turns a caught error into a message string.
 * @param err Whatever was caught.
 * @returns The message.
 */
const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Adds a click listener to the element with the given id.
 * @param id Element id, without the "#".
 * @param fn Click callback.
 */
const on = (id: string, fn: () => void): void => {
  el(`#${id}`).addEventListener("click", fn);
};

// You can create a probe before configure(). It measures nothing until the profiler checkbox
// turns the profiler on.
const sortProbe = profiler.probe("grid.sort", { sampleEvery: 1 });

// This one call builds storage, transport, retry, the pipeline, the bus, the exit flush and
// every capture module. The child frames load later, once they are registered. See the
// registration block below.
configure({
  endpoint: INGEST_ENDPOINT,
  transportWorker,
  tracesEndpoint: `${MOCK_SERVER}/v1/traces`,
  serviceName: "playground",
  serviceVersion: "0.0.0-dev",
  environment: "local",
  minLevel: "DEBUG",
  // Mirrors every record to the devtools console from DEBUG up.
  console: "DEBUG",
  // Reads sampling rules from the mock server's X-UiObs-Sampling header.
  sampling: { remote: true },
  capture: {
    errors: true,
    rejections: true,
    resourceErrors: true,
    fetch: true,
    xhr: true,
    propagateTraceHeaderTo: [MOCK_SERVER],
    // Records ui.rage_click and ui.dead_click with the action name only.
    interactions: { rageClicks: true, deadClicks: true },
    navigation: true,
    webVitals: true,
    // Literal specifier resolved by the bundler. The library's default loader
    // holds it in a variable so a bundler cannot resolve it at build time,
    // which leaves the browser unable to resolve the bare specifier at runtime.
    webVitalsLoader: () => import("web-vitals"),
    longFrames: true,
    // Records console.error and console.warn. console.info becomes a breadcrumb.
    console: ["error", "warn", "info"],
    // Reports WARN ui.unclean_exit when this tab's previous page crashed.
    uncleanExit: true,
    // Records performance.measure() calls whose names start with "playground.".
    userTiming: true,
    userTimingInclude: [/^playground\./],
  },
  onDiagnostic: (event) => {
    note(event.code, event.message);
  },
});

// By default the bus only accepts records from registered frames, so register every frame with
// its exact origin. The child starts journeys and reads journeys and remote sampling, so grant
// those too.
const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-src]")];
for (const frame of frames) {
  registerFrame(frame, {
    origin: new URL(frame.dataset.src ?? "", location.href).origin,
    permissions: ["records", "journey:read", "journey:write", "sampling:read"],
  });
}

// Load the frames after startup, once the registrations are active. A frame that starts earlier
// finds no owner and sends its own records.
void flush().then(() => {
  for (const frame of frames) {
    frame.src = frame.dataset.src ?? "";
  }
});

/** Namespaced logger for records this harness emits by hand. */
const log = getLogger("playground");

for (const name of ["serverTiming", "reports", "resourceTiming", "lifecycle"] as const) {
  const input = el(`#capture-${name}`) as HTMLInputElement;
  input.addEventListener("change", () => {
    configure({ capture: { [name]: input.checked } });
  });
}

const remoteCaptures = el("#capture-remote") as HTMLInputElement;
remoteCaptures.addEventListener("change", () => {
  configure({
    capture: { remoteToggles: remoteCaptures.checked ? ["serverTiming", "lifecycle"] : [] },
  });
});

const profilerEnabled = el("#profiler-enabled") as HTMLInputElement;
profilerEnabled.addEventListener("change", () => {
  configure({ profiler: { enabled: profilerEnabled.checked } });
});

const replayEnabled = el("#replay-enabled") as HTMLInputElement;
replayEnabled.addEventListener("change", () => {
  configure({
    replay: {
      enabled: replayEnabled.checked,
      endpoint: `${MOCK_SERVER}/v1/replay`,
      // The app owns the recorder import. The library doesn't ship a recorder.
      loader: () => import("@rrweb/record"),
    },
  });
});

on("server-timing", () => {
  void fetch(`${MOCK_SERVER}/__timing`)
    .then(() => flush())
    .catch((error: unknown) => {
      note("playground.request_failed", toMessage(error));
    });
});

on("remote-captures", () => {
  const rules = JSON.stringify({
    v: 1,
    ttlMs: 10000,
    capture: { serverTiming: true, lifecycle: true },
  });
  void fetch(`${MOCK_SERVER}/__sampling?rules=${encodeURIComponent(rules)}`, { method: "POST" })
    .then(async () => {
      log.info("Request remote capture rules");
      await flush();
      await fetch(`${MOCK_SERVER}/__sampling?rules=`, { method: "POST" });
      note("playground.remote_captures", "The server enables permitted captures for 10 seconds.");
    })
    .catch((error: unknown) => {
      note("playground.control_failed", toMessage(error));
    });
});

const deferPayloads = el("#payload-defer") as HTMLInputElement;
deferPayloads.addEventListener("change", () => {
  configure({ payloadMode: deferPayloads.checked ? "defer" : "copy" });
});

on("payload-mutation", () => {
  const payload = { status: "before" };
  log.info("Payload mode sample", payload);
  payload.status = "after";
});

on("info", () => {
  log.info("hello from the playground", { clicked: true });
});

on("action", () => {
  log.logAction("ORDER_SUBMIT", { orderId: "ORD-1001", qty: 100 });
});

on("start-measure", () => {
  const measure = startMeasure("checkout", { channel: "playground" });
  measure.phase("validate");
  setTimeout(() => {
    measure.phase("submit");
    setTimeout(() => {
      measure.end();
      void flush();
    }, MEASURE_PHASE_MS);
  }, MEASURE_PHASE_MS);
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
  // An uncaught exception, to test error auto-capture.
  setTimeout(() => {
    throw new Error("uncaught from a timeout");
  });
});

on("reject", () => {
  // An unhandled rejection, to test rejection auto-capture.
  void Promise.reject(new Error("nobody caught me"));
});

on("fetch-500", () => {
  // A failing HTTP request, to test network auto-capture.
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
  // Blocks the main thread so the long frame capture records ui.long_frame.duration.
  const end = performance.now() + LONG_FRAME_MS;
  while (performance.now() < end) {
    // Wait.
  }
});

on("measure", () => {
  // The user timing capture records this measure as ui.user_timing.duration.
  performance.mark("playground.work.start");
  const end = performance.now() + 20;
  while (performance.now() < end) {
    // Wait.
  }
  performance.measure("playground.work", "playground.work.start");
});

on("profiler-run", () => {
  // The probe times every sort. flush() then sends the summary record so the mock server prints it.
  for (let i = 0; i < PROFILER_SPANS; i++) {
    // A different unsorted array for every span. Only the sort itself is timed.
    const rows = Array.from({ length: SORT_ROWS }, (_, k) => (i * 31 + k * 17) % 97);
    const token = sortProbe.begin();
    rows.sort((a, b) => a - b);
    sortProbe.end(token);
  }

  void flush();
  note(
    "playground.profiler",
    profilerEnabled.checked
      ? `${String(PROFILER_SPANS)} sorts measured. The server prints ui.profile.duration.`
      : "With the profiler off, the probe records nothing. Tick the box and run again.",
  );
});

on("console-error", () => {
  // The console capture records this call as an ERROR record.

  console.error("grid failed to render", new Error("row 7 has no id"), { grid: "blotter" });
});

on("burst", () => {
  // More records than one batch holds, to check that the buffer splits them.
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

/** Whether the mock server is sending sampling rules. */
let remoteSampling = false;

on("remote-sampling", () => {
  remoteSampling = !remoteSampling;
  // Keeps 10% of the "playground" records for one minute. The rules go out with the next
  // accepted batch.
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

/** Whether the mock server is simulating failures. */
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

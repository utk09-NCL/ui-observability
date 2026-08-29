// playground/vanilla/main.ts
//
// Manual test harness assembling internal modules ahead of public logger facades.

import { Bus } from "../../src/bus/bus";
import type { Receive } from "../../src/bus/links";
import { ErrorCapture } from "../../src/capture/errors";
import { InteractionCapture } from "../../src/capture/interactions";
import { NetworkCapture } from "../../src/capture/network";
import type { Capture, CaptureLogger } from "../../src/capture/types";
import { WebVitalsCapture } from "../../src/capture/web-vitals";
import { RUNTIME_GLOBAL_KEY } from "../../src/constants";
import { BreadcrumbBuffer } from "../../src/core/breadcrumbs";
import { resolveConfig } from "../../src/core/config";
import { ContextStore } from "../../src/core/context";
import { Diagnostics } from "../../src/core/diagnostics";
import { JourneyEngine } from "../../src/core/journey";
import { LogPipeline } from "../../src/core/pipeline";
import { type BuildInput, RecordBuilder } from "../../src/core/record";
import type { BusMessage } from "../../src/models/bus";
import { drainEmergencyQueue } from "../../src/storage/emergency-queue";
import { createStorage } from "../../src/storage/factory";
import { ExitFlush } from "../../src/transport/exit-flush";
import { HttpTransport } from "../../src/transport/http-transport";
import { RetryEngine } from "../../src/transport/retry-engine";
import { resolveIdentity } from "../../src/utils/identity";
import { detectPlatform } from "../../src/utils/platform";
import { Sequence } from "../../src/utils/sequence";
import { TraceEngine } from "../../src/utils/tracing";

/** Base URL for the local mock ingest server. */
const MOCK_SERVER = "http://localhost:8787";

/** Target HTTP endpoint for log ingest requests. */
const INGEST_ENDPOINT = `${MOCK_SERVER}/v1/logs`;

/** Number of log records generated in a single test burst. */
const BURST_SIZE = 250;

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

/** Central diagnostics instance for internal error reporting. */
const diagnostics = new Diagnostics((event) => {
  note(event.code, event.message);
});

/** Resolved runtime configuration for the playground harness. */
const config = resolveConfig(
  {
    endpoint: INGEST_ENDPOINT,
    serviceName: "playground",
    serviceVersion: "0.0.0-dev",
    environment: "local",
    minLevel: "DEBUG",
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
      // Literal specifier resolved by Vite. The library's default loader holds
      // it in a variable so a bundler cannot resolve it at build time, which
      // leaves the browser unable to resolve the bare specifier at runtime.
      webVitalsLoader: () => import("web-vitals"),
    },
  },
  diagnostics,
);

/** Identity metadata containing context, session, and tab identifiers. */
const identity = resolveIdentity(diagnostics);

/** Platform runtime metadata identifying browser and container capabilities. */
const platform = detectPlatform(diagnostics);

/** Active cross-realm communication bus instance. */
let bus: Bus | null = null;

/** Journey tracking engine managing active task correlation. */
const journey = new JourneyEngine(config.journey, diagnostics, identity.contextId, (changed) => {
  bus?.broadcastJourney(changed);
});

// Registered before storage initialization so booting same-origin children find the direct link.
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for(RUNTIME_GLOBAL_KEY)] = {
  busAccept: (message: BusMessage, reply: Receive): void => {
    bus?.acceptDirect(message, reply);
  },
};

/** Ambient distributed trace context engine. */
const tracing = new TraceEngine(diagnostics);

/** Record builder for assembling structured log records. */
const builder = new RecordBuilder({
  config,
  diagnostics,
  context: new ContextStore(),
  journey,
  tracing,
  sequence: new Sequence(),
  identity,
  platform,
});

/** HTTP transport instance for live log delivery. */
const transport = new HttpTransport(config, diagnostics);

// Top-level await prevents logging before storage initialization resolves.
const storage = await createStorage(
  config.storage.strategy,
  config.storage.dbName,
  config.storage,
  diagnostics,
);
note("playground.storage", `offline queue is ${storage.name}`);

// Recovers oversized batches parked in emergency storage during previous shutdown.
drainEmergencyQueue(storage, diagnostics)
  .then((recovered) => {
    if (recovered > 0) {
      note("playground.recovered", `${String(recovered)} batch(es) from the last close`);
    }
  })
  .catch((error: unknown) => {
    note("playground.recover_failed", toMessage(error));
  });

/** Background retry engine for redelivering failed offline batches. */
const retry = new RetryEngine(storage, transport, diagnostics, config);
retry.start();

/** Primary log pipeline managing stream buffering, batching, and delivery. */
const pipeline = new LogPipeline(config, transport, storage, retry, diagnostics);

bus = new Bus(config, diagnostics, platform, identity.contextId, identity.tabId, {
  // Forwards incoming child records into this document's pipeline, so one
  // request carries the child's records and the parent's together.
  onRecords: (records) => {
    for (const record of records) {
      pipeline.push(record);
    }
  },
  onJourney: (incoming) => {
    journey.applyRemote(incoming);
  },
  onJourneyRequest: () => journey.current(),
  onTabConflict: () => {
    note("playground.tab_conflict", "another window claimed this tab id");
  },
});

bus
  .start()
  .then((role) => {
    note("playground.bus", `role is ${role}`);
  })
  .catch((error: unknown) => {
    note("playground.bus_failed", toMessage(error));
  });

/** Exit flush handler executing atomic batch delivery during page unload. */
const exitFlush = new ExitFlush({
  config,
  diagnostics,
  drainPending: () => pipeline.drainPending(),
});
exitFlush.install();

/**
 * Builds and pushes a log record through the pipeline.
 * @param input Build options and payload.
 * @param label Action label for drop reporting.
 */
const log = (input: BuildInput, label: string): void => {
  const record = builder.build(input);
  if (record === null) {
    note("playground.dropped", `${label} produced no record`);
    return;
  }

  pipeline.push(record);
};

/** Circular buffer for storing contextual user breadcrumbs. */
const breadcrumbs = new BreadcrumbBuffer(config.capture.maxBreadcrumbs);

/** Minimal logger facade adapter routing auto-capture records through the harness. */
const captureLogger: CaptureLogger = {
  error: (message, error, payload) => {
    log(
      {
        level: "ERROR",
        type: "event",
        body: message,
        namespace: "capture",
        payload: { ...payload, error, breadcrumbs: breadcrumbs.snapshot() },
      },
      "capture.error",
    );
  },
  warn: (message, payload) => {
    log(
      {
        level: "WARN",
        type: "event",
        body: message,
        namespace: "capture",
        payload,
      },
      "capture.warn",
    );
  },
  logEvent: (name, payload) => {
    log(
      {
        level: "INFO",
        type: "event",
        body: name,
        namespace: "capture",
        payload,
      },
      "capture.event",
    );
  },
  logMetric: (name, value, unit, type, attrs) => {
    log(
      {
        level: "INFO",
        type: "metric",
        body: name,
        namespace: "capture",
        payload: {
          "metric.value": value,
          "metric.unit": unit,
          "metric.type": type,
          ...attrs,
        },
      },
      "capture.metric",
    );
  },
  debug: (message, payload) => {
    log(
      {
        level: "DEBUG",
        type: "event",
        body: message,
        namespace: "capture",
        payload,
      },
      "capture.debug",
    );
  },
};

/** Context object bundling dependencies for auto-capture modules. */
const captureContext = {
  config,
  diagnostics,
  logger: captureLogger,
  breadcrumbs,
  tracing,
};

/** Registered auto-capture instrumentation modules. */
const captures: Capture[] = [
  new ErrorCapture(captureContext),
  new NetworkCapture(captureContext),
  new InteractionCapture(captureContext),
  new WebVitalsCapture(captureContext),
];

for (const capture of captures) {
  capture.install();
}
note("playground.capture", `installed ${captures.map((c) => c.name).join(", ")}`);

// Adopts URL-seeded journey token before initial records are built.
journey.bootstrap().catch((error: unknown) => {
  note("playground.bootstrap_failed", toMessage(error));
});

on("info", () => {
  log(
    {
      level: "INFO",
      type: "event",
      body: "hello from the playground",
      namespace: "playground",
      payload: { clicked: true },
    },
    "info",
  );
});

on("action", () => {
  log(
    {
      level: "INFO",
      type: "action",
      body: "ORDER_SUBMIT",
      namespace: "playground",
      payload: { orderId: "ORD-1001", qty: 100 },
    },
    "logAction",
  );
});

on("metric", () => {
  // Final form: log.logMetric("grid.render", 42.5, "ms", "histogram")
  log(
    {
      level: "INFO",
      type: "metric",
      body: "grid.render",
      namespace: "playground",
      payload: { value: 42.5, unit: "ms", metric: "histogram" },
    },
    "logMetric",
  );
});

on("error", () => {
  log(
    {
      level: "ERROR",
      type: "event",
      body: "something went wrong",
      namespace: "playground",
      payload: { error: new Error("boom") },
    },
    "logger.error",
  );
});

on("journey-start", () => {
  const started = journey.start("order-lifecycle");
  note("playground.journey", `started ${started.name} (${started.id})`);
});

on("journey-end", () => {
  journey.end();
  note("playground.journey", "ended");
});

on("open-window", () => {
  const url = new URL("/playground/vanilla/index.html", location.href);
  const token = journey.getToken();
  if (token) {
    url.searchParams.set(config.journey.urlParam, token);
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

  log(
    {
      level: "INFO",
      type: "event",
      body: "circular payload",
      namespace: "playground",
      payload: a,
    },
    "circular",
  );
});

on("burst", () => {
  // Generates records exceeding batch capacity to verify buffer splitting.
  for (let i = 0; i < BURST_SIZE; i++) {
    // Rotates the trace id per record: sampling keys on it, so without this all
    // 250 share one key and a rate keeps or drops the whole burst.
    tracing.rotate("explicit");

    log(
      {
        level: "DEBUG",
        type: "event",
        body: `burst ${String(i)}`,
        namespace: "playground",
        payload: { i },
      },
      "burst",
    );
  }

  // Sampling evaluates synchronously during push().
  const dropped = diagnostics.snapshot()["record.dropped_by_sampling"];
  note(
    "playground.burst",
    `pushed ${String(BURST_SIZE)}, record.dropped_by_sampling total ${String(dropped)}`,
  );
});

on("queue", () => {
  storage
    .count()
    .then((waiting) => {
      note("playground.queue", `${String(waiting)} batch(es) waiting in ${storage.name}`);
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

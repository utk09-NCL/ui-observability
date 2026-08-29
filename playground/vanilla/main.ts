// playground/vanilla/main.ts
//
// Manual test harness assembling internal modules ahead of public logger facades.

import { Bus } from "../../src/bus/bus";
import type { Receive } from "../../src/bus/links";
import { RUNTIME_GLOBAL_KEY } from "../../src/constants";
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

const MOCK_SERVER = "http://localhost:8787";
const INGEST_ENDPOINT = `${MOCK_SERVER}/v1/logs`;
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

const diagnostics = new Diagnostics((event) => {
  note(event.code, event.message);
});

const config = resolveConfig(
  {
    endpoint: INGEST_ENDPOINT,
    serviceName: "playground",
    serviceVersion: "0.0.0-dev",
    environment: "local",
    minLevel: "DEBUG",
    // Origins allowed to transmit records over the window bus.
    bus: { trustedOrigins: [location.origin, "http://localhost:5174"] },
  },
  diagnostics,
);

const identity = resolveIdentity(diagnostics);
const platform = detectPlatform(diagnostics);

// Assigned below: the journey engine is built first because the bus handlers
// read it. A journey change made here is broadcast to every other context.
let bus: Bus | null = null;

const journey = new JourneyEngine(config.journey, diagnostics, identity.contextId, (changed) => {
  bus?.broadcastJourney(changed);
});

// Registered before the storage await below: a same-origin child looks for this
// symbol as it boots, and finding nothing it falls back to a postMessage
// handshake. The closure reads `bus` when called, not now.
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for(RUNTIME_GLOBAL_KEY)] = {
  busAccept: (message: BusMessage, reply: Receive): void => {
    bus?.acceptDirect(message, reply);
  },
};

const tracing = new TraceEngine(diagnostics);

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

const retry = new RetryEngine(storage, transport, diagnostics, config);
retry.start();

const pipeline = new LogPipeline(config, transport, storage, retry, diagnostics);

bus = new Bus(config, diagnostics, platform, identity.contextId, identity.tabId, {
  // A forwarded record joins this document's own pipeline, so one request
  // carries the child's records and the parent's together.
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
    // Sampling keys on the ambient trace id. Without a rotation per record
    // all 250 share one key and the rate keeps or drops the whole burst.
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

// Toggles mock server 503 responses to verify offline storage and retries.
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

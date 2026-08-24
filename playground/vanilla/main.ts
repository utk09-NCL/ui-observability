// playground/vanilla/main.ts
//
// The development harness for the library in ../../src, and the only thing here
// that imports the source tree rather than the built package. The framework
// examples must not: they exist to prove the published API works from outside.
//
// The wiring below is temporary. There is no public API and no pipeline yet, so
// this file assembles the pieces by hand and posts one batch per click. When
// the runtime lands, all of it collapses into `configure()` and a logger, and
// every deep import here goes away.
//
// Handlers that still need code which does not exist print what they wait for
// and carry a `// Final form:` comment.

import { resolveConfig } from "../../src/core/config";
import { ContextStore } from "../../src/core/context";
import { Diagnostics } from "../../src/core/diagnostics";
import { JourneyEngine } from "../../src/core/journey";
import { type BuildInput, RecordBuilder } from "../../src/core/record";
import type { LogBatch } from "../../src/models/batch";
import type { LogRecord } from "../../src/models/log-record";
import { HttpTransport } from "../../src/transport/http-transport";
import { newId, resolveIdentity } from "../../src/utils/identity";
import { detectPlatform } from "../../src/utils/platform";
import { Sequence } from "../../src/utils/sequence";
import { TraceEngine } from "../../src/utils/tracing";

const MOCK_SERVER = "http://localhost:8787";
const INGEST_ENDPOINT = `${MOCK_SERVER}/v1/logs`;
const BURST_SIZE = 250;

// A missing element means the harness is broken, so name the selector and fail
// loudly. A non-null assertion instead surfaces as "cannot read properties of
// null" on the first click, pointing at the symptom.
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`playground: no element matches ${selector}`);
  }
  return found;
};

const out = el("#diagnostics");

const note = (code: string, message: string) => {
  out.textContent = `${new Date().toISOString()}  ${code}  ${message}\n${out.textContent}`;
};

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const on = (id: string, fn: () => void) => {
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
    // DEBUG so the burst below actually reaches the wire.
    minLevel: "DEBUG",
    // The receiver decides whose bus messages it believes. The cross-origin
    // child cannot read window.parent, so it forwards over postMessage, and an
    // origin missing from this list is rejected with bus.untrusted_origin.
    bus: { trustedOrigins: [location.origin, "http://localhost:5174"] },
  },
  diagnostics,
);

const identity = resolveIdentity(diagnostics);
const platform = detectPlatform(diagnostics);
// No bus yet, so a journey change has nowhere to be announced.
const journey = new JourneyEngine(config.journey, diagnostics, identity.contextId, () => undefined);

const builder = new RecordBuilder({
  config,
  diagnostics,
  context: new ContextStore(),
  journey,
  tracing: new TraceEngine(diagnostics),
  sequence: new Sequence(),
  identity,
  platform,
});

const transport = new HttpTransport(config, diagnostics);

/** One batch per click. Batching, storage and retry all belong to the pipeline, which does not exist. */
const post = (records: LogRecord[], label: string) => {
  if (records.length === 0) {
    note("playground.dropped", `${label} produced no record`);
    return;
  }

  const batch: LogBatch = { id: newId(), records, createdAt: Date.now(), attempts: 0 };
  transport
    .send(batch)
    .then(() => {
      note("playground.sent", `${label}: ${String(records.length)} record(s) as ${batch.id}`);
    })
    .catch((error: unknown) => {
      note("playground.send_failed", `${label}: ${toMessage(error)}`);
    });
};

const build = (input: BuildInput): LogRecord[] => {
  const record = builder.build(input);
  return record === null ? [] : [record];
};

const log = (input: BuildInput, label: string) => {
  post(build(input), label);
};

// A journey seeded into this document's URL is adopted before the first record
// is built, so the second window's records carry the first window's journey.
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
  // The metric fields are a payload here. The public API names them.
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
  // Live. Reaches the browser console and stops there until error capture
  // turns an uncaught throw into a record.
  setTimeout(() => {
    throw new Error("uncaught from a timeout");
  });
});
on("reject", () => {
  // Live. Same as above, waiting on rejection capture.
  void Promise.reject(new Error("nobody caught me"));
});
on("fetch-500", () => {
  // Live: hits the mock server directly. Network capture is what wraps
  // window.fetch and turns the failed response into a record.
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
    { level: "INFO", type: "event", body: "circular payload", namespace: "playground", payload: a },
    "circular",
  );
});

on("burst", () => {
  // One batch of 250 rather than 250 requests. Coalescing them on a timer is
  // the pipeline's job, and the durable queue is what survives a server that
  // is refusing writes.
  const records: LogRecord[] = [];
  for (let i = 0; i < BURST_SIZE; i++) {
    records.push(
      ...build({
        level: "DEBUG",
        type: "event",
        body: `burst ${String(i)}`,
        namespace: "playground",
        payload: { i },
      }),
    );
  }

  post(records, "burst");
});

// Drives the mock server's control plane end to end. This is how you make the
// server refuse writes to test durability.
let failing = false;
on("offline", () => {
  failing = !failing;
  const control = `${MOCK_SERVER}/__control?status=${failing ? "503&retryAfter=3" : "200"}`;
  // Not an async handler: addEventListener takes a void-returning listener, so
  // an async one leaves a floating promise that swallows rejections, which
  // no-misused-promises rejects. The chain is the same behaviour without it.
  void fetch(control, { method: "POST" })
    .then(() => {
      note("playground.server_forced", `server forced failure: ${String(failing)}`);
    })
    .catch((err: unknown) => {
      note("playground.control_failed", toMessage(err));
    });
});

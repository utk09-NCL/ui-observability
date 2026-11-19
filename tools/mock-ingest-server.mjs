// tools/mock-ingest-server.mjs
// Run:     node tools/mock-ingest-server.mjs
//          UIOBS_MOCK_PORT=8791 UIOBS_MOCK_RECORD=1 node tools/mock-ingest-server.mjs
// Env:     UIOBS_MOCK_PORT    Port. Default 8787, and every example posts to 8787.
//          UIOBS_MOCK_RECORD  Set to 1 to keep each request for GET /__received.
// Control: curl -X POST "http://localhost:8787/__control?status=429&retryAfter=5"
//          curl -X POST "http://localhost:8787/__control?status=200"
// Tests:   curl -X POST "http://localhost:8787/__reset"
//          curl "http://localhost:8787/__received"   (empty without UIOBS_MOCK_RECORD=1)
//          curl "http://localhost:8787/__echo"

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

const DEFAULT_PORT = 8787;
// The browser tests start their own copy on another port, so a running playground keeps 8787.
// A PORT exported for another project would move this server off 8787, so the name isn't PORT.
const PORT = Number(process.env.UIOBS_MOCK_PORT) || DEFAULT_PORT;
// Only the browser tests read /__received, so only they turn this on. A playground that kept
// every parsed replay body grew to gigabytes.
const RECORD = process.env.UIOBS_MOCK_RECORD === "1";
// Oldest entries leave first, so /__received never holds more than this many per path.
const MAX_RECEIVED_PER_PATH = 100;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174", // a second origin, for cross-origin iframe testing
  "http://127.0.0.1:5174", // same machine, different origin to the browser
  // The example workspaces, each on its own port. An origin missing here fails
  // the preflight, and the example logs nothing while looking correctly wired.
  "http://localhost:5180", // react
  "http://localhost:4200", // angular
  "http://localhost:5191", // microfrontend host
  "http://localhost:5192", // microfrontend remote, blotter
  "http://localhost:5193", // microfrontend remote, ticket
  "http://localhost:5181", // browser tests, main page
  "http://localhost:5182", // browser tests, cross-origin frame
]);

let forcedStatus = 0;
let forcedRetryAfter = 0;
// Sampling rules sent in X-UiObs-Sampling with every accepted batch. Empty means no header.
let samplingRules = "";
const seenBatchIds = new Map(); // idempotency, as the real server must also do
// Every parsed body by ingest path, so a test can assert what the server really got.
const received = new Map();

// Keeps one request for GET /__received, or nothing when recording is off.
function remember(path, entry) {
  if (!RECORD) {
    return;
  }

  const entries = received.get(path) ?? [];
  entries.push(entry);
  if (entries.length > MAX_RECEIVED_PER_PATH) {
    entries.shift();
  }
  received.set(path, entries);
}

// Puts the server back to its start state, so one test can't see another test's batches.
function reset() {
  forcedStatus = 0;
  forcedRetryAfter = 0;
  samplingRules = "";
  seenBatchIds.clear();
  received.clear();
}

function sendJson(res, value) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200).end(JSON.stringify(value));
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    // Never "*" here. "*" is incompatible with Allow-Credentials.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt, traceparent",
  );
  // Without this the browser hides Retry-After from the client on every
  // cross-origin response, so a 429 or 503 arrives with no delay attached and
  // the client backs off on its own schedule instead of the server's.
  // The client also can't read the sampling rules unless their header is on this list.
  res.setHeader(
    "Access-Control-Expose-Headers",
    "retry-after, x-uiobs-sampling, date, server-timing",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const unwrap = (v) => (v ? Object.values(v)[0] : undefined);
const kv = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, unwrap(a.value)]));
// OTLP JSON gives an int64 as a decimal string, or as a number. Anything else reads as unknown,
// because BigInt() throws on it and one odd record would stop the whole server.
function nanos(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }

  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

// Returns the first time that parses, as ISO text. OTLP makes timeUnixNano optional and 0 means
// unknown, so a log record passes observedTimeUnixNano as the stand-in.
function iso(...times) {
  for (const time of times) {
    const value = nanos(time);
    const date = value ? new Date(Number(value / 1000000n)) : null;
    if (date && !Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return "-";
}

// Returns a span's length, or "-" when either end is unknown.
function spanMs(span) {
  const start = nanos(span.startTimeUnixNano);
  const end = nanos(span.endTimeUnixNano);
  if (start === null || end === null) {
    return "-";
  }

  return `${Number((end - start) / 1000n) / 1000}ms`;
}

// Prints one line per data point in an ExportMetricsServiceRequest. Sums and gauges show their
// value, histograms show their count and sum.
function printMetrics(payload, batchId) {
  const points = [];
  for (const rm of payload.resourceMetrics ?? []) {
    const resAttrs = kv(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        const type = ["sum", "histogram", "gauge"].find((key) => metric[key]) ?? "unknown";
        for (const dp of metric[type]?.dataPoints ?? []) {
          const value =
            type === "histogram"
              ? `count=${dp.count} sum=${dp.sum}`
              : String(dp.asDouble ?? dp.asInt);
          const attrs = Object.entries(kv(dp.attributes)).map(([key, v]) => `${key}=${v}`);
          points.push(
            [
              iso(dp.timeUnixNano),
              `[${resAttrs["service.name"]}]`,
              `[${type}]`,
              metric.name,
              value,
              metric.unit,
              attrs.join(" "),
            ].join("  "),
          );
        }
      }
    }
  }
  console.log(`[metrics] batch=${batchId} points=${points.length}`);
  for (const line of points) {
    console.log(line);
  }
}

// Prints one line per span in an ExportTraceServiceRequest. A root span has no parent.
function printTraces(payload, batchId) {
  const lines = [];
  for (const rs of payload.resourceSpans ?? []) {
    const resAttrs = kv(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        lines.push(
          [
            iso(span.startTimeUnixNano),
            `[${resAttrs["service.name"]}]`,
            span.kind === 3 ? "[client]" : "[internal]",
            span.name,
            spanMs(span),
            `trace=${String(span.traceId).slice(0, 8)}`,
            `span=${String(span.spanId).slice(0, 8)}`,
            `parent=${String(span.parentSpanId ?? "-").slice(0, 8)}`,
            span.status?.code === 2 ? "ERROR" : "",
          ].join("  "),
        );
      }
    }
  }
  console.log(`[traces] batch=${batchId} spans=${lines.length}`);
  for (const line of lines) {
    console.log(line);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/__timing") {
    res.setHeader("Timing-Allow-Origin", "*");
    const parent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
    res.setHeader(
      "Server-Timing",
      `cache;dur=4;desc="local cache", app;dur=12, traceparent;desc="${parent}"`,
    );
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/__control") {
    forcedStatus = Number(url.searchParams.get("status") || 0);
    forcedRetryAfter = Number(url.searchParams.get("retryAfter") || 0);
    console.log(`[control] forcedStatus=${forcedStatus} retryAfter=${forcedRetryAfter}`);
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/__reset" && req.method === "POST") {
    reset();
    console.log("[control] reset");
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/__received" && req.method === "GET") {
    sendJson(res, {
      "/v1/logs": received.get("/v1/logs") ?? [],
      "/v1/metrics": received.get("/v1/metrics") ?? [],
      "/v1/traces": received.get("/v1/traces") ?? [],
      "/v1/replay": received.get("/v1/replay") ?? [],
    });
    return;
  }

  // Answers with the request headers as the server saw them. A test reads traceparent here,
  // because a page can't read the headers that the browser really sent.
  if (url.pathname === "/__echo" && req.method === "GET") {
    sendJson(res, { headers: req.headers });
    return;
  }

  if (url.pathname === "/__sampling") {
    samplingRules = url.searchParams.get("rules") || "";
    console.log(`[control] sampling=${samplingRules || "(none)"}`);
    res.writeHead(204).end();
    return;
  }

  // The library sends metric batches to /v1/metrics when metricsEndpoint is set, and span
  // batches to /v1/traces when tracesEndpoint is set.
  const isMetrics = url.pathname === "/v1/metrics";
  const isTraces = url.pathname === "/v1/traces";
  // Session replay segments go to replay.endpoint. They aren't OTLP batches.
  const isReplay = url.pathname === "/v1/replay";
  if (
    (url.pathname !== "/v1/logs" && !isMetrics && !isTraces && !isReplay) ||
    req.method !== "POST"
  ) {
    res.writeHead(404).end();
    return;
  }

  // The exit flush cannot set headers, so the batch id also arrives as a query
  // parameter. A real server has to read both, or it cannot deduplicate the one
  // delivery that is most likely to arrive twice.
  const batchId =
    req.headers["x-uiobs-batch-id"] || url.searchParams.get("uiobs_batch_id") || "(none)";
  const attempt = req.headers["x-uiobs-attempt"] || "0";
  const exitReason = url.searchParams.get("uiobs_exit");
  if (exitReason) {
    console.log(`[exit ${exitReason}] batch=${batchId}`);
  }

  if (forcedStatus && forcedStatus >= 400) {
    if (forcedRetryAfter) {
      res.setHeader("Retry-After", String(forcedRetryAfter));
    }
    console.log(`[forced ${forcedStatus}] batch=${batchId} attempt=${attempt}`);
    res
      .writeHead(forcedStatus)
      .end(forcedStatus === 413 ? JSON.stringify({ maxBytes: 65536 }) : "");
    return;
  }

  let raw = await readBody(req);
  if (req.headers["content-encoding"] === "gzip") {
    try {
      raw = gunzipSync(raw);
    } catch (err) {
      console.error("[error] gunzip failed", err);
      res.writeHead(400).end();
      return;
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    console.error("[error] body is not JSON:", raw.toString("utf8").slice(0, 200));
    res.writeHead(400).end();
    return;
  }

  // Send the rules only with an accepted batch, as the ingest contract says.
  if (samplingRules) {
    res.setHeader("X-UiObs-Sampling", samplingRules);
  }

  const duplicate = seenBatchIds.has(batchId);
  // A second send is kept with its flag, or a test that counts arrivals couldn't see it.
  remember(url.pathname, {
    batchId,
    attempt: Number(attempt),
    exit: exitReason,
    contentType: req.headers["content-type"] ?? null,
    contentEncoding: req.headers["content-encoding"] ?? null,
    // Only whether a cookie came, never its value, so a test can prove an exit send leaked none.
    hasCookie: req.headers.cookie !== undefined,
    duplicate,
    payload,
  });

  if (duplicate) {
    console.log(`[duplicate] batch=${batchId} ignored (idempotency working as intended)`);
    res.writeHead(204).end();
    return;
  }
  seenBatchIds.set(batchId, Date.now());

  if (isReplay) {
    const events = Array.isArray(payload.events) ? payload.events.length : 0;
    console.log(
      `[replay] replay=${payload["replay.id"]} sequence=${payload.sequence} events=${events} ` +
        `bytes=${raw.length} session=${payload["session.id"]}`,
    );
    res.writeHead(204).end();
    return;
  }

  if (isMetrics) {
    printMetrics(payload, batchId);
    res.writeHead(204).end();
    return;
  }

  if (isTraces) {
    printTraces(payload, batchId);
    res.writeHead(204).end();
    return;
  }

  // Per-request record count: the per-record lines below cannot show where one
  // batch ends and the next begins.
  const batchSize = (payload.resourceLogs ?? []).reduce(
    (total, rl) =>
      total + (rl.scopeLogs ?? []).reduce((sub, sl) => sub + (sl.logRecords ?? []).length, 0),
    0,
  );
  console.log(`[batch] batch=${batchId} records=${batchSize}`);

  for (const rl of payload.resourceLogs ?? []) {
    const resAttrs = kv(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const attrs = kv(rec.attributes);
        console.log(
          [
            iso(rec.timeUnixNano, rec.observedTimeUnixNano),
            String(rec.severityText).padEnd(5),
            `[${resAttrs["service.name"]}]`,
            `[${attrs["log.type"]}]`,
            rec.body?.stringValue,
            `journey=${attrs["journey.id"] ?? "-"}`,
            `tab=${String(resAttrs["tab.id"] ?? "-").slice(0, 8)}`,
            `trace=${String(rec.traceId ?? "-").slice(0, 8)}`,
          ].join("  "),
        );
      }
    }
  }

  res.writeHead(204).end();
}

// A body that is JSON but not the OTLP shape throws in the printers. Answer 400, as for a body
// that isn't JSON, or the throw stops the whole server.
const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("[error] the body does not have the expected shape", error);
    if (!res.headersSent) {
      res.writeHead(400);
    }
    res.end();
  });
});

server.listen(PORT, () => {
  console.log(
    `mock ingest listening on http://localhost:${PORT}/v1/logs, /v1/metrics, /v1/traces and /v1/replay`,
  );
});

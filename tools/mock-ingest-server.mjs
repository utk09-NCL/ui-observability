// tools/mock-ingest-server.mjs
// Run:     node tools/mock-ingest-server.mjs
// Control: curl -X POST "http://localhost:8787/__control?status=429&retryAfter=5"
//          curl -X POST "http://localhost:8787/__control?status=200"

import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

const PORT = 8787;
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
]);

let forcedStatus = 0;
let forcedRetryAfter = 0;
// Sampling rules that each accepted batch gets in X-UiObs-Sampling. Empty sends no header.
let samplingRules = "";
const seenBatchIds = new Map(); // idempotency, as the real server must also do

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    // Never "*" here. "*" is incompatible with Allow-Credentials.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt",
  );
  // Without this the browser hides Retry-After from the client on every
  // cross-origin response, so a 429 or 503 arrives with no delay attached and
  // the client backs off on its own schedule instead of the server's.
  // The client reads the sampling rules only if this list has the header.
  res.setHeader("Access-Control-Expose-Headers", "retry-after, x-uiobs-sampling");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const unwrap = (v) => (v ? Object.values(v)[0] : undefined);
const kv = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, unwrap(a.value)]));
const iso = (nanos) => new Date(Number(BigInt(nanos) / 1000000n)).toISOString();

// One line for each data point of an ExportMetricsServiceRequest. A sum and a gauge show the
// value. A histogram shows its count and its sum.
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  cors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/__control") {
    forcedStatus = Number(url.searchParams.get("status") || 0);
    forcedRetryAfter = Number(url.searchParams.get("retryAfter") || 0);
    console.log(`[control] forcedStatus=${forcedStatus} retryAfter=${forcedRetryAfter}`);
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/__sampling") {
    samplingRules = url.searchParams.get("rules") || "";
    console.log(`[control] sampling=${samplingRules || "(none)"}`);
    res.writeHead(204).end();
    return;
  }

  // The library sends a batch of metric records to /v1/metrics when metricsEndpoint is set.
  const isMetrics = url.pathname === "/v1/metrics";
  if ((url.pathname !== "/v1/logs" && !isMetrics) || req.method !== "POST") {
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

  // Send the rules only with an accepted batch, as the ingest contract says.
  if (samplingRules) {
    res.setHeader("X-UiObs-Sampling", samplingRules);
  }

  if (seenBatchIds.has(batchId)) {
    console.log(`[duplicate] batch=${batchId} ignored (idempotency working as intended)`);
    res.writeHead(204).end();
    return;
  }
  seenBatchIds.set(batchId, Date.now());

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    console.error("[error] body is not JSON:", raw.toString("utf8").slice(0, 200));
    res.writeHead(400).end();
    return;
  }

  if (isMetrics) {
    printMetrics(payload, batchId);
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
            iso(rec.timeUnixNano),
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
});

server.listen(PORT, () => {
  console.log(`mock ingest listening on http://localhost:${PORT}/v1/logs and /v1/metrics`);
});

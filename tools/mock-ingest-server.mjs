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
// Replay: curl "http://localhost:8787/v1/replay/recordings"        (the stored recordings)
//         curl "http://localhost:8787/v1/replay/recordings/<id>"   (one recording, in order)

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
  // react-custom-backend calls this server through its Vite proxy, so a same-origin request
  // needs no CORS. These two origins matter when a page sends to this server directly.
  "http://localhost:5185", // react-custom-backend
  "http://localhost:5186", // browser smoke test of react-custom-backend
  "http://localhost:5187", // browser smoke test of react
]);

// The example "uilogs" backend of playground/react-custom-backend. It is a made-up shape for the
// example, not a standard. The app's serializer cuts each record to the three record limits. A
// request with more records than maxRecords gets 413, and the library splits it.
const UILOGS_LIMITS = {
  maxMessageChars: 2000,
  maxAttributeKeys: 50,
  maxAttributesBytes: 16384,
  maxRecords: 500,
};
const UILOGS_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];
const UILOGS_OPTIONAL_IDS = ["sessionId", "tabId", "journeyId", "traceId"];

let forcedStatus = 0;
let forcedRetryAfter = 0;
// Sampling rules sent in X-UiObs-Sampling with every accepted batch. Empty means no header.
let samplingRules = "";
const seenBatchIds = new Map(); // idempotency, as the real server must also do
// Every parsed body by ingest path, so a test can assert what the server really got.
const received = new Map();

// The replay segments that /v1/replay received, grouped by recording. Unlike /__received this
// store is always on, because the replay player of the playground reads it. It is bounded: when a
// limit is over, the oldest recording leaves first. A full snapshot of a large page is one
// segment of several MB, so the byte limit is the one that matters.
const REPLAY_LIMITS = {
  maxRecordings: 20,
  maxSegmentsPerRecording: 100,
  maxSegmentBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};
// The library makes a recording id with crypto.randomUUID(). The route accepts this shape only,
// so an id from a URL can't be anything else than a key of the store.
const REPLAY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
// id -> { id, service, sessionId, tabId, startedAt, bytes, segments: Map(sequence -> { events, text, bytes }) }
const replayRecordings = new Map();
let replayBytes = 0;

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
  replayRecordings.clear();
  replayBytes = 0;
}

// Removes the oldest recording except the one that gets the new segment. A Map keeps the order
// of insertion, so the first key is the oldest recording. Returns false when there is none.
function evictOldestReplay(keepId) {
  for (const [id, recording] of replayRecordings) {
    if (id !== keepId) {
      replayRecordings.delete(id);
      replayBytes -= recording.bytes;
      console.log(`[replay] evicted recording=${id} bytes=${recording.bytes}`);
      return true;
    }
  }

  return false;
}

// Stores one replay segment. Returns "stored", "duplicate" or a text that says why it was not
// stored. A segment with the same recording and sequence replaces the first one, because the
// library sends a segment again after a failed attempt. `size` is the length of the body in
// bytes. The limits count bytes, and a text of 2-byte characters is twice as long in bytes.
function storeReplaySegment(payload, text, size) {
  const id = payload["replay.id"];
  const sequence = payload.sequence;
  if (typeof id !== "string" || !REPLAY_ID_PATTERN.test(id)) {
    return "the replay.id is not an id of this library";
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    return "the sequence is not a whole number of 0 or more";
  }
  if (!Array.isArray(payload.events)) {
    return "events is not a list";
  }
  if (size > REPLAY_LIMITS.maxSegmentBytes) {
    return "the segment is over the size limit";
  }

  const existing = replayRecordings.get(id);
  const before = existing?.segments.get(sequence);
  if (existing && !before && existing.segments.size >= REPLAY_LIMITS.maxSegmentsPerRecording) {
    return "the recording has the most segments that the store keeps";
  }

  // Check before the write. One recording can't be bigger than the whole store, and the store
  // never evicts the recording that gets the segment, so this is the one place that stops it.
  const added = size - (before?.bytes ?? 0);
  if ((existing?.bytes ?? 0) + added > REPLAY_LIMITS.maxTotalBytes) {
    return "the segment would take the recording past the byte limit of the store";
  }
  while (replayBytes + added > REPLAY_LIMITS.maxTotalBytes && evictOldestReplay(id)) {
    // Each pass removes one recording, and the loop ends when the segment fits.
  }

  const recording = existing ?? {
    id,
    service: String(payload["service.name"] ?? ""),
    sessionId: String(payload["session.id"] ?? ""),
    tabId: String(payload["tab.id"] ?? ""),
    startedAt: new Date().toISOString(),
    bytes: 0,
    segments: new Map(),
  };
  recording.segments.set(sequence, { events: payload.events.length, text, bytes: size });
  recording.bytes += added;
  replayBytes += added;
  // The recording that just got a segment is the newest, so it is last in the order of eviction.
  replayRecordings.delete(id);
  replayRecordings.set(id, recording);
  while (replayRecordings.size > REPLAY_LIMITS.maxRecordings && evictOldestReplay(id)) {
    // The oldest recording leaves, and the loop ends at the limit of recordings.
  }

  return before ? "duplicate" : "stored";
}

// The recordings for GET /v1/replay/recordings, newest first. The list has no events.
function listReplayRecordings() {
  return [...replayRecordings.values()].reverse().map((recording) => ({
    id: recording.id,
    service: recording.service,
    sessionId: recording.sessionId,
    tabId: recording.tabId,
    startedAt: recording.startedAt,
    segments: recording.segments.size,
    events: [...recording.segments.values()].reduce((sum, segment) => sum + segment.events, 0),
    bytes: recording.bytes,
  }));
}

// One recording with its segments in the order of their sequence numbers.
function readReplayRecording(recording) {
  const segments = [...recording.segments.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sequence, segment]) => ({ sequence, events: JSON.parse(segment.text).events }));

  return {
    id: recording.id,
    service: recording.service,
    sessionId: recording.sessionId,
    tabId: recording.tabId,
    startedAt: recording.startedAt,
    segments,
  };
}

// A page that an attacker controls can point its DNS name to 127.0.0.1 and then read this server
// as its own origin, which is called DNS rebinding. The browser sends the name of the attacker in
// the Host header, so the server answers a loopback name only, with or without a port.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

function hasLoopbackHost(req) {
  return typeof req.headers.host === "string" && LOOPBACK_HOST.test(req.headers.host);
}

const HOST_REFUSED =
  "The Host header is not a loopback name. This mock server answers localhost, 127.0.0.1 and [::1].\n";

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
    "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt, traceparent, authorization",
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

// Prints one line per document in an ECS NDJSON batch, with the fields of an OTLP record line.
// The labels hold the attributes, which ECS flattens into one map with dotted keys.
function printEcs(documents, batchId) {
  console.log(`[batch] batch=${batchId} records=${documents.length}`);
  for (const doc of documents) {
    const labels = doc?.labels ?? {};
    console.log(
      [
        doc?.["@timestamp"] ?? "-",
        String(doc?.log?.level).toUpperCase().padEnd(5),
        `[${doc?.service?.name}]`,
        `[${labels["log.type"]}]`,
        doc?.message,
        `journey=${labels["journey.id"] ?? "-"}`,
        `tab=${String(labels["tab.id"] ?? "-").slice(0, 8)}`,
        `trace=${String(doc?.trace?.id ?? "-").slice(0, 8)}`,
      ].join("  "),
    );
  }
}

// Returns the first problem of one uilogs record as text, or "" for a good record.
function uilogsRecordProblem(record) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return "a record must be a JSON object";
  }
  if (typeof record.ts !== "string" || Number.isNaN(Date.parse(record.ts))) {
    return "ts must be a date string";
  }
  if (!UILOGS_LEVELS.includes(record.level)) {
    return `level must be one of ${UILOGS_LEVELS.join(", ")}`;
  }
  for (const key of ["logger", "message", "type"]) {
    if (typeof record[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  if (record.message.length > UILOGS_LIMITS.maxMessageChars) {
    return `message is over ${UILOGS_LIMITS.maxMessageChars} characters`;
  }
  for (const key of UILOGS_OPTIONAL_IDS) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      return `${key} must be a string when it is present`;
    }
  }

  const { attributes } = record;
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
    return "attributes must be a JSON object";
  }
  if (Object.keys(attributes).length > UILOGS_LIMITS.maxAttributeKeys) {
    return `attributes has more than ${UILOGS_LIMITS.maxAttributeKeys} keys`;
  }
  if (Buffer.byteLength(JSON.stringify(attributes)) > UILOGS_LIMITS.maxAttributesBytes) {
    return `attributes are over ${UILOGS_LIMITS.maxAttributesBytes} bytes as JSON`;
  }

  return "";
}

// Returns { status, error, index? } for the first problem of a uilogs body, or null for a good
// body. A request with too many records gets 413, and the library splits the batch and sends the
// halves. A record over a limit gets 400, and the library drops the whole batch, because a split
// can't fix one oversize record.
function uilogsProblem(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, error: "the body must be a JSON object" };
  }
  if (typeof body.service !== "string" || body.service === "") {
    return { status: 400, error: "service must be a non-empty string" };
  }
  if (!Array.isArray(body.records) || body.records.length === 0) {
    return { status: 400, error: "records must be a non-empty array" };
  }
  if (body.records.length > UILOGS_LIMITS.maxRecords) {
    return {
      status: 413,
      error: `a request holds at most ${UILOGS_LIMITS.maxRecords} records`,
      maxRecords: UILOGS_LIMITS.maxRecords,
    };
  }

  for (const [index, record] of body.records.entries()) {
    const error = uilogsRecordProblem(record);
    if (error) {
      return { status: 400, error, index };
    }
  }

  return null;
}

// Prints one line per uilogs record, with the fields of an OTLP record line.
function printUilogs(body, batchId, hasAuthorization) {
  console.log(
    `[uilogs] batch=${batchId} records=${body.records.length} ` +
      `auth=${hasAuthorization ? "bearer" : "none"}`,
  );
  for (const record of body.records) {
    console.log(
      [
        record.ts,
        record.level.padEnd(5),
        `[${body.service}]`,
        `[${record.type}]`,
        record.logger,
        record.message,
        `journey=${record.journeyId ?? "-"}`,
        `tab=${String(record.tabId ?? "-").slice(0, 8)}`,
        `trace=${String(record.traceId ?? "-").slice(0, 8)}`,
      ].join("  "),
    );
  }
}

// Top-level keys of an OTLP request. An ECS document has none of them.
const OTLP_KEYS = ["resourceLogs", "resourceMetrics", "resourceSpans"];

// Parses text as JSON. Returns undefined when the text isn't JSON.
function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Parses the lines of an NDJSON body. Returns undefined when a line isn't JSON.
function parseNdjson(text) {
  const documents = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    const document = tryJson(line);
    if (document === undefined) {
      return undefined;
    }
    documents.push(document);
  }

  return documents;
}

// An ECS document is a JSON object with the one field that ECS requires.
function isEcsDocument(document) {
  return typeof document === "object" && document !== null && "@timestamp" in document;
}

// Parses a text/plain body as ECS NDJSON. The body is a guess, so a body with no document, or with
// a document that isn't ECS, is a wrong body and not an empty batch. Returns undefined for it.
function parseEcs(text) {
  const documents = parseNdjson(text);

  return documents !== undefined && documents.length > 0 && documents.every(isEcsDocument)
    ? documents
    : undefined;
}

// Picks the parser for a body. The exit flush sends text/plain with the body of the serializer,
// so OTLP JSON and ECS NDJSON both arrive that way. A one-record ECS body is also one JSON
// object, so only an OTLP key makes the body OTLP. A replay segment has no ECS form.
// Returns { documents } for NDJSON or { payload } for JSON. A body that fails has neither.
function parseBody(contentType, isReplay, text) {
  const mediaType = String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType === "application/x-ndjson") {
    return { documents: isReplay ? undefined : parseNdjson(text) };
  }

  const payload = tryJson(text);
  const isOtlp =
    typeof payload === "object" && payload !== null && OTLP_KEYS.some((key) => key in payload);
  if (mediaType === "text/plain" && !isReplay && !isOtlp) {
    return { documents: parseEcs(text) };
  }

  return { payload };
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
  if (!hasLoopbackHost(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end(HOST_REFUSED);
    return;
  }
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
      "/uilogs": received.get("/uilogs") ?? [],
    });
    return;
  }

  // The replay player of the playground reads the stored recordings. The recording id is checked
  // before it is looked up.
  if (req.method === "GET" && url.pathname === "/v1/replay/recordings") {
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, listReplayRecordings());
    return;
  }
  const recordingPath = /^\/v1\/replay\/recordings\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && recordingPath) {
    const id = recordingPath[1];
    res.setHeader("Cache-Control", "no-store");
    if (!REPLAY_ID_PATTERN.test(id)) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(400).end(JSON.stringify({ error: "the recording id is not valid" }));
      return;
    }

    const recording = replayRecordings.get(id);
    if (!recording) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(404).end(JSON.stringify({ error: "no recording has this id" }));
      return;
    }
    sendJson(res, readReplayRecording(recording));
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
  // The example custom backend. Its body is the app serializer's JSON, not OTLP.
  const isUilogs = url.pathname === "/uilogs";
  if (
    (url.pathname !== "/v1/logs" && !isMetrics && !isTraces && !isReplay && !isUilogs) ||
    req.method !== "POST"
  ) {
    res.writeHead(404).end();
    return;
  }

  // The exit flush cannot set headers, so the batch id also arrives as a query
  // parameter. A real server has to read both, or it cannot deduplicate the one
  // delivery that is most likely to arrive twice.
  const givenId = req.headers["x-uiobs-batch-id"] || url.searchParams.get("uiobs_batch_id");
  // A request with no id has nothing to deduplicate on. "(none)" is for the log lines only, or
  // every id-less request after the first would look like a duplicate.
  const batchId = givenId || "(none)";
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

  // The exit flush sends the body of any serializer as text/plain. A uilogs body is always JSON.
  const { documents, payload } = parseBody(
    isUilogs ? "application/json" : req.headers["content-type"],
    isReplay,
    raw.toString("utf8"),
  );
  if (documents === undefined && payload === undefined) {
    console.error(
      "[error] body is not JSON, or it has no OTLP or ECS shape:",
      raw.toString("utf8").slice(0, 200),
    );
    res.writeHead(400).end();
    return;
  }

  // A body that breaks a limit is not kept, as for a real backend. 413 is for a request that is
  // too large, and 400 is for a record that is wrong.
  const uilogsError = isUilogs ? uilogsProblem(payload) : null;
  if (uilogsError) {
    const { status, ...answer } = uilogsError;
    console.error(
      `[error] uilogs refused batch=${batchId} with ${status}: ${answer.error}` +
        `${answer.index === undefined ? "" : ` (record ${answer.index})`}`,
    );
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status).end(JSON.stringify(answer));
    return;
  }

  // Send the rules only with an accepted batch, as the ingest contract says.
  if (samplingRules) {
    res.setHeader("X-UiObs-Sampling", samplingRules);
  }

  const duplicate = Boolean(givenId) && seenBatchIds.has(batchId);
  // A second send is kept with its flag, or a test that counts arrivals couldn't see it.
  remember(url.pathname, {
    batchId,
    attempt: Number(attempt),
    exit: exitReason,
    contentType: req.headers["content-type"] ?? null,
    contentEncoding: req.headers["content-encoding"] ?? null,
    // Only whether a cookie came, never its value, so a test can prove an exit send leaked none.
    hasCookie: req.headers.cookie !== undefined,
    // Only uilogs entries, because only that example backend reads a token. Never the value.
    ...(isUilogs ? { hasAuthorization: req.headers.authorization !== undefined } : {}),
    duplicate,
    // An NDJSON body has no single JSON value, so its parsed lines are kept as a list.
    payload: documents ?? payload,
  });

  if (duplicate) {
    console.log(`[duplicate] batch=${batchId} ignored (idempotency working as intended)`);
    res.writeHead(204).end();
    return;
  }
  if (givenId) {
    seenBatchIds.set(batchId, Date.now());
  }

  if (isUilogs) {
    printUilogs(payload, batchId, String(req.headers.authorization ?? "").startsWith("Bearer "));
    res.writeHead(204).end();
    return;
  }

  // An ECS batch comes as NDJSON, one document for each record.
  if (documents) {
    printEcs(documents, batchId);
    res.writeHead(204).end();
    return;
  }

  if (isReplay) {
    const events = Array.isArray(payload.events) ? payload.events.length : 0;
    console.log(
      `[replay] replay=${payload["replay.id"]} sequence=${payload.sequence} events=${events} ` +
        `bytes=${raw.length} session=${payload["session.id"]}`,
    );
    const outcome = storeReplaySegment(payload, raw.toString("utf8"), raw.length);
    if (outcome !== "stored" && outcome !== "duplicate") {
      console.error(`[error] replay segment not stored: ${outcome}`);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(400).end(JSON.stringify({ error: outcome }));
      return;
    }
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

// Loopback only, so a device on the same network can't reach the server.
server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `mock ingest listening on http://localhost:${PORT}/v1/logs, /v1/metrics, /v1/traces, ` +
      "/v1/replay and /uilogs",
  );
});

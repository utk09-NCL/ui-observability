// tools/reference-collector.mjs
//
// Reference ingest server for the library. It implements every rule of the ingest contract in
// docs/ingest-server.md, has no dependencies, and is not part of the package. Use it as a model
// for your own server, or run it in front of an OpenTelemetry collector.
//
// Run: node tools/reference-collector.mjs
//
// Environment:
//   HOST                     Interface to listen on. Default 127.0.0.1. Set 0.0.0.0 to accept
//                            requests from other hosts.
//   PORT                     Port. Default 4320.
//   ALLOWED_ORIGINS          Comma-separated origins that may send. Default: none. A request
//                            with any other Origin header gets 403.
//   ALLOW_CREDENTIALS        "true" sends Access-Control-Allow-Credentials. Only use it with
//                            credentials: "include" in the library.
//   AUTH_TOKEN               If set, every request must send "Authorization: Bearer <token>".
//                            A token in a browser bundle is public, so it doesn't prove who
//                            the user is.
//   UPSTREAM_URL             Base URL of an OTLP/HTTP collector, for example http://localhost:4318.
//                            Every OTLP batch is forwarded there. Without it, the server prints
//                            a summary of each batch.
//   SAMPLING_RULES           The remote sampling rules as JSON text, for X-UiObs-Sampling.
//   MAX_BODY_BYTES           Largest body after gzip decoding. Default 1048576.
//   MAX_REPLAY_BODY_BYTES    The same limit for a /v1/replay body. Default 16777216.
//   MAX_REQUESTS_PER_SECOND  Requests from one address above this rate get 429. Default 50.
//   DEDUP_MAX_IDS            Most batch ids kept for deduplication. Default 100000. A full table
//                            forgets the oldest id, and a client that sends that batch again gets
//                            it stored twice. The server warns when that id is under 24 hours old.

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

/**
 * Reads a positive integer from the environment. A value such as "1mb" parses to NaN, and a
 * NaN limit would turn the limit off, so the server refuses to start instead.
 * @param name Variable name.
 * @param fallback Value to use when the variable isn't set.
 * @returns The integer.
 */
function positiveInteger(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. The value is ${JSON.stringify(raw)}.`);
  }
  return value;
}

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = positiveInteger("PORT", 4320);
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
);
const ALLOW_CREDENTIALS = process.env.ALLOW_CREDENTIALS === "true";
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "";
const UPSTREAM_URL = (process.env.UPSTREAM_URL ?? "").replace(/\/+$/, "");
const SAMPLING_RULES = process.env.SAMPLING_RULES ?? "";
const MAX_BODY_BYTES = positiveInteger("MAX_BODY_BYTES", 1_048_576);
// A replay segment holding a full snapshot is a single event, and the library can't split it.
const MAX_REPLAY_BODY_BYTES = positiveInteger("MAX_REPLAY_BODY_BYTES", 16_777_216);
const MAX_REQUESTS_PER_SECOND = positiveInteger("MAX_REQUESTS_PER_SECOND", 50);

/** Keep every batch id for 24 hours, the minimum the contract asks for. */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum number of batch ids kept in memory. The oldest id is evicted first. */
const DEDUP_MAX_IDS = positiveInteger("DEDUP_MAX_IDS", 100_000);

/** Shortest time between two warnings about early evictions, so a full table stays readable. */
const DEDUP_WARN_INTERVAL_MS = 60_000;

/** Largest upstream answer body that the server passes on. The library ignores a larger one. */
const UPSTREAM_BODY_MAX_BYTES = 16_384;

/** Top-level keys of an OTLP request. An ECS document has none of them. */
const OTLP_KEYS = ["resourceLogs", "resourceMetrics", "resourceSpans"];

/** Batch ids the server accepts. The library sends a UUID or a hex string. */
const BATCH_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/** Attempt counts the server accepts. */
const ATTEMPT_PATTERN = /^\d{1,4}$/;

/** Exit reasons the library sends in uiobs_exit. */
const EXIT_REASONS = new Set(["hidden", "pagehide", "freeze", "openfin-close", "shutdown"]);

/** Longest sampling header the library will read. */
const SAMPLING_MAX_CHARS = 4096;

/** How long a client waits after a 429 or 503, in seconds. */
const RETRY_AFTER_SECONDS = 5;

/** Timeout for a forward to the upstream collector. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Maps each ingest path to the top-level key of its request body. For the three OTLP paths,
 * that is the key of the OTLP request.
 */
const PATHS = {
  "/v1/logs": "resourceLogs",
  "/v1/metrics": "resourceMetrics",
  "/v1/traces": "resourceSpans",
  // A session replay segment: a list of recorder events, with no OTLP form.
  "/v1/replay": "events",
};

/** Media types the library sends. A beacon uses text/plain to avoid a preflight. */
const MEDIA_TYPES = new Set(["application/json", "text/plain", "application/x-ndjson"]);

/** Every accepted batch id, with the time the server accepted it. */
const seen = new Map();

/** Batch ids of requests in progress. A second copy arriving at the same time has to wait. */
const inFlight = new Set();

/** Fixed window for the request rate, with a separate count per address. */
const rate = { start: 0, counts: new Map() };

/** Ids evicted before 24 hours since the last warning, and the time of that warning. */
const early = { count: 0, warnedAt: 0 };

// Stop at startup on a bad sampling value, since the library ignores invalid rules.
if (SAMPLING_RULES !== "") {
  JSON.parse(SAMPLING_RULES);
  if (SAMPLING_RULES.length > SAMPLING_MAX_CHARS) {
    throw new Error(`SAMPLING_RULES is longer than ${SAMPLING_MAX_CHARS} characters.`);
  }
}

/**
 * Adds the CORS headers. Rule 2 of the contract.
 * @param req Request.
 * @param res Response.
 */
function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    // Never "*", which doesn't work with credentials.
    res.setHeader("Access-Control-Allow-Origin", origin);
    if (ALLOW_CREDENTIALS) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt, authorization",
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  // Without this, the browser hides Retry-After and the sampling rules from the library.
  res.setHeader("Access-Control-Expose-Headers", "retry-after, x-uiobs-sampling, date");
}

/**
 * Ends a request with a status.
 * @param res Response.
 * @param status Status code.
 * @param body Optional body.
 */
function end(res, status, body = "") {
  res.writeHead(status).end(body);
}

/**
 * Ends a request with 429 or 503 and Retry-After. Rule 4 of the contract.
 * @param res Response.
 * @param status 429 or 503.
 * @param retryAfter Delay in seconds, as text.
 */
function throttle(res, status, retryAfter = String(RETRY_AFTER_SECONDS)) {
  res.setHeader("Retry-After", retryAfter);
  end(res, status);
}

/**
 * Counts a request against its address in the rate window, so one client can't throttle the
 * others.
 * @param address Remote address of the request.
 * @returns False when the address is over the rate.
 */
function allowRate(address) {
  const now = Date.now();
  // Clear the map on every new window, so it never holds more than one second of addresses.
  if (now - rate.start >= 1000) {
    rate.start = now;
    rate.counts.clear();
  }

  const count = (rate.counts.get(address) ?? 0) + 1;
  rate.counts.set(address, count);
  return count <= MAX_REQUESTS_PER_SECOND;
}

/**
 * Checks the bearer token in constant time.
 * @param req Request.
 * @returns True if AUTH_TOKEN is unset or the token is correct.
 */
function authorized(req) {
  if (AUTH_TOKEN === "") {
    return true;
  }

  const expected = Buffer.from(`Bearer ${AUTH_TOKEN}`);
  const given = Buffer.from(String(req.headers.authorization ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Reads the body, stopping at the limit.
 * @param req Request.
 * @param limit Largest body to accept, in bytes.
 * @returns A promise for the body, or null when the body is too large.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/**
 * Removes batch ids older than 24 hours.
 */
function pruneSeen() {
  const oldest = Date.now() - DEDUP_TTL_MS;
  for (const [key, at] of seen) {
    if (at >= oldest) {
      break;
    }
    seen.delete(key);
  }
}

/**
 * Warns that the table forgot a batch id before 24 hours. A client that sends that batch again
 * gets it stored twice. The warning comes once a minute at most, because a full table evicts an
 * id for each new request.
 * @param ageMs Age of the evicted id.
 */
function warnEarlyEviction(ageMs) {
  early.count += 1;
  const now = Date.now();
  if (now - early.warnedAt < DEDUP_WARN_INTERVAL_MS) {
    return;
  }

  console.warn(
    `[dedup] DEDUP_MAX_IDS=${DEDUP_MAX_IDS} is full. The server forgot a batch id younger than ` +
      `24 hours (age ${Math.round(ageMs / 1000)} s, ids forgotten since the last warning: ` +
      `${early.count}). A client that sends that batch again gets it stored twice. ` +
      "Raise DEDUP_MAX_IDS.",
  );
  early.count = 0;
  early.warnedAt = now;
}

/**
 * Remembers a batch id. Rule 3 of the contract.
 * @param key Path and batch id.
 */
function remember(key) {
  seen.set(key, Date.now());
  // A Map keeps insertion order, so the first key is the oldest.
  while (seen.size > DEDUP_MAX_IDS) {
    const [oldest, acceptedAt] = seen.entries().next().value;
    seen.delete(oldest);

    if (Date.now() - acceptedAt < DEDUP_TTL_MS) {
      warnEarlyEviction(Date.now() - acceptedAt);
    }
  }
}

/**
 * Counts the items in an OTLP request.
 * @param payload Parsed OTLP request.
 * @param key Top-level key of the request.
 * @returns Number of log records, data points or spans.
 */
function countItems(payload, key) {
  let total = 0;
  for (const resource of payload[key] ?? []) {
    for (const scope of Object.values(resource).filter(Array.isArray).flat()) {
      for (const items of Object.values(scope).filter(Array.isArray)) {
        total += items.length;
      }
    }
  }
  return total;
}

/**
 * Reads an upstream answer's body, stopping at the limit.
 * @param response Upstream response.
 * @returns The text, or "" when the body is larger than the limit.
 */
async function readUpstreamBody(response) {
  const chunks = [];
  let size = 0;

  // Leaving the loop early cancels the stream, so a huge body never fills the memory.
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > UPSTREAM_BODY_MAX_BYTES) {
      return "";
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads the body of a 2xx upstream answer. The upstream has accepted the batch, so a body that
 * fails or stalls must not become an error, or the library would send the batch again.
 * @param response Upstream response.
 * @param path Ingest path, for the log line.
 * @returns The body and its content type, or an empty body and no type when the read fails.
 */
async function acceptedBody(response, path) {
  try {
    const body = await readUpstreamBody(response);
    return { body, contentType: response.headers.get("content-type") };
  } catch (error) {
    console.error(`[upstream] ${path} sent a 2xx status, but its body failed: ${error.message}`);
    return { body: "", contentType: null };
  }
}

/**
 * Sends an OTLP request to the upstream collector.
 * @param path Ingest path.
 * @param text OTLP JSON text.
 * @returns A promise for the answer to send back to the library. A 2xx answer has the upstream's
 * status, body and content type. Another answer has a status, and a Retry-After when the
 * upstream sent one for a 408, 429 or 503.
 */
async function forward(path, text) {
  try {
    const response = await fetch(`${UPSTREAM_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // The body of a 2xx answer can have a partialSuccess. The library reads it to report the
    // records that the upstream rejected, so it goes back as the upstream sent it.
    if (response.ok) {
      const accepted = await acceptedBody(response, path);
      return { status: response.status, body: accepted.body, contentType: accepted.contentType };
    }

    // We never read the body of an error, so cancel it to free the connection.
    await response.body?.cancel();

    // The library retries 408, 429 and 5xx, splits a batch on 413, and drops it on any other
    // 4xx. A 401 or 403 from the upstream is this server's fault, not the batch's.
    if (response.status === 408 || response.status === 429 || response.status === 503) {
      return { status: response.status, retryAfter: response.headers.get("retry-after") };
    }
    if (response.status === 413) {
      return { status: 413 };
    }

    const upstreamFault =
      response.status >= 500 || response.status === 401 || response.status === 403;
    return { status: upstreamFault ? 503 : 400 };
  } catch (error) {
    console.error(`[upstream] ${path} failed: ${error.message}`);
    return { status: 503 };
  }
}

/**
 * Parses text as JSON.
 * @param text Text to parse.
 * @returns The value, or undefined when the text isn't JSON.
 */
function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parses the lines of an NDJSON body.
 * @param text Body text.
 * @returns The documents, or undefined when a line isn't JSON.
 */
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

/**
 * Checks for an ECS document, which is a JSON object with the one field that ECS requires.
 * @param document One parsed line.
 * @returns True for an ECS document.
 */
function isEcsDocument(document) {
  return typeof document === "object" && document !== null && "@timestamp" in document;
}

/**
 * Parses a text/plain body as ECS NDJSON. The body is a guess, so a body with no document, or
 * with a document that isn't ECS, is a wrong body and not an empty batch.
 * @param text Body text.
 * @returns The documents, or undefined for a wrong body.
 */
function parseEcs(text) {
  const documents = parseNdjson(text);

  return documents !== undefined && documents.length > 0 && documents.every(isEcsDocument)
    ? documents
    : undefined;
}

/**
 * Picks the parser for a body. The exit flush sends text/plain with the body of the serializer,
 * so OTLP JSON and ECS NDJSON both arrive that way. A one-record ECS body is also one JSON
 * object, so only an OTLP key makes the body OTLP.
 * @param mediaType Media type of the body.
 * @param key Top-level key of the request body for the path.
 * @param text Body text.
 * @returns "ndjson" with the documents (undefined for a wrong body), or "json" with the payload
 * (undefined when the text isn't JSON).
 */
function parseBody(mediaType, key, text) {
  if (mediaType === "application/x-ndjson") {
    // A replay segment has no ECS form.
    return { format: "ndjson", documents: key === "events" ? undefined : parseNdjson(text) };
  }

  const payload = tryJson(text);
  const isOtlp =
    typeof payload === "object" && payload !== null && OTLP_KEYS.some((name) => name in payload);

  // A replay segment has no ECS form, so it stays JSON.
  if (mediaType === "text/plain" && key !== "events" && !isOtlp) {
    return { format: "ndjson", documents: parseEcs(text) };
  }

  return { format: "json", payload };
}

/**
 * Handles one ingest request.
 * @param req Request.
 * @param res Response.
 */
async function handle(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") {
    end(res, 204);
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = PATHS[url.pathname];

  // Rule 1: POST on an ingest path.
  if (key === undefined) {
    end(res, 404);
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    end(res, 405);
    return;
  }

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    end(res, 403);
    return;
  }

  if (!authorized(req)) {
    end(res, 401);
    return;
  }

  if (!allowRate(req.socket.remoteAddress ?? "")) {
    throttle(res, 429, "1");
    return;
  }

  const mediaType = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!MEDIA_TYPES.has(mediaType)) {
    end(res, 415);
    return;
  }

  // The exit flush can't set headers, so its batch id arrives as a query parameter. The strict
  // pattern also keeps newlines and control codes out of the server log.
  const batchId = String(
    req.headers["x-uiobs-batch-id"] ?? url.searchParams.get("uiobs_batch_id") ?? "",
  );
  if (batchId !== "" && !BATCH_ID_PATTERN.test(batchId)) {
    end(res, 400);
    return;
  }

  const dedupKey = batchId === "" ? "" : `${url.pathname}:${batchId}`;
  if (dedupKey !== "" && seen.has(dedupKey)) {
    console.log(`[duplicate] ${url.pathname} batch=${batchId}`);
    end(res, 204);
    return;
  }

  // Two tabs can send the same stored batch at the same time. The second copy retries later.
  if (dedupKey !== "" && inFlight.has(dedupKey)) {
    throttle(res, 503, "1");
    return;
  }

  if (dedupKey !== "") {
    inFlight.add(dedupKey);
  }

  try {
    await accept(req, res, url, key, mediaType, batchId, dedupKey);
  } finally {
    inFlight.delete(dedupKey);
  }
}

/**
 * Reads, checks, forwards and accepts one batch.
 * @param req Request.
 * @param res Response.
 * @param url Request URL.
 * @param key Top-level key of the request body.
 * @param mediaType Media type of the body.
 * @param batchId Batch id, or "".
 * @param dedupKey Path and batch id, or "".
 */
async function accept(req, res, url, key, mediaType, batchId, dedupKey) {
  // Rule 5: 413 with the limit. The library splits a log batch but drops a replay segment.
  const limit = key === "events" ? MAX_REPLAY_BODY_BYTES : MAX_BODY_BYTES;
  let body = await readBody(req, limit);
  const tooLarge = () => {
    res.setHeader("Connection", "close");
    end(res, 413, JSON.stringify({ maxBytes: limit }));
  };
  if (body === null) {
    tooLarge();
    return;
  }

  if (req.headers["content-encoding"] === "gzip") {
    try {
      // The limit stops a small gzip body from decoding into a huge one.
      body = gunzipSync(body, { maxOutputLength: limit });
    } catch (error) {
      if (error.code === "ERR_BUFFER_TOO_LARGE") {
        tooLarge();
        return;
      }
      end(res, 400);
      return;
    }
  }

  const text = body.toString("utf8");
  const exit = url.searchParams.get("uiobs_exit");
  const attemptHeader = String(req.headers["x-uiobs-attempt"] ?? "0");
  const attempt = ATTEMPT_PATTERN.test(attemptHeader) ? attemptHeader : "?";
  const exitText = EXIT_REASONS.has(exit) ? ` exit=${exit}` : "";
  const label = `${url.pathname} batch=${batchId || "-"} attempt=${attempt}${exitText}`;

  // What the library gets back. The upstream can replace it with a partialSuccess body.
  let answer = { status: 204, body: "", contentType: null };

  // An ECS batch is NDJSON, which has no OTLP form to send to the upstream collector.
  const parsed = parseBody(mediaType, key, text);
  if (parsed.format === "ndjson") {
    if (parsed.documents === undefined) {
      end(res, 400);
      return;
    }

    console.log(`[ecs] ${label} documents=${parsed.documents.length}`);
  } else {
    const { payload } = parsed;
    if (typeof payload !== "object" || payload === null || !Array.isArray(payload[key])) {
      end(res, 400);
      return;
    }

    if (key === "events") {
      // The upstream collector only takes OTLP. A real server would store the segment by its ids.
      console.log(
        `[replay] ${label} replay=${String(payload["replay.id"])} sequence=${String(payload.sequence)} events=${payload.events.length}`,
      );
    } else if (UPSTREAM_URL !== "") {
      const result = await forward(url.pathname, text);
      if (result.status >= 400) {
        if (result.status === 429 || result.status === 503) {
          throttle(res, result.status, result.retryAfter ?? undefined);
          return;
        }

        // A 408 keeps the upstream's Retry-After. The server adds none of its own.
        if (result.retryAfter) {
          res.setHeader("Retry-After", result.retryAfter);
        }
        end(res, result.status);
        return;
      }

      answer = result;
    }

    if (key !== "events") {
      console.log(`[otlp] ${label} items=${countItems(payload, key)}`);
    }
  }

  // Only remember the id once the batch is safe, so a failed forward can still be retried.
  if (dedupKey !== "") {
    remember(dedupKey);
  }

  // Rule 7: send the sampling rules only with an accepted batch.
  if (SAMPLING_RULES !== "") {
    res.setHeader("X-UiObs-Sampling", SAMPLING_RULES);
  }

  // The library reads a 2xx body only when the content type says JSON.
  if (answer.body !== "" && answer.contentType !== null) {
    res.setHeader("Content-Type", answer.contentType);
  }
  end(res, answer.status, answer.body);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("[error]", error);
    if (!res.headersSent) {
      end(res, 500);
    }
  });
});

setInterval(pruneSeen, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(
    `reference collector on http://${HOST}:${PORT} (/v1/logs, /v1/metrics, /v1/traces, /v1/replay)`,
  );
  if (AUTH_TOKEN === "") {
    console.warn("no AUTH_TOKEN: each client that can reach the server can send batches");
  }
  console.log(
    UPSTREAM_URL === ""
      ? "no UPSTREAM_URL: the server prints each batch"
      : `forward to ${UPSTREAM_URL}`,
  );
});

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
const DEDUP_MAX_IDS = 100_000;

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
 * Remembers a batch id. Rule 3 of the contract.
 * @param key Path and batch id.
 */
function remember(key) {
  seen.set(key, Date.now());
  // A Map keeps insertion order, so the first key is the oldest.
  while (seen.size > DEDUP_MAX_IDS) {
    seen.delete(seen.keys().next().value);
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
 * Sends an OTLP request to the upstream collector.
 * @param path Ingest path.
 * @param text OTLP JSON text.
 * @returns A promise for the status to send back to the library.
 */
async function forward(path, text) {
  try {
    const response = await fetch(`${UPSTREAM_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // We never read the response body, so cancel it to free the connection.
    await response.body?.cancel();

    if (response.ok) {
      return { status: 204 };
    }

    // The library retries 429, 503 and 5xx, splits a batch on 413, and drops it on any other
    // 4xx. A 401 or 403 from the upstream is this server's fault, not the batch's.
    if (response.status === 429 || response.status === 503) {
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

  // An ECS batch is NDJSON, which has no OTLP form to send to the upstream collector.
  if (mediaType === "application/x-ndjson") {
    const lines = text.split("\n").filter((line) => line !== "");
    console.log(`[ecs] ${label} documents=${lines.length}`);
  } else {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      end(res, 400);
      return;
    }

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
      if (result.status === 429 || result.status === 503) {
        throttle(res, result.status, result.retryAfter ?? undefined);
        return;
      }
      if (result.status !== 204) {
        end(res, result.status);
        return;
      }
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

  end(res, 204);
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

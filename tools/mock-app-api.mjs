// tools/mock-app-api.mjs
// Run:     node tools/mock-app-api.mjs
//          UIOBS_APP_API_PORT=8798 node tools/mock-app-api.mjs
// Env:     UIOBS_APP_API_PORT  Port. Default 8790, and the Vite proxy of each app reads it.
//          UIOBS_APP_API_TOKEN_TTL_MS  Life of a token in milliseconds. Default one hour.
// Control: curl -X POST "http://localhost:8790/api/__fault?mode=reject"   (none|slow|reject|error)
//          curl "http://localhost:8790/api/__fault"
// Tests:   curl -X POST "http://localhost:8790/api/__reset"
//
// The business API of the playground apps: login, orders, positions and a WebSocket price
// stream. State lives in memory. The apps call it through their Vite proxy, so it sends no CORS
// headers. It prints one line for each order request, with the traceparent that it received.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const DEFAULT_PORT = 8790;
// A PORT exported for another project would move this server off 8790, so the name isn't PORT.
const PORT = Number(process.env.UIOBS_APP_API_PORT) || DEFAULT_PORT;

const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
// A short life lets a test or a demo watch a token refresh without a wait of an hour.
const TOKEN_TTL_MS = Number(process.env.UIOBS_APP_API_TOKEN_TTL_MS) || DEFAULT_TOKEN_TTL_MS;
const FILL_DELAY_MS = 1500;
const SLOW_DELAY_MS = 2000;
const TICK_MS = 250;
// A client that connects and never authenticates would hold a socket forever.
const AUTH_TIMEOUT_MS = 2000;
// WebSocket close code for a missing or bad token. 4000 to 4999 is the range for apps.
const CLOSE_UNAUTHORIZED = 4401;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QTY = 1_000_000;
const FIRST_ORDER_NUMBER = 1001;
// The state is in memory, so a long run must not grow it without end. The oldest entry goes first.
const MAX_SESSIONS = 1000;
const MAX_ORDERS = 1000;

const FAULT_MODES = ["none", "slow", "reject", "error"];
const SIDES = ["BUY", "SELL"];
const TENANTS = [
  { id: "tenant-a", name: "Alpha Capital" },
  { id: "tenant-b", name: "Beta Partners" },
  { id: "tenant-c", name: "Gamma Securities" },
];

// Mid price and decimals of each pair. The stream moves the mid by a small random step.
const PAIRS = {
  EURUSD: { mid: 1.085, digits: 5 },
  GBPUSD: { mid: 1.27, digits: 5 },
  USDJPY: { mid: 150.2, digits: 3 },
  AUDUSD: { mid: 0.66, digits: 5 },
};
const SPREAD_FRACTION = 0.0002;

/** token -> { user, tenant, expiresAt } */
const sessions = new Map();
const orders = [];
/** order id -> the timer that fills it, so a cancel or a reset can stop the fill. */
const fillTimers = new Map();
/** Open stream sockets. A socket joins the room after its auth message. */
const sockets = new Set();

let faultMode = "none";
let nextOrderNumber = FIRST_ORDER_NUMBER;
const quotes = {};

// Puts the server back to its start state, so one test can't see another test's orders.
function reset() {
  sessions.clear();
  orders.length = 0;
  for (const timer of fillTimers.values()) {
    clearTimeout(timer);
  }
  fillTimers.clear();
  for (const socket of sockets) {
    socket.close(CLOSE_UNAUTHORIZED, "reset");
  }
  faultMode = "none";
  nextOrderNumber = FIRST_ORDER_NUMBER;
  for (const [pair, { mid, digits }] of Object.entries(PAIRS)) {
    quotes[pair] = { mid, digits };
  }
}

function sendJson(res, status, value) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status).end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("The body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Parses a JSON object body. Returns null when the body isn't a JSON object, and the route
// then answers 400.
async function readJson(req) {
  let text;
  try {
    text = await readBody(req);
  } catch {
    return null;
  }

  try {
    const value = JSON.parse(text);

    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Closes each stream socket that logged in with a token. A socket outlives its request, so
// removing the session alone would leave the stream open for a user who has no right to it.
function closeSocketsOf(token, reason) {
  for (const socket of sockets) {
    if (socket.token === token) {
      socket.close(CLOSE_UNAUTHORIZED, reason);
    }
  }
}

// Removes the expired sessions, then the oldest ones until a new session fits. Each removed
// session loses its sockets too.
function forgetOldSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      closeSocketsOf(token, "expired");
    }
  }

  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
    closeSocketsOf(oldest, "evicted");
  }
}

// Returns the session of a Bearer token, or null for a missing, unknown or expired token.
function sessionOf(token) {
  const session = token ? sessions.get(token) : undefined;
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function bearerOf(req) {
  const header = String(req.headers.authorization ?? "");

  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

// An order belongs to the user and the tenant that placed it.
function ownedBy(session) {
  return (order) => order.user === session.user && order.tenant === session.tenant;
}

// Sends a message to each authenticated socket of one user.
function pushToUser(session, message) {
  const text = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.session?.user === session.user && socket.session.tenant === session.tenant) {
      socket.send(text);
    }
  }
}

function pushOrder(order) {
  pushToUser(order, { type: "order", order: publicOrder(order) });
}

// Hides the owner fields, which the client already knows.
function publicOrder(order) {
  const { id, pair, side, qty, status, price, createdAt, updatedAt } = order;

  return { id, pair, side, qty, status, price, createdAt, updatedAt };
}

function quoteOf(pair) {
  const { mid, digits } = quotes[pair];
  const half = (mid * SPREAD_FRACTION) / 2;

  return {
    bid: Number((mid - half).toFixed(digits)),
    ask: Number((mid + half).toFixed(digits)),
  };
}

// Fills a working order at the current quote. A cancel before the fill leaves the order as it is.
function fill(order) {
  fillTimers.delete(order.id);
  if (order.status !== "working") {
    return;
  }

  const { bid, ask } = quoteOf(order.pair);
  order.status = "filled";
  order.price = order.side === "BUY" ? ask : bid;
  order.updatedAt = new Date().toISOString();
  pushOrder(order);
}

// Nets the filled orders of one user by pair. A buy adds to the position and a sell removes.
function positionsOf(session) {
  const byPair = new Map();
  for (const order of orders.filter(ownedBy(session))) {
    if (order.status !== "filled") {
      continue;
    }

    const signed = order.side === "BUY" ? order.qty : -order.qty;
    const entry = byPair.get(order.pair) ?? { pair: order.pair, netQty: 0, notional: 0, volume: 0 };
    entry.netQty += signed;
    entry.notional += order.qty * order.price;
    entry.volume += order.qty;
    byPair.set(order.pair, entry);
  }

  return [...byPair.values()].map(({ pair, netQty, notional, volume }) => ({
    pair,
    netQty,
    avgPrice: Number((notional / volume).toFixed(PAIRS[pair].digits)),
  }));
}

// Returns an error text for a bad order body, or "" for a good one.
function orderProblem(body) {
  if (typeof body.pair !== "string" || !(body.pair in PAIRS)) {
    return `pair must be one of ${Object.keys(PAIRS).join(", ")}`;
  }
  if (!SIDES.includes(body.side)) {
    return `side must be one of ${SIDES.join(", ")}`;
  }
  if (!Number.isInteger(body.qty) || body.qty < 1 || body.qty > MAX_QTY) {
    return `qty must be a whole number from 1 to ${MAX_QTY}`;
  }

  return "";
}

// Prints one line for an order request, with the traceparent header the client sent. A line with
// a trace id proves that the library's trace propagation reached the API through the proxy.
function logOrderRequest(req, res, session, startedAt) {
  res.on("finish", () => {
    console.log(
      [
        `[orders] ${req.method} ${req.url}`,
        `user=${session?.user ?? "-"}`,
        `traceparent=${req.headers.traceparent ?? "-"}`,
        `fault=${faultMode}`,
        `status=${res.statusCode}`,
        `${Date.now() - startedAt}ms`,
      ].join("  "),
    );
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const user = typeof body?.user === "string" ? body.user.trim() : "";
  if (user === "" || user.length > 64) {
    sendJson(res, 400, { error: "user must be 1 to 64 characters" });
    return;
  }
  if (!TENANTS.some((tenant) => tenant.id === body.tenant)) {
    sendJson(res, 400, { error: "tenant is not known" });
    return;
  }

  forgetOldSessions();
  const token = randomBytes(24).toString("hex");
  sessions.set(token, { user, tenant: body.tenant, expiresAt: Date.now() + TOKEN_TTL_MS });
  sendJson(res, 200, { token, user, tenant: body.tenant, expiresInMs: TOKEN_TTL_MS });
}

async function handleOrderPost(req, res, session) {
  if (faultMode === "slow") {
    await wait(SLOW_DELAY_MS);
  }
  if (faultMode === "reject") {
    sendJson(res, 422, { error: "Insufficient credit" });
    return;
  }
  if (faultMode === "error") {
    sendJson(res, 500, { error: "Internal error" });
    return;
  }

  const body = await readJson(req);
  const problem = body ? orderProblem(body) : "the body must be a JSON object";
  if (problem) {
    sendJson(res, 400, { error: problem });
    return;
  }

  const now = new Date().toISOString();
  const order = {
    id: `ORD-${nextOrderNumber}`,
    user: session.user,
    tenant: session.tenant,
    pair: body.pair,
    side: body.side,
    qty: body.qty,
    status: "working",
    price: null,
    createdAt: now,
    updatedAt: now,
  };
  nextOrderNumber += 1;
  orders.push(order);
  if (orders.length > MAX_ORDERS) {
    const oldest = orders.shift();
    clearTimeout(fillTimers.get(oldest.id));
    fillTimers.delete(oldest.id);
  }
  fillTimers.set(order.id, setTimeout(fill, FILL_DELAY_MS, order));
  sendJson(res, 201, publicOrder(order));
}

function handleOrderDelete(res, session, id) {
  const order = orders.find((candidate) => candidate.id === id && ownedBy(session)(candidate));
  if (!order) {
    sendJson(res, 404, { error: "order not found" });
    return;
  }
  if (order.status !== "working") {
    sendJson(res, 409, { error: `order is already ${order.status}` });
    return;
  }

  clearTimeout(fillTimers.get(order.id));
  fillTimers.delete(order.id);
  order.status = "cancelled";
  order.updatedAt = new Date().toISOString();
  pushOrder(order);
  sendJson(res, 200, publicOrder(order));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const startedAt = Date.now();

  if (path === "/api/__fault" && req.method === "GET") {
    sendJson(res, 200, { mode: faultMode });
    return;
  }
  if (path === "/api/__fault" && req.method === "POST") {
    const mode = url.searchParams.get("mode") ?? "";
    if (!FAULT_MODES.includes(mode)) {
      sendJson(res, 400, { error: `mode must be one of ${FAULT_MODES.join(", ")}` });
      return;
    }
    faultMode = mode;
    console.log(`[fault] mode=${faultMode}`);
    sendJson(res, 200, { mode: faultMode });
    return;
  }
  if (path === "/api/__reset" && req.method === "POST") {
    reset();
    console.log("[control] reset");
    res.writeHead(204).end();
    return;
  }

  if (path === "/api/login" && req.method === "POST") {
    await handleLogin(req, res);
    return;
  }
  if (path === "/api/tenants" && req.method === "GET") {
    sendJson(res, 200, TENANTS);
    return;
  }

  // Each route below needs a known token.
  const token = bearerOf(req);
  const session = sessionOf(token);
  const isOrderRoute = path === "/api/orders" || path.startsWith("/api/orders/");
  if (isOrderRoute) {
    logOrderRequest(req, res, session, startedAt);
  }
  if (!session) {
    sendJson(res, 401, { error: "missing or unknown token" });
    return;
  }

  if (path === "/api/refresh" && req.method === "POST") {
    // The refresh gives a new token for the same session and ends the old token. A stream socket
    // keeps its session, so it stays open, and only its token changes.
    const next = randomBytes(24).toString("hex");
    const refreshed = { ...session, expiresAt: Date.now() + TOKEN_TTL_MS };
    sessions.delete(token);
    sessions.set(next, refreshed);
    for (const socket of sockets) {
      if (socket.token === token) {
        socket.token = next;
        socket.session = refreshed;
      }
    }
    sendJson(res, 200, {
      token: next,
      user: session.user,
      tenant: session.tenant,
      expiresInMs: TOKEN_TTL_MS,
    });
    return;
  }
  if (path === "/api/logout" && req.method === "POST") {
    sessions.delete(token);
    closeSocketsOf(token, "logout");
    res.writeHead(204).end();
    return;
  }
  if (path === "/api/session" && req.method === "GET") {
    sendJson(res, 200, {
      user: session.user,
      tenant: session.tenant,
      expiresInMs: session.expiresAt - Date.now(),
    });
    return;
  }
  if (path === "/api/orders" && req.method === "GET") {
    sendJson(res, 200, orders.filter(ownedBy(session)).map(publicOrder));
    return;
  }
  if (path === "/api/orders" && req.method === "POST") {
    await handleOrderPost(req, res, session);
    return;
  }
  if (path.startsWith("/api/orders/") && req.method === "DELETE") {
    handleOrderDelete(res, session, decodeURIComponent(path.slice("/api/orders/".length)));
    return;
  }
  if (path === "/api/positions" && req.method === "GET") {
    sendJson(res, 200, positionsOf(session));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("[error] a request failed", error);
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });
});

// The first message of a socket must be { type: "auth", token }. A URL token would end up in
// proxy and server logs, so the token never travels in the URL.
const streams = new WebSocketServer({ noServer: true });

streams.on("connection", (socket) => {
  const timer = setTimeout(() => {
    socket.close(CLOSE_UNAUTHORIZED, "auth timeout");
  }, AUTH_TIMEOUT_MS);

  socket.once("message", (data) => {
    clearTimeout(timer);
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      message = null;
    }

    const session = message?.type === "auth" ? sessionOf(message.token) : null;
    if (!session) {
      socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }

    socket.session = session;
    socket.token = message.token;
    sockets.add(socket);
    // The first quotes go out at once, so the ticket doesn't wait for the next tick.
    for (const pair of Object.keys(PAIRS)) {
      socket.send(JSON.stringify(priceMessage(pair)));
    }
  });

  socket.on("close", () => {
    clearTimeout(timer);
    sockets.delete(socket);
  });
  socket.on("error", () => {
    socket.terminate();
  });
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  if (pathname !== "/api/stream") {
    socket.destroy();
    return;
  }

  streams.handleUpgrade(req, socket, head, (ws) => {
    streams.emit("connection", ws, req);
  });
});

function priceMessage(pair) {
  const { bid, ask } = quoteOf(pair);

  return { type: "price", pair, bid, ask, ts: Date.now() };
}

// One random step of up to 0.02 percent of the mid for each pair, about four times a second.
setInterval(() => {
  // A socket keeps its session object. When the token expires, the socket loses its right to
  // the stream, as a request with that token would.
  const now = Date.now();
  for (const socket of sockets) {
    if (socket.session.expiresAt <= now) {
      socket.close(CLOSE_UNAUTHORIZED, "expired");
    }
  }

  for (const [pair, quote] of Object.entries(quotes)) {
    quote.mid = Number((quote.mid * (1 + (Math.random() - 0.5) * 0.0004)).toFixed(quote.digits));
    const text = JSON.stringify(priceMessage(pair));
    for (const socket of sockets) {
      socket.send(text);
    }
  }
}, TICK_MS);

reset();
server.listen(PORT, () => {
  console.log(`mock app API listening on http://localhost:${PORT}/api (stream: /api/stream)`);
});

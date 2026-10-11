# @utk09/ui-observability

Structured logging and UI observability for browsers, embedded webviews and OpenFin containers. The library imports no framework.

The library batches records and sends them over HTTP as OTLP/JSON. It stores a batch that fails to send, and sends it again later. When the page closes, the library sends the records that are left. Iframes, workers and OpenFin windows share one sender through the bus. A log call never throws.

> **Status: early development.** A minor release can change a public API. Pin the exact version.

---

## Installation

```bash
npm install @utk09/ui-observability
```

### Peer Dependencies

Both peers are optional. The library has no runtime dependency.

Install `web-vitals` (`^4 || ^5 || ^6`) for `capture.webVitals`, and set `capture.webVitalsLoader`. Without the loader, the library reports `config.invalid`:

```ts
configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  capture: {
    webVitals: true,
    webVitalsLoader: () => import("web-vitals"),
  },
});
```

Install `@opentelemetry/api` (`^1`) to put records on the traces of your spans. Set `otelLoader` to load it. Without `otelLoader`, OTel is off. The library then makes its own `trace_id`.

The library never imports a peer by name. A missing peer cannot break your bundler or your dev server.

```ts
configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  otelLoader: () => import("@opentelemetry/api"),
});
```

---

## Quick Start

Call `configure()` one time at startup, before the first log call.

```ts
import { configure, getLogger } from "@utk09/ui-observability";

configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  serviceName: "equities-blotter",
  serviceVersion: "2.4.1",
  environment: "production",
});

const log = getLogger("blotter.grid");

log.info("grid ready");
log.logAction("ORDER_SUBMIT", { orderId: "ORD-1001", qty: 100 });
log.error("pricing call failed", caughtError);
```

- `configure()` is idempotent. A later call updates the runtime singleton in place. You cannot change `storage` or `identity` after startup. The library reports that change and ignores it.
- Call `configure()` from one context in each document. A second call changes `service.name` on the records of every other context. In a composed page, the shell calls `configure()`. Each microfrontend uses its own namespace.
- You can call `getLogger()` at module top level, before `configure()`. The logger finds the runtime on its first write.
- A write before the first `configure()` starts a runtime with default settings. It does not throw.
- After `shutdown()`, every call does nothing until the next `configure()`.

### Console Only (No Network)

Set `endpoint: null`. The library sends nothing. It prints records to the console only.

```ts
configure({
  endpoint: null,
  serviceName: "skardela",
  identity: "memory",
  storage: "none",
  bus: { mode: "off" },
  console: import.meta.env.DEV ? "DEBUG" : "WARN",
});
```

- `endpoint: null` loads no transport, no storage and no exit flush. It reports no diagnostic.
- `identity: "memory"` writes no key to `localStorage` or `sessionStorage`.
- `console` and `minLevel` are independent. `console` sets what the library prints. `minLevel` sets what the library sends.
- The console output does not depend on the bus or the endpoint.
- With a `redact` hook, the console shows only what `redact` returns. A record below `minLevel` shows its message and error only, because the library does not build it.

---

## API Reference

### Lifecycle & Setup

| Function            | Description                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `configure(config)` | Starts the runtime singleton, or updates it.                                                          |
| `shutdown()`        | Sends pending records and stops every subsystem. Later calls do nothing until the next `configure()`. |

### Logging Methods

| Function                                       | Description                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `getLogger(namespace, options?)`               | Returns the cached logger for a namespace. With `options`, it returns a new logger that is not cached. |
| `trace(msg, payload?)`                         | Logs a TRACE record.                                                                                   |
| `debug(msg, payload?)`                         | Logs a DEBUG record.                                                                                   |
| `info(msg, payload?)`                          | Logs an INFO record.                                                                                   |
| `warn(msg, payload?)`                          | Logs a WARN record.                                                                                    |
| `error(msg, err?, payload?)`                   | Logs an ERROR record with the error and the breadcrumb trail.                                          |
| `logAction(name, payload?)`                    | Logs one user action.                                                                                  |
| `logEvent(name, payload?)`                     | Logs one domain or lifecycle event.                                                                    |
| `logMetric(name, value, unit?, type?, attrs?)` | Logs a measurement (`gauge`, `counter`, `histogram`).                                                  |
| `timeSync(label, fn, attrs?)`                  | Times a function and emits a duration histogram.                                                       |
| `timeAsync(label, fn, attrs?)`                 | Times a promise and emits a duration histogram.                                                        |

### Context & Correlation

| Function                       | Description                                                   |
| ------------------------------ | ------------------------------------------------------------- |
| `setContext(key, value)`       | Sets one ambient attribute on every later record.             |
| `setContextMap(values)`        | Merges an attribute map into the ambient context.             |
| `removeContext(key)`           | Removes one attribute from the ambient context.               |
| `startJourney(name, options?)` | Starts a journey across windows.                              |
| `endJourney()`                 | Ends the active journey.                                      |
| `currentJourney()`             | Returns the active `Journey`, or null.                        |
| `getJourneyToken()`            | Serializes the active journey into a URL token.               |
| `adoptJourney(token)`          | Adopts a journey token into this context.                     |
| `startTrace()`                 | Rotates the ambient trace context.                            |
| `getTraceHeaders()`            | Returns the W3C `traceparent` header for an outgoing request. |
| `registerWorker(worker)`       | Attaches a Web Worker or MessagePort to the bus.              |

### Delivery & Diagnostics

| Function                  | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `flush()`                 | Sends the records held in the pipeline or the forward buffer. |
| `getQueueDepth()`         | Returns the number of batches in storage.                     |
| `getDiagnosticCounters()` | Returns the count of each diagnostic code.                    |

---

## Configuration Options

No key is required. Set `endpoint` to send records.

| Key                          | Default      | Description                                                                                                                                                  |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `endpoint`                   | `""`         | HTTP endpoint that receives the batches. `null` selects console-only mode. `""` reports `config.invalid`.                                                    |
| `serviceName`                | `""`         | `service.name` on every record.                                                                                                                              |
| `serviceVersion`             | `""`         | `service.version` on every record.                                                                                                                           |
| `environment`                | `""`         | `deployment.environment` on every record.                                                                                                                    |
| `enabled`                    | `true`       | Set `false` to stop all logging. Every log call then does nothing.                                                                                           |
| `minLevel`                   | `"INFO"`     | Lowest level that the library sends (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`).                                                                    |
| `compression`                | `"gzip"`     | `gzip` or `none`. The library compresses a payload above 1 KB only.                                                                                          |
| `serializer`                 | `"otlp"`     | `otlp`, `ecs`, or a custom `LogSerializer`.                                                                                                                  |
| `credentials`                | `"omit"`     | Fetch credentials mode. Set `"include"` for cookie auth.                                                                                                     |
| `headers`                    | `{}`         | Static headers, or a function that returns them.                                                                                                             |
| `storage`                    | `"auto"`     | Store for undelivered batches: `auto`, `indexeddb`, `localstorage`, `memory` or `none`. Fixed at startup.                                                    |
| `identity`                   | `"storage"`  | Store for session, tab and journey ids. `memory` writes no key. Fixed at startup.                                                                            |
| `sampling.defaultRate`       | `1`          | Keep rate for a namespace with no rule.                                                                                                                      |
| `sampling.rates`             | `{}`         | Keep rate per namespace. The longest matching prefix wins.                                                                                                   |
| `sampling.alwaysSampleTypes` | `["action"]` | Record types that ignore the rate.                                                                                                                           |
| `bus.mode`                   | `"auto"`     | `auto`, `sender`, `forwarder` or `off`. With `off`, this context sends its own records and opens no link. A same-origin child frame can still forward to it. |
| `bus.trustedOrigins`         | `[]`         | Origins that may post records from a cross-origin frame.                                                                                                     |
| `bus.openFinRole`            | `"auto"`     | `auto`, `provider` or `client`.                                                                                                                              |
| `capture`                    | See below    | Auto-capture settings.                                                                                                                                       |
| `console`                    | `false`      | Prints records to devtools. `true` prints from `DEBUG` up. A level name prints from that level up. It does not depend on `minLevel`.                         |
| `otelLoader()`               | `undefined`  | Loads `@opentelemetry/api`. Without it, OTel is off.                                                                                                         |
| `redact(record)`             | `undefined`  | Changes a record before the library sends or prints it. Return `null` to drop the record.                                                                    |
| `onDiagnostic(event)`        | `undefined`  | Receives the faults of the library itself.                                                                                                                   |

### Auto-Capture Options

```ts
capture: {
  errors: true,          // Uncaught window.onerror exceptions (default: true)
  rejections: true,      // Unhandled promise rejections (default: true)
  resourceErrors: false, // <img>, <script>, <link> load failures
  fetch: false,          // window.fetch duration and status codes
  xhr: false,            // XMLHttpRequest duration and status codes
  interactions: false,   // Element click breadcrumbs
  navigation: false,     // Single-page navigation URL changes
  webVitals: false,      // Core Web Vitals (LCP, CLS, INP, FCP, TTFB)
  fullUrls: false,       // Keep query strings and fragments on recorded URLs
  ignoreUrls: [],        // URL patterns excluded from network capture
  propagateTraceHeaderTo: [], // Target origins allowed to receive traceparent
}
```

`fullUrls` is off by default. The library then cuts each recorded URL at the first `?` or `#`. This applies to the page URL, the request target and the URL of a failed resource. `ignoreUrls` and `propagateTraceHeaderTo` match the full URL.

### Browser Storage Keys

| Key                            | Store            | Written when                                                     | Option that stops it                          |
| ------------------------------ | ---------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `ui-observability.session`     | `localStorage`   | At startup, then at most one time each minute while logging      | `identity: "memory"`                          |
| `ui-observability.tab`         | `sessionStorage` | At startup, and when the bus finds a duplicated tab              | `identity: "memory"`                          |
| `ui-observability.journey`     | `sessionStorage` | When a journey starts or ends                                    | `identity: "memory"`                          |
| `ui-observability.batch.*`     | `localStorage`   | When a send fails and the `localstorage` adapter holds the batch | `storage` other than `auto` or `localstorage` |
| `ui-observability.emergency.*` | `localStorage`   | When the exit flush cannot send a batch                          | `endpoint: null`                              |
| `ui-observability.probe`       | `localStorage`   | One write and one remove, when the library tests `localStorage`  | `storage` other than `auto` or `localstorage` |

IndexedDB holds undelivered batches with `storage: "auto"` or `"indexeddb"`.

---

## Core Architecture

- **Code splitting:** The main chunk holds the logger, the record builder and the console sink. The delivery stack loads only when you set an endpoint. The bus loads only when the context needs it. Each capture module loads only when you enable it.
- **Document singleton:** The library keeps the runtime at `globalThis[Symbol.for("ui-observability.runtime")]`. Federated microfrontends and separate bundles share one buffer, one sequence and one transport.
- **One sender:** Iframes, workers and OpenFin views find the nearest long-lived context. They forward their records to it over the bus. That context batches, stores and sends for all of them.
- **Five correlation ids:** Each record carries `session.id`, `tab.id`, `context.id`, `journey.id` and `trace_id`.
- **Durability and exit flush:** The library stores a batch that fails to send, in IndexedDB or localStorage. It sends the batch again with exponential backoff and jitter. On `pagehide` or `freeze`, it sends pending records with `navigator.sendBeacon` if they are below 60 KB. A larger payload goes to the emergency queue.
- **Emergency queue:** The emergency queue is best effort. It writes to `localStorage` synchronously, because no other storage works while the page unloads. If the browser refuses the write, the library reports `storage.quota_exceeded`. The library then loses the batch.
- **Configuration after startup:** A second `configure()` call merges the new options into the live runtime. The runtime refuses 3 changes and reports `config.invalid` for each:
  - A change to `storage`. The stored batches stay in the adapter that the runtime built at startup.
  - A change to `identity`. The ids exist from startup.
  - An `endpoint` change to `null` or `""` after the delivery stack loads. Without an endpoint, the stored batches would be lost. A change to another endpoint URL is accepted.
- **Deterministic sampling:** FNV-1a hashing applies one keep rate to a whole journey. An error and an explicit action are always kept.

---

## Ingest Server Requirements

The ingest server must meet these requirements:

1. **Protocol:** Accept `POST` with `Content-Type: application/json` or `text/plain;charset=UTF-8`. `sendBeacon` sends the second one to avoid a CORS preflight.
2. **Preflight:** Answer `OPTIONS` on the ingest path, and allow the request headers:

   ```http
   Access-Control-Allow-Headers: content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt
   ```

   - The transport sends `X-UiObs-Batch-Id` and `X-UiObs-Attempt` with each batch.
   - Above 1 KiB, it also sends `Content-Encoding: gzip`.
   - Each of these headers causes a CORS preflight. If the server does not allow them, each preflight fails.
   - After a failed preflight, the library tries the batch 5 more times. It then drops the batch.
   - Only the exit flush records arrive, because the exit flush sends no custom header.

3. **Deduplication:** Deduplicate on the `X-UiObs-Batch-Id` header and the `uiobs_batch_id` query parameter. Keep the ids for at least 24 hours.
4. **Throttling:** Return `429` or `503` with `Retry-After`. Expose the header with `Access-Control-Expose-Headers: retry-after`.
5. **Status codes:** `200`, `202` and `204` accept the batch. `413` makes the library split the batch. The library drops a batch that gets any other `4xx`.

---

## Development

```bash
npm install
npm run dev      # Playground, mock ingest server and iframe host
npm run verify   # Format check, version sync, typecheck, lint, build and tests
```

- Vanilla playground: `http://localhost:5173/playground/vanilla/index.html`
- Mock ingest server: `http://localhost:8787`

### Example Applications

Build the package first:

```bash
npm run build
npm run example:react          # http://localhost:5180
npm run example:angular        # http://localhost:4200
npm run example:microfrontend  # Shell on http://localhost:5191, remotes on 5192 and 5193
npm run example:console-only   # http://localhost:5195
```

---

## Changelog

[CHANGELOG.md](CHANGELOG.md) holds the released versions and their breaking changes.

---

## License

Apache-2.0. See [LICENSE](LICENSE).

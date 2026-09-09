# @utk09/ui-observability

Structured logging and UI observability for browsers, embedded webviews and OpenFin containers. The library imports no framework.

The library batches records and sends them over HTTP as OTLP/JSON. A failed send persists to storage and retries. A closing document flushes what is left. Iframes, workers and OpenFin windows share one sender through the bus. A log call never throws.

> **Status: early development.** A minor release can change a public API. Pin the exact version.

---

## Installation

```bash
npm install @utk09/ui-observability
```

### Peer Dependencies

Both peers are optional. The library has no runtime dependency.

Install `web-vitals` (`^4 || ^5 || ^6`) for `capture.webVitals`:

```ts
configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  capture: {
    webVitals: true,
    webVitalsLoader: () => import("web-vitals"),
  },
});
```

Install `@opentelemetry/api` (`^1`) to put records on the traces your spans carry. Without it, the library mints its own `trace_id` and reports `trace.otel_failed` one time. The library imports the package when it is installed. Set `otelLoader` when your bundler cannot resolve the import:

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

- `configure()` is idempotent. A later call updates the runtime singleton in place. `storage` is fixed at startup. A later change to it is reported and ignored.
- One context per document calls `configure()`. A second call renames `service.name` on the records of every other context. In a composed page, the shell configures, and each microfrontend takes a namespace.
- A log call before `configure()` goes to an implicit runtime. It does not throw.

---

## API Reference

### Lifecycle & Setup

| Function            | Description                                        |
| ------------------- | -------------------------------------------------- |
| `configure(config)` | Starts the runtime singleton, or updates it.       |
| `shutdown()`        | Flushes pending records and stops every subsystem. |

### Logging Methods

| Function                                       | Description                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `getLogger(namespace, options?)`               | Returns the cached logger for a namespace. With `options`, returns a new one, uncached. |
| `trace(msg, payload?)`                         | Logs a TRACE record.                                                                    |
| `debug(msg, payload?)`                         | Logs a DEBUG record.                                                                    |
| `info(msg, payload?)`                          | Logs an INFO record.                                                                    |
| `warn(msg, payload?)`                          | Logs a WARN record.                                                                     |
| `error(msg, err?, payload?)`                   | Logs an ERROR record with the error and the breadcrumb trail.                           |
| `logAction(name, payload?)`                    | Logs one user action.                                                                   |
| `logEvent(name, payload?)`                     | Logs one domain or lifecycle event.                                                     |
| `logMetric(name, value, unit?, type?, attrs?)` | Logs a measurement (`gauge`, `counter`, `histogram`).                                   |
| `timeSync(label, fn, attrs?)`                  | Times a function and emits a duration histogram.                                        |
| `timeAsync(label, fn, attrs?)`                 | Times a promise and emits a duration histogram.                                         |

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

`endpoint` is the only required key.

| Key                          | Default      | Description                                                                       |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `endpoint`                   | _required_   | HTTP endpoint that receives the batches.                                          |
| `serviceName`                | `""`         | `service.name` on every record.                                                   |
| `serviceVersion`             | `""`         | `service.version` on every record.                                                |
| `environment`                | `""`         | `deployment.environment` on every record.                                         |
| `enabled`                    | `true`       | Kill switch. `false` makes every log call a no-op.                                |
| `minLevel`                   | `"INFO"`     | Lowest level that ships (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`).     |
| `compression`                | `"gzip"`     | `gzip` or `none`. It applies above 1 KB.                                          |
| `serializer`                 | `"otlp"`     | `otlp`, `ecs`, or a custom `LogSerializer`.                                       |
| `credentials`                | `"omit"`     | Fetch credentials mode. Set `"include"` for cookie auth.                          |
| `headers`                    | `{}`         | Static headers, or a function that returns them.                                  |
| `storage`                    | `"auto"`     | `auto`, `indexeddb`, `localstorage`, `memory` or `none`. Fixed at startup.        |
| `sampling.defaultRate`       | `1`          | Keep rate for a namespace with no rule.                                           |
| `sampling.rates`             | `{}`         | Keep rate per namespace. The longest matching prefix wins.                        |
| `sampling.alwaysSampleTypes` | `["action"]` | Record types that ignore the rate.                                                |
| `bus.mode`                   | `"auto"`     | `auto`, `sender`, `forwarder` or `off`.                                           |
| `bus.trustedOrigins`         | `[]`         | Origins that may post records from a cross-origin frame.                          |
| `bus.openFinRole`            | `"auto"`     | `auto`, `provider` or `client`.                                                   |
| `capture`                    | See below    | Auto-capture settings.                                                            |
| `console`                    | `false`      | Mirrors records to devtools. `true` starts at `DEBUG`. A level name starts there. |
| `otelLoader()`               | `undefined`  | Supplies `@opentelemetry/api`. Omit it and the library imports the package.       |
| `redact(record)`             | `undefined`  | Mutates a record before it ships. Return `null` to drop it.                       |
| `onDiagnostic(event)`        | `undefined`  | Receives this library's own faults.                                               |

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

`fullUrls` is off. The library cuts a page URL, a request target and a failed resource URL at the first `?` or `#`. `ignoreUrls` and `propagateTraceHeaderTo` match the whole URL.

---

## Core Architecture

- **Document singleton:** The runtime pins to `globalThis[Symbol.for("ui-observability.runtime")]`. Federated microfrontends and separate bundles share one buffer, one sequence and one transport.
- **One sender:** Iframes, workers and OpenFin views find the nearest long-lived context. They forward their records to it over the bus. That context batches, stores and sends for all of them.
- **Five correlation ids:** Each record carries `session.id`, `tab.id`, `context.id`, `journey.id` and `trace_id`.
- **Durability and exit flush:** A failed send persists to IndexedDB or localStorage, then retries with exponential jittered backoff. On `pagehide` or `freeze`, pending records go out with `navigator.sendBeacon` below 60 KB. A larger payload goes to the emergency queue.
- **Deterministic sampling:** FNV-1a hashing applies one keep rate to a whole journey. An error and an explicit action bypass sampling.

---

## Ingest Server Requirements

The server must obey this contract:

1. **Protocol:** Accept `POST` with `Content-Type: application/json` or `text/plain;charset=UTF-8`. `sendBeacon` sends the second one to avoid a CORS preflight.
2. **Deduplication:** Deduplicate on the `X-UiObs-Batch-Id` header and the `uiobs_batch_id` query parameter. Hold the ids for 24 hours minimum.
3. **Throttling:** Return `429` or `503` with `Retry-After`. Expose the header with `Access-Control-Expose-Headers: retry-after`.
4. **Status codes:** `200`, `202` and `204` accept the batch. `413` makes the client split the batch. Another `4xx` drops the batch.

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
```

---

## Changelog

[CHANGELOG.md](CHANGELOG.md) holds the released versions and their breaking changes.

---

## License

Apache-2.0. See [LICENSE](LICENSE).

# @utk09/ui-observability

Framework-agnostic UI observability and structured logging for browsers, embedded webviews, and OpenFin desktop containers.

Features include automatic batching, compression, persistent offline storage, exponential backoff retries, unload exit flushing, cross-realm bus coordination, and guaranteed never-throw execution. Payloads export as OTLP/JSON over HTTP.

> **Status: Early Development.** Public APIs may change between minor releases. Pin exact versions.

---

## Installation

```bash
npm install @utk09/ui-observability
```

### Peer Dependencies

`web-vitals` (`^4 || ^5 || ^6`) is optional. Install it only when enabling `capture.webVitals`:

```ts
configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  capture: {
    webVitals: true,
    webVitalsLoader: () => import("web-vitals"),
  },
});
```

---

## Quick Start

Initialize once at application startup before logging:

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

- `configure()` is idempotent. Re-calling it updates the existing runtime singleton in place.
- Exactly one context per document calls `configure()`. A second call renames `service.name` on every record the others emit, so in a composed page the shell configures and each microfrontend takes a namespace.
- Calls before `configure()` record safely to an unconfigured implicit runtime without throwing.

---

## API Reference

### Lifecycle & Setup

| Function            | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `configure(config)` | Initializes or updates the active runtime singleton.   |
| `shutdown()`        | Flushes pending records and terminates all subsystems. |

### Logging Methods

| Function                                       | Description                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `getLogger(namespace, options?)`               | Returns a cached `OneLogger` scoped to a namespace.               |
| `trace(msg, payload?)`                         | Logs a TRACE level record.                                        |
| `debug(msg, payload?)`                         | Logs a DEBUG level record.                                        |
| `info(msg, payload?)`                          | Logs an INFO level record.                                        |
| `warn(msg, payload?)`                          | Logs a WARN level record.                                         |
| `error(msg, err?, payload?)`                   | Logs an ERROR record with error instance and breadcrumb snapshot. |
| `logAction(name, payload?)`                    | Logs a discrete user action.                                      |
| `logEvent(name, payload?)`                     | Logs a domain or lifecycle event.                                 |
| `logMetric(name, value, unit?, type?, attrs?)` | Logs a metric measurement (`gauge`, `counter`, `histogram`).      |
| `timeSync(label, fn, attrs?)`                  | Times a synchronous function and emits a duration histogram.      |
| `timeAsync(label, fn, attrs?)`                 | Times an asynchronous promise and emits a duration histogram.     |

### Context & Correlation

| Function                       | Description                                                   |
| ------------------------------ | ------------------------------------------------------------- |
| `setContext(key, value)`       | Sets an ambient attribute on all subsequent records.          |
| `setContextMap(values)`        | Merges an attribute map into the ambient context.             |
| `removeContext(key)`           | Removes an attribute from ambient context.                    |
| `startJourney(name, options?)` | Starts a multi-window user journey workflow.                  |
| `endJourney()`                 | Terminates the active journey.                                |
| `currentJourney()`             | Returns the active `Journey` instance or null.                |
| `getJourneyToken()`            | Serializes the active journey into a cross-context URL token. |
| `adoptJourney(token)`          | Adopts a serialized journey token into the current context.   |
| `startTrace()`                 | Rotates the ambient distributed trace context.                |
| `getTraceHeaders()`            | Returns W3C `traceparent` headers for outgoing HTTP requests. |
| `registerWorker(worker)`       | Attaches a Web Worker or MessagePort to the bus.              |

### Delivery & Diagnostics

| Function                  | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `flush()`                 | Flushes pending records in the pipeline or forward buffer. |
| `getQueueDepth()`         | Returns the number of batches waiting in storage.          |
| `getDiagnosticCounters()` | Returns cumulative occurrence counts per diagnostic code.  |

---

## Configuration Options

`endpoint` is the only required property.

| Key                          | Default                   | Description                                                                                |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `endpoint`                   | _required_                | Target HTTP endpoint URL for log ingestion.                                                |
| `serviceName`                | `""`                      | Service identifier attached to all records.                                                |
| `serviceVersion`             | `""`                      | Application version attached to all records.                                               |
| `environment`                | `""`                      | Deployment environment label (`production`, `staging`).                                    |
| `enabled`                    | `true`                    | Master kill-switch. When `false`, suppresses all logging.                                  |
| `minLevel`                   | `"INFO"`                  | Minimum severity threshold (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`).           |
| `streams.logs`               | `2000` ms, `100` records  | Flush interval and batch limit for standard logs.                                          |
| `streams.metrics`            | `10000` ms, `500` records | Flush interval and batch limit for metrics.                                                |
| `compression`                | `"gzip"`                  | Compression algorithm (`gzip`, `none`). Applies above `compressionThresholdBytes`, `1024`. |
| `serializer`                 | `"otlp"`                  | Wire format (`otlp`, `ecs`, or custom `LogSerializer`).                                    |
| `credentials`                | `"include"`               | Fetch credentials policy.                                                                  |
| `headers`                    | `{}`                      | Static headers or dynamic header resolver function.                                        |
| `maxConcurrentRequests`      | `2`                       | Maximum concurrent in-flight HTTP requests.                                                |
| `requestTimeoutMs`           | `15000`                   | HTTP request timeout in milliseconds.                                                      |
| `storage.strategy`           | `"auto"`                  | Persistence engine (`auto`, `indexeddb`, `localstorage`, `memory`, `none`).                |
| `storage.maxBatches`         | `500`                     | Maximum batches stored offline before FIFO pruning.                                        |
| `storage.maxAgeMs`           | `86400000` (24h)          | Maximum offline batch retention in milliseconds.                                           |
| `storage.maxAttempts`        | `5`                       | Maximum redelivery attempts before dead-letter drop.                                       |
| `retry.baseDelayMs`          | `2000`                    | Initial exponential backoff delay.                                                         |
| `retry.maxDelayMs`           | `60000`                   | Maximum backoff delay ceiling.                                                             |
| `sampling.defaultRate`       | `1`                       | Keep rate applied when no namespace rule matches.                                          |
| `sampling.rates`             | `{}`                      | Per-namespace keep rates, longest matching prefix wins.                                    |
| `sampling.alwaysSampleTypes` | `["action"]`              | Record types kept regardless of rate.                                                      |
| `journey.maxAgeMs`           | `1800000` (30m)           | Maximum journey duration.                                                                  |
| `bus.mode`                   | `"auto"`                  | Bus role (`auto`, `sender`, `forwarder`, `off`).                                           |
| `capture`                    | See below                 | Browser auto-instrumentation settings.                                                     |
| `limits.maxRecordBytes`      | `32768` (32 KB)           | Per-record size ceiling before truncation.                                                 |
| `console.enabled`            | `false`                   | Mirrors formatted records to browser devtools.                                             |
| `redact(record)`             | `undefined`               | Hook to mutate or drop (`null`) records before ingest.                                     |
| `onDiagnostic(event)`        | `undefined`               | Listener for internal diagnostics and telemetry faults.                                    |

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
  ignoreUrls: [],        // URL patterns excluded from network capture
  propagateTraceHeaderTo: [], // Target origins allowed to receive traceparent
}
```

---

## Core Architecture

- **Document Singleton:** The runtime pins to `globalThis[Symbol.for("ui-observability.runtime")]`. Federated microfrontends and separate bundles share one ring buffer, sequence generator, and transport.
- **Single Sender Coordination:** Iframes, Web Workers, and OpenFin views discover the nearest long-lived context and forward records across the bus. That one context handles batching, storage, and network delivery for all of them.
- **Five Correlation Dimensions:** Every record maps to `session.id`, `tab.id`, `context.id`, `journey.id`, and `trace_id`.
- **Durability & Exit Flush:** Failed deliveries persist to IndexedDB/LocalStorage and retry with exponential jittered backoff. During `pagehide` or `freeze`, pending records drain via `navigator.sendBeacon` (under a 60 KB threshold) or persist to emergency storage.
- **Deterministic Journey Sampling:** FNV-1a hashing applies sampling rates consistently across entire journeys. Errors and explicit actions bypass sampling filters.

---

## Ingest Server Requirements

Receiving servers must implement the following contract:

1. **Protocol & Method:** Accept HTTP `POST` requests with `Content-Type: application/json` or `Content-Type: text/plain;charset=UTF-8` (used by `sendBeacon` to avoid CORS preflights).
2. **Idempotency & Deduplication:** Deduplicate on `X-UiObs-Batch-Id` header and `uiobs_batch_id` query parameter for at least 24 hours.
3. **Throttling & CORS:** Return `429` or `503` with a `Retry-After` header, and expose it via `Access-Control-Expose-Headers: retry-after`.
4. **Payload Handling:**
   - `200`, `202`, or `204`: Accepted.
   - `413`: Payload too large. Prompts client batch splitting.
   - `4xx`: Non-retryable client error. Drops batch.

---

## Development

```bash
npm install
npm run dev      # Starts playground, mock ingest server, and iframe host
npm run verify   # Runs format check, typecheck, lint, build, and tests
```

- Vanilla playground: `http://localhost:5173/playground/vanilla/index.html`
- Mock ingest server: `http://localhost:8787`

### Example Applications

Build the package before running framework examples:

```bash
npm run build
npm run example:react          # http://localhost:5180
npm run example:angular        # http://localhost:4200
npm run example:microfrontend  # Shell on http://localhost:5191, remotes on 5192/5193
```

---

## License

Apache-2.0. See [LICENSE](LICENSE).

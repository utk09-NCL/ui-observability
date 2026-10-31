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

- `configure()` is idempotent. A later call updates the runtime singleton in place. You cannot change `storage`, `identity`, `batching`, `retention`, `limits` or `journey.maxAgeMs` after startup. The library reports that change and ignores it.
- Call `configure()` from one context in each document. A second call changes `service.name` on the records of every other context. In a composed page, the shell calls `configure()`. Each microfrontend uses its own namespace.
- You can call `getLogger()` at module top level, before `configure()`. The logger finds the runtime on its first write.
- A write before the first `configure()` starts a runtime with default settings. It does not throw. The first `configure()` then sets `limits` and `journey.maxAgeMs` of that runtime.
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
- With a `redact` hook, the console shows only what `redact` returns. A record that a processor or `redact` drops prints no line. A record below `minLevel` shows its message and error only, because the library does not build it.

### Console Output

Each console line has the form `[namespace][LEVEL] message payload`:

```text
[app.puzzle-page][INFO] The puzzle page loaded {puzzleId: 'colour-binary-0006', difficulty: 'easy'}
```

The namespace and the level each have a color. To change the colors, use the object form of `console`:

```ts
configure({
  console: {
    level: "DEBUG",
    styles: {
      namespace: "color:#888",
      INFO: "color:#0a7;font-weight:bold",
      WARN: "color:#c80;font-weight:bold",
    },
  },
});
```

- Each style is a CSS string. A browser applies it with `%c`. Node prints the text without the style.
- A style can set the text color and the background together. This example shows the level as a badge:

  ```ts
  configure({
    console: {
      styles: {
        INFO: "color:#fff;background:#1e6fd9;padding:0 4px;border-radius:3px",
        ERROR: "color:#fff;background:#d32f2f;padding:0 4px;border-radius:3px",
      },
    },
  });
  ```

- The style keys are `namespace`, `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` and `FATAL`. A key that you do not set keeps its style.
- The default namespace color is gray. The default levels are gray for `TRACE` and `DEBUG`, blue for `INFO`, orange for `WARN`, and red for `ERROR` and `FATAL`.
- A later `configure({ console: "WARN" })` changes the level. The styles stay.
- A later `configure({ console: { styles } })` changes the styles. The level stays.

### Custom Transport

Set `transport` to send batches through a channel of your app, for example an API client with token refresh, a WebSocket, Electron IPC or an OpenFin channel. With `transport`, `endpoint` is optional.

```ts
configure({
  serviceName: "equities-blotter",
  transport: async (request) => {
    const response = await apiClient.post("/telemetry", request.body, {
      headers: { "Content-Type": request.contentType, "X-UiObs-Batch-Id": request.batchId },
    });
    const retryAfterSeconds = Number(response.headers["retry-after"]);
    return { status: response.status, retryAfterMs: retryAfterSeconds * 1000 };
  },
  // Optional. It runs while the page closes, so it must not wait for a promise.
  transportOnExit: (request) => navigator.sendBeacon("/telemetry", request.body),
  // Network capture must not log the requests of your transport.
  capture: { ignoreUrls: ["/telemetry"] },
});
```

- The library keeps batching, retry, storage, splitting and the exit flush.
- The status code that you return has the meaning of the ingest contract. `2xx` accepts the batch. `413` splits it. `429` and `503` throttle. `408` and `5xx` retry. Each other code drops the batch.
- A rejected promise counts as a network error. The library sends the batch again later. A call that does not settle in 15 seconds counts as a timeout.
- The library does not compress `request.body`. Compress it in your transport if necessary.
- `request.records` holds the built records after `redact`. Do not change them, because the retry engine can send them again.
- `request.kind` is `"metrics"` for a batch of metric records when `metricsEndpoint` is set. `request.body` is then an OTLP `ExportMetricsServiceRequest`. Send it to your metrics endpoint.
- `request.kind` is `"traces"` for a batch of span records. `request.body` is then an OTLP `ExportTraceServiceRequest`. Send it to your traces endpoint. Each other batch has the kind `"logs"`.
- Without `transportOnExit`, the last batch goes to the emergency queue when the page closes. The next page load sends it.
- With `storage: "none"`, the next page load cannot keep that batch. Set `transportOnExit`, or the library loses the last batch.
- The library ignores a `retryAfterMs` or a `maxBytes` that is not a finite number. It uses 0 for a negative value.
- After the delivery stack loads, you cannot add or remove `transport`. You can replace it with another function.
- Network capture skips a request that your transport starts before its first `await`. Put your telemetry URL in `capture.ignoreUrls` too. A request after an `await` is outside that scope.
- Without that URL in `capture.ignoreUrls`, each send records a value of the `http.client.request.duration` histogram. That value causes the next send, and the sends do not stop. Network capture reports `capture.transport_request` one time when it sees a request during a transport call.

### Testing

Use `createMemoryTransport()` to check what your code logs. It needs no network and no `fetch` mock.

```ts
import {
  configure,
  createMemoryTransport,
  flush,
  getLogger,
  shutdown,
} from "@utk09/ui-observability";

const memory = createMemoryTransport();

beforeEach(() => {
  configure({
    serviceName: "orders",
    transport: memory.transport,
    storage: "none",
    bus: { mode: "off" },
    identity: "memory",
  });
});

afterEach(async () => {
  memory.clear();
  await shutdown();
});

it("logs the order submit", async () => {
  getLogger("orders.ticket").logAction("ORDER_SUBMIT", { orderId: "ORD-1" });
  await flush();

  expect(memory.records()).toContainEqual(expect.objectContaining({ body: "ORDER_SUBMIT" }));
});
```

- `records()` returns the records of each accepted batch. `batches()` returns each request, accepted or refused.
- `respondWith(status, retryAfterMs?)` sets the answer for each later batch. Use it to test a `413`, `429` or `500` answer. The default answer is `200`.
- `flush()` waits for startup. A record that you log directly after `configure()` is in the flushed batch.
- After `shutdown()`, each call does nothing until the next `configure()`.
- Set `storage: "none"` in tests. Without it, `shutdown()` stores the unsent records, and the next test can receive them.

---

### Remote Sampling

With `sampling: { remote: true }`, the ingest server can change the sampling during an incident. You do not deploy the app again.

```http
X-UiObs-Sampling: {"v":1,"ttlMs":600000,"defaultRate":0.1,"rates":{"blotter.grid":1},"minLevel":"DEBUG"}
```

- The library reads the header only on a `2xx` answer to a batch that it sent. A custom transport returns the rules in `TransportResponse.sampling`, as text or as an object.
- `v` must be `1`. `ttlMs` is mandatory, from more than 0 to 3,600,000 (1 hour). After the TTL, the rules from `configure()` apply again.
- `rates` apply over the `configure()` rates. The other `configure()` rates stay. `defaultRate` applies only if the header has it.
- `minLevel` can only lower the level that the library sends. It does not change the console level.
- `minLevels` sets a level for each namespace prefix, for example `{"trading.ticks":"DEBUG"}`. A remote prefix wins over the remote `minLevel`. A remote level applies only when it is lower than the `configure()` level of the namespace. At most 100 prefixes.
- `sampling.remoteMaxRate` caps each remote rate. It also caps the records that a remote `minLevel` adds. Set it below 1 to limit the traffic that a compromised server can cause.
- The library rejects all the rules if one field is not valid, for example a rate outside 0 to 1, more than 100 `rates` or a header longer than 4096 characters. It reports `config.invalid`.
- The library keeps the rules in memory only. A reload uses the `configure()` rules until the next accepted batch.
- A child frame, a worker or an OpenFin view asks its owner for the rules at start and each 30 seconds. Set `sampling.remote: true` in each context.
- A frame accepts rules from a parent only if the parent origin is the page origin or is in `bus.trustedOrigins`. A page that embeds your app cannot lower `minLevel`.
- Each OpenFin view of one app can read the bus messages of the others. Load only trusted content into a view that has the `fin` API.

## API Reference

### Lifecycle & Setup

| Function            | Description                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `configure(config)` | Starts the runtime singleton, or updates it.                                                          |
| `shutdown()`        | Sends pending records and stops every subsystem. Later calls do nothing until the next `configure()`. |

### Logging Methods

| Function                                       | Description                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getLogger(namespace, options?)`               | Returns the cached logger for a namespace. With `options`, it returns a new logger that is not cached.                                               |
| `trace(msg, payload?)`                         | Logs a TRACE record.                                                                                                                                 |
| `debug(msg, payload?)`                         | Logs a DEBUG record.                                                                                                                                 |
| `info(msg, payload?)`                          | Logs an INFO record.                                                                                                                                 |
| `warn(msg, payload?)`                          | Logs a WARN record.                                                                                                                                  |
| `error(msg, err?, payload?)`                   | Logs an ERROR record with the error and the breadcrumb trail.                                                                                        |
| `fatal(msg, err?, payload?)`                   | Logs a FATAL record with the error and the breadcrumb trail.                                                                                         |
| `logAction(name, payload?)`                    | Logs one user action.                                                                                                                                |
| `logEvent(name, payload?)`                     | Logs one domain or lifecycle event.                                                                                                                  |
| `logMetric(name, value, unit?, type?, attrs?)` | Logs a measurement (`gauge`, `counter`, `histogram`).                                                                                                |
| `counter(name, { unit? })`                     | Gives a counter. `add(value, attrs?)` sums a value of 0 or larger in memory. The library sends one point for each attribute set at each interval.    |
| `histogram(name, { unit?, boundaries? })`      | Gives a histogram. `record(value, attrs?)` counts a value in buckets in memory. The library sends one point for each attribute set at each interval. |
| `timeSync(label, fn, attrs?)`                  | Times a function and emits a duration histogram with `status` `SUCCESS` or `FAILURE`.                                                                |
| `timeAsync(label, fn, attrs?)`                 | Times a promise and emits a duration histogram with `status` `SUCCESS` or `FAILURE`.                                                                 |

The level methods give records with `log.type: "log"`. Records of the library itself have `log.type: "system"`. `logMetric` drops a value that is not finite and counts `record.dropped_malformed`.

`counter` and `histogram` sum their values for `batching.metricFlushIntervalMs`. Then they send one point for each attribute set. 1000 calls of `add(1)` give one point with the value 1000. Sampling and `minLevel` do not drop a point. The console does not print it. Each instrument keeps at most 100 attribute sets in each interval. The values of more sets go to one set with `otel.metric.overflow: true`. Attribute values must be strings, finite numbers or booleans. The library drops an attribute key that starts with `metric.`. It also drops the keys that it sets on each record, for example `page.url` and `log.type`. The record limits do not cut the metric fields of a point, for example the bucket counts. `redact` cannot change them. Do not use a user id or a URL as an attribute. Each value makes a new series in the backend. The default histogram boundaries are `[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`. The points of the open interval go out at `flush()`, at `shutdown()` and before the exit flush. A frame that forwards its records sends its points at the interval, at `flush()` and at `shutdown()` only.

### Context & Correlation

| Function                        | Description                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setContext(key, value)`        | Sets one ambient attribute on every later record.                                                                                                                                                         |
| `setContextMap(values)`         | Merges an attribute map into the ambient context.                                                                                                                                                         |
| `removeContext(key)`            | Removes one attribute from the ambient context.                                                                                                                                                           |
| `addBreadcrumb(message, data?)` | Adds a breadcrumb with the category `custom`. The next error record carries the trail. The library copies `data` at the call.                                                                             |
| `startJourney(name, options?)`  | Starts a journey across windows. `options.parent: true` links the active journey as the parent. `options.id` sets the id, 1 to 64 characters. Another value gives a new id and a `config.invalid` report. |
| `endJourney()`                  | Ends the active journey.                                                                                                                                                                                  |
| `currentJourney()`              | Returns the active `Journey`, or null.                                                                                                                                                                    |
| `getJourneyToken()`             | Serializes the active journey into a URL token.                                                                                                                                                           |
| `adoptJourney(token)`           | Adopts a journey token into this context.                                                                                                                                                                 |
| `startTrace()`                  | Rotates the ambient trace context.                                                                                                                                                                        |
| `getTraceHeaders()`             | Returns the W3C `traceparent` header for an outgoing request.                                                                                                                                             |
| `registerWorker(worker)`        | Attaches a Web Worker or MessagePort to the bus.                                                                                                                                                          |
| `newSession()`                  | Starts a new session in this tab, for example after a logout. It ends the active journey and starts a new trace. Other tabs read the new id at their next startup.                                        |

### Delivery & Diagnostics

| Function                  | Description                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flush()`                 | Sends the records held in the pipeline or the forward buffer, and waits for the batches in flight.                                                                                                                                                                                                                       |
| `getQueueDepth()`         | Returns the number of batches in storage.                                                                                                                                                                                                                                                                                |
| `getStats()`              | Returns `{ pending, inFlight, stored, lastSendAt }`. `pending` counts the records in the buffers. `inFlight` counts the records in requests. `stored` counts the batches in storage. `lastSendAt` is the epoch time in ms of the last batch that the server accepted, or null. A forwarder reports only its own buffers. |
| `getDiagnosticCounters()` | Returns the count of each diagnostic code.                                                                                                                                                                                                                                                                               |

---

## Configuration Options

No key is required. Set `endpoint` to send records. A value of the wrong type or outside its range reports `config.invalid`. The value in force stays. Level names can have any case. You cannot change `batching` and `retention` after the delivery stack loads. You cannot change `limits` and `journey.maxAgeMs` after the first `configure()`.

| Key                              | Default      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`                       | `""`         | HTTP endpoint that receives the batches. `null` selects console-only mode. `""` reports `config.invalid`.                                                                                                                                                                                                                                                                                                                                               |
| `metricsEndpoint`                | `""`         | OTLP metrics endpoint, for example `https://ingest.example/v1/metrics`. With it, each batch of metric records goes there as an OTLP `ExportMetricsServiceRequest`. Without it, metric records are log records on `endpoint`. It needs `serializer: "otlp"`, and `endpoint` or `transport`.                                                                                                                                                              |
| `tracesEndpoint`                 | `""`         | OTLP traces endpoint, for example `https://ingest.example/v1/traces`. With it, the library records spans and sends them there as an OTLP `ExportTraceServiceRequest`. Without it, the library sends no span. It needs `serializer: "otlp"`, and `endpoint` or `transport`. See [Spans](#spans).                                                                                                                                                         |
| `serviceName`                    | `""`         | `service.name` on every record.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `serviceVersion`                 | `""`         | `service.version` on every record.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `environment`                    | `""`         | `deployment.environment` on every record.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `enabled`                        | `true`       | Set `false` to stop all logging. Every log call then does nothing.                                                                                                                                                                                                                                                                                                                                                                                      |
| `minLevel`                       | `"INFO"`     | Lowest level that the library sends (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`). It does not drop actions and metrics.                                                                                                                                                                                                                                                                                                                         |
| `minLevels`                      | `{}`         | Lowest level for each namespace prefix, for example `{ "trading.ticks": "DEBUG" }`. The longest matching prefix wins. A prefix matches its own namespace and the namespaces below it after a dot. A namespace with no match uses `minLevel`. A new map replaces the map in force.                                                                                                                                                                       |
| `compression`                    | `"gzip"`     | `gzip` or `none`. The library compresses a payload above 1 KB only.                                                                                                                                                                                                                                                                                                                                                                                     |
| `serializer`                     | `"otlp"`     | `otlp`, `ecs`, or a custom `LogSerializer`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `credentials`                    | `"omit"`     | Fetch credentials mode. Set `"include"` for cookie auth.                                                                                                                                                                                                                                                                                                                                                                                                |
| `headers`                        | `{}`         | Static headers, or a function that returns them. After a 401 or 403, a function gets one more call and the batch one more send. The exit flush sends the last headers. Before a function gives its first result, the exit flush puts the batch in the emergency queue. `headers: undefined` removes the headers.                                                                                                                                        |
| `storage`                        | `"auto"`     | Store for undelivered batches: `auto`, `indexeddb`, `localstorage`, `memory` or `none`. Fixed at startup.                                                                                                                                                                                                                                                                                                                                               |
| `identity`                       | `"storage"`  | Store for session, tab and journey ids. `memory` writes no key. Fixed at startup.                                                                                                                                                                                                                                                                                                                                                                       |
| `sampling.defaultRate`           | `1`          | Keep rate for a namespace with no rule.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sampling.rates`                 | `{}`         | Keep rate per namespace. The longest matching prefix wins.                                                                                                                                                                                                                                                                                                                                                                                              |
| `sampling.alwaysSampleTypes`     | `["action"]` | Record types that ignore the rate.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sampling.remote`                | `false`      | Reads sampling rules from the `X-UiObs-Sampling` header of each accepted batch (see Remote Sampling).                                                                                                                                                                                                                                                                                                                                                   |
| `sampling.remoteMaxRate`         | `1`          | Highest rate that a remote rule can set. It applies to the remote `defaultRate` and to each remote namespace rate.                                                                                                                                                                                                                                                                                                                                      |
| `bus.mode`                       | `"auto"`     | `auto`, `sender`, `forwarder` or `off`. With `off`, this context sends its own records and opens no link. A same-origin child frame can still forward to it.                                                                                                                                                                                                                                                                                            |
| `bus.trustedOrigins`             | `[]`         | Origins of other documents that this document trusts. A parent accepts records from a child frame on these origins. A cross-origin child frame forwards its records only to a parent on these origins. The library keeps the origin of each URL. For a sandboxed frame, set `bus.mode: "sender"` in the frame. A trusted origin is also trusted for metric points. Its points bypass the sampling and the limit of 100 attribute sets of this document. |
| `bus.openFinRole`                | `"auto"`     | `auto`, `provider` or `client`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `journey.scope`                  | `"auto"`     | Which contexts adopt a journey. `context`: each context keeps its own. `tab`: a frame or a worker adopts the journey of its owner. `origin`: each context of the origin, also in other tabs. `auto` is `origin` in OpenFin and `tab` in a browser.                                                                                                                                                                                                      |
| `journey.maxAgeMs`               | `1800000`    | Maximum open time of a journey, in milliseconds. Then the library ends it. The range is 60000 to 86400000.                                                                                                                                                                                                                                                                                                                                              |
| `batching.logFlushIntervalMs`    | `2000`       | Maximum wait of a partial log batch, in milliseconds. The range is 100 to 60000.                                                                                                                                                                                                                                                                                                                                                                        |
| `batching.logBatchSize`          | `100`        | Maximum records in one log batch. The range is 1 to 1000.                                                                                                                                                                                                                                                                                                                                                                                               |
| `batching.metricFlushIntervalMs` | `10000`      | Maximum wait of a partial metric batch, in milliseconds. The range is 100 to 60000.                                                                                                                                                                                                                                                                                                                                                                     |
| `batching.metricBatchSize`       | `500`        | Maximum records in one metric batch. The range is 1 to 1000.                                                                                                                                                                                                                                                                                                                                                                                            |
| `retention.mode`                 | `"limited"`  | `limited` or `until-delivered`. With `until-delivered`, a stored batch has no age limit and no attempt limit. `retention.maxBatches` still applies. A permanent error still drops the batch. A batch that always gets a temporary error stays first. The batches of the same endpoint behind it wait.                                                                                                                                                   |
| `retention.maxBatches`           | `500`        | Maximum stored batches. A new batch evicts the oldest batch without an action first. The range is 1 to 5000.                                                                                                                                                                                                                                                                                                                                            |
| `retention.maxAgeMs`             | `86400000`   | Maximum age of a stored batch, in milliseconds. The range is 60000 to 604800000.                                                                                                                                                                                                                                                                                                                                                                        |
| `retention.maxAttempts`          | `5`          | Maximum send attempts of a stored batch. The range is 1 to 20.                                                                                                                                                                                                                                                                                                                                                                                          |
| `limits.maxBodyChars`            | `4096`       | Maximum body length, in characters. The range is 256 to 65536.                                                                                                                                                                                                                                                                                                                                                                                          |
| `limits.maxAttributeChars`       | `8192`       | Maximum length of a string attribute, in characters. The range is 256 to 65536.                                                                                                                                                                                                                                                                                                                                                                         |
| `limits.maxAttributeCount`       | `128`        | Maximum keys in one object. The range is 1 to 1024.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `limits.maxStackChars`           | `8192`       | Maximum length of an error stack, in characters. The range is 256 to 65536.                                                                                                                                                                                                                                                                                                                                                                             |
| `limits.maxDepth`                | `6`          | Maximum depth of a nested value. The range is 1 to 16.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `limits.maxArrayLength`          | `100`        | Maximum items in one array, set or map. The range is 1 to 10000.                                                                                                                                                                                                                                                                                                                                                                                        |
| `limits.maxNodes`                | `10000`      | Maximum values in one sanitize pass. The range is 100 to 100000.                                                                                                                                                                                                                                                                                                                                                                                        |
| `limits.maxRecordBytes`          | `32768`      | Maximum attribute bytes of one record. Above it, the library drops the caller attributes. The range is 1024 to 60000.                                                                                                                                                                                                                                                                                                                                   |
| `capture`                        | See below    | Auto-capture settings.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `console`                        | `false`      | Prints records to devtools. `true` prints from `DEBUG` up. A level name prints from that level up. An object sets `level` and `styles` (see Console Output). It does not depend on `minLevel`.                                                                                                                                                                                                                                                          |
| `transport(request)`             | `undefined`  | Sends batches through a channel of your app in place of HTTP (see Custom Transport).                                                                                                                                                                                                                                                                                                                                                                    |
| `transportOnExit(request)`       | `undefined`  | Sends the last batch while the page closes. It must return a boolean and must not wait.                                                                                                                                                                                                                                                                                                                                                                 |
| `otelLoader()`                   | `undefined`  | Loads `@opentelemetry/api`. Without it, OTel is off.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `contextProvider()`              | `undefined`  | Returns attributes for each record that sampling keeps, for example the current route. Its values override `setContext()` values. The logger scope and the call payload override its values. Keep it fast and synchronous. A provider that throws reports `handler.threw`. A value that is not an object reports `config.invalid`. The record is still built.                                                                                           |
| `processors`                     | `[]`         | Functions that change or drop a record. They run in list order, before `redact`. A processor has the contract of `redact`. Return the record or a new record to keep it, or `null` to drop it. If a processor throws or returns a value that is not a record, the library drops the record. It counts `record.dropped_by_processor`. A new list replaces the list in force.                                                                             |
| `redact(record)`                 | `undefined`  | Changes a record before the library sends or prints it. Return `null` to drop the record. If the hook throws or returns a value that is not a record, the library drops the record. It counts `record.dropped_by_redact`.                                                                                                                                                                                                                               |
| `onDiagnostic(event)`            | `undefined`  | Receives the faults of the library itself.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `onDrop(summary)`                | `undefined`  | Receives a summary when the library loses records that it built. The summary has `reason`, `records`, `batchIds`, `journeyIds` and `actions`. Sampling, `minLevel`, `processors` and `redact` do not cause a loss. Do not log through the library in the hook. A record from the hook can evict a stored batch. A batch that storage evicts during its send can still reach the server.                                                                 |

### Auto-Capture Options

```ts
capture: {
  errors: true,          // Uncaught window.onerror exceptions (default: true)
  rejections: true,      // Unhandled promise rejections (default: true)
  resourceErrors: false, // <img>, <script>, <link> load failures
  fetch: false,          // window.fetch duration and status codes
  xhr: false,            // XMLHttpRequest duration and status codes
  httpMetrics: true,     // http.client.request.duration histogram of fetch and xhr requests, in seconds.
                         // Attributes: http.request.method, http.response.status_code, server.address, error.type
  interactions: false,   // Element click breadcrumbs
  navigation: false,     // Single-page navigation URL changes
  webVitals: false,      // Core Web Vitals (LCP, CLS, INP, FCP, TTFB)
  longFrames: false,     // Frames that freeze the page, as ui.long_frame.duration
  longFrameThresholdMs: 100, // Minimum frame duration that longFrames records
  console: false,        // App console calls: true, or a list such as ["error", "warn", "info"]
  fullUrls: false,       // Keep query strings and fragments on recorded URLs
  ignoreUrls: [],        // URL patterns excluded from network capture
  propagateTraceHeaderTo: [], // Origins, or RegExp patterns, that receive traceparent
  webSocket: false,      // WebSocket open, close and error, and ui.websocket.messages
  plugins: [],           // Capture plugins of your app
}
```

`longFrames` records each frame at or above `longFrameThresholdMs` as the histogram `ui.long_frame.duration`. Each long frame also adds a breadcrumb. The next error record then shows the freeze before it.

- The library observes `long-animation-frame`. A browser without it gives `longtask` entries, with no script attributes.
- The attributes are `frame.type`, `frame.blocking_ms`, `frame.script.invoker` and `frame.script.source`. The source URL follows `fullUrls`.
- The library records at most 20 long frames in each 10-second window.

`capture.console` records the console calls of your app and of third-party code. It is different from the top-level `console` option, which prints records.

> **Set `redact` before you turn on `capture.console`.** A call such as `console.error("Request failed", error.response)` sends the request headers, for example `Authorization`. Third-party code on the page writes such lines too.

- `true` wraps `console.error` and `console.warn`. A list selects from `error`, `warn`, `info` and `log`.
- `error` gives an ERROR record, and `warn` gives a WARN record. `info` and `log` give a breadcrumb only.
- The first string is the message. The first `Error` of an `error` call gives the `error.*` fields. The other arguments go into `console.args`.
- The wrapper calls the original method first. Devtools shows the same text. The source link of the line points to the library wrapper.
- The library does not record the lines that it prints itself.
- The library records at most 20 `error` and `warn` calls in each 10-second window. The error capture has a separate limit. Console noise cannot hide an uncaught error.
- To record an argument, the library reads each property, also a getter. A getter with a side effect then runs during the console call.
- On `shutdown()`, the library restores each method. If another script wrapped the method later, the library leaves it and reports `capture.install_failed`.

`webSocket` records the lifecycle of each WebSocket that the app opens after the capture loads.

- `websocket.open` and `websocket.close` are events. `websocket.error` is a WARN record. Each has `url.full` and `server.address`.
- `websocket.close` adds `websocket.close.code` and `websocket.close.clean`.
- `url.full` has no user info, no query and no fragment, also with `fullUrls`. A socket URL often holds a token.
- The counter `ui.websocket.messages` counts the messages, with `network.io.direction` (`transmit` or `receive`) and `server.address`.
- The library never reads the content of a message.
- The library records at most 20 lifecycle records in each 10-second window. The counter counts each message.

`plugins` adds your own capture modules. A plugin is an object with `name`, `install(ctx)` and `uninstall()`.

- `ctx` gives `logger`, `counter()`, `histogram()`, `addBreadcrumb()` and `ownRequest(fn)`. The logger namespace is `uiobs.capture.<name>`.
- `ownRequest(fn)` runs `fn`. The network capture does not record a request that `fn` starts before its first `await`, and does not add `traceparent` to it.
- A `configure()` that changes the capture section calls `uninstall()`, then `install(ctx)` again. `shutdown()` calls `uninstall()`.
- If `install()` or `uninstall()` throws, the library reports `capture.install_failed`. The other capture modules keep working.
- The console-only runtime next to another version of the library installs no plugin.

```ts
import { type CapturePlugin, configure } from "@utk09/ui-observability";

let onChange: (() => void) | undefined;

const visibility: CapturePlugin = {
  name: "visibility",
  install(ctx) {
    onChange = () => {
      ctx.logger.logEvent("page.visibility", { state: document.visibilityState });
    };
    document.addEventListener("visibilitychange", onChange);
  },
  uninstall() {
    if (onChange) {
      document.removeEventListener("visibilitychange", onChange);
    }
  },
};

configure({ endpoint: "https://ingest.example/v1/logs", capture: { plugins: [visibility] } });
```

`fullUrls` is off by default. The library then cuts each recorded URL at the first `?` or `#`. This applies to the page URL, the request target and the URL of a failed resource. `ignoreUrls` and a RegExp in `propagateTraceHeaderTo` match the full URL.

A string in `propagateTraceHeaderTo` is an origin, for example `"https://api.example"`. It matches a request to that origin only. A URL with a path gives its origin. A relative request URL resolves against the page. To match a path, use a RegExp. A RegExp tests the request URL in the form that the caller gives. Start each RegExp with `^`. Without it, `/\/api\//` also matches `https://vendor.example/api/`. For example, `/^https:\/\/api\.example\/v2\//` matches one path on one origin. `/^\/api\//` matches a relative request URL only.

### Spans

With `tracesEndpoint`, the library sends spans. The backend then has a root span for each trace of the library.

- **Root span:** Each ambient trace has one root span of kind INTERNAL. It starts with the trace and ends when the trace rotates. Its name tells why the trace started: `ui.start`, `ui.interaction`, `ui.navigation` or `ui.trace`.
- **Client span:** Each `fetch` or XHR request that gets `traceparent` from `capture.propagateTraceHeaderTo` has one span of kind CLIENT. The `traceparent` names the client span, and the root span is its parent. Its name is the HTTP method. Its attributes are `http.request.method`, `url.full`, `server.address`, `http.response.status_code` and `error.type`. A status of 0 or 400 and more sets the status ERROR.
- **Sampling:** `sampling.defaultRate` samples each trace by its trace id. The whole trace stays or goes. `minLevel` does not apply to a span. For a trace that sampling drops, the `traceparent` has the sampled flag off. A downstream service then drops its spans too.
- **Exit:** The exit flush and `shutdown()` end the root span of the active trace. The root span of a trace ends one time. A tab that becomes hidden ends it too, because a mobile OS can stop a hidden page.
- **OpenTelemetry:** With `otelLoader`, a trace from the OpenTelemetry API keeps its own spans. The library sends no span for it.
- `getTraceHeaders()` names the root span. Your server span is then a child of the root span.
- Span records go through `processors` and `redact`. They also carry the context attributes of a record, for example `page.url` and `journey.id`.

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
- **One sender for each tab:** Each top-level tab or window has its own sender. Two tabs of one origin send their records separately. They have the same `session.id` and a different `tab.id`. A retry of stored batches runs in one tab at a time, under a Web Lock.
- **Five correlation ids:** Each record carries `session.id`, `tab.id`, `context.id`, `journey.id` and `trace_id`.
- **Durability and exit flush:** The library stores a batch that fails to send, in IndexedDB or localStorage. It sends the batch again with exponential backoff and jitter. When the document becomes hidden, the library runs a normal flush with the headers, gzip and retry. While the document is hidden, a send of 60 KB or less uses `keepalive`. A mobile OS can stop a hidden page with no `pagehide`. On `pagehide`, `freeze` or OpenFin close, it sends pending records with `navigator.sendBeacon` if they are below 60 KB. With `headers`, it uses a keepalive fetch with the last headers, because a beacon cannot set a header. A larger payload goes to the emergency queue. `shutdown()` runs a normal flush before the exit flush. An action is an audit fact. When storage is over `retention.maxBatches` or over the quota of the browser, it removes the batches without an action first. Before startup, the hold buffers keep up to 2000 actions. The 500-record limit applies only to other records. `onDrop` tells the app about each loss.
- **One library version on a page:** If a copy of another version owns the page runtime, this copy runs console-only. It installs no capture and reports `runtime.version_mismatch`. Load one version of the library on the page.
- **Emergency queue:** The emergency queue is best effort. It writes to `localStorage` synchronously, because no other storage works while the page unloads. If the browser refuses the write, the library reports `storage.quota_exceeded`. The library then loses the batch.
- **Configuration after startup:** A second `configure()` call merges the new options into the live runtime. The runtime refuses 5 changes and reports `config.invalid` for each:
  - A change to `storage`. The stored batches stay in the adapter that the runtime built at startup.
  - A change to `identity`. The ids exist from startup.
  - A change to `batching` or `retention` after the delivery stack loads. The stack reads them one time.
  - A change to `limits` or `journey.maxAgeMs` after the first `configure()`. The record builder and the journey engine read them one time.
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
   - Only the beacon records of the exit flush arrive, because a beacon sends no custom header.

3. **Deduplication:** Deduplicate on the `X-UiObs-Batch-Id` header and the `uiobs_batch_id` query parameter. Keep the ids for at least 24 hours.
4. **Throttling:** Return `429` or `503` with `Retry-After`. Expose the header with `Access-Control-Expose-Headers: retry-after`. The library waits 60 s at most.
5. **Status codes:** `200`, `202` and `204` accept the batch. `413` makes the library split the batch. With a `headers` function, a `401` or `403` gets one more send with new headers. The library drops a batch that gets any other `4xx`.
6. **Metrics and traces endpoints (optional):** With `metricsEndpoint`, the library sends each batch of metric records there as an OTLP/JSON `ExportMetricsServiceRequest`. With `tracesEndpoint`, it sends each batch of span records there as an OTLP/JSON `ExportTraceServiceRequest`. The rules 1 to 5 also apply to these endpoints. A throttle or a failed batch of one endpoint does not hold back the batches of another endpoint. `headers` applies to each endpoint. Each point is a delta from the previous point of its attribute set. A histogram point with a negative value has no `sum`.
7. **Remote sampling (optional):** To send sampling rules, add `X-UiObs-Sampling` to a `2xx` answer. Expose the header with `Access-Control-Expose-Headers: x-uiobs-sampling`.

---

## Development

```bash
npm install
npm run dev      # Playground, mock ingest server and iframe host
npm run verify   # Format check, version sync, typecheck, lint, build and tests
```

- Vanilla playground: `http://localhost:5173/playground/vanilla/index.html`
- Mock ingest server: `http://localhost:8787`. It accepts `/v1/logs` and `/v1/metrics`. It prints one line for each record and for each metric point.
- The React example sends its counter, histogram and HTTP duration points to `/v1/metrics`.

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

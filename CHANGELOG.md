# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.2] - 2026-10-30

### Added - v0.9.2

- `metricsEndpoint` sets an OTLP metrics endpoint, for example `https://ingest.example/v1/metrics`. With it, each batch of metric records goes there as an OTLP `ExportMetricsServiceRequest`. Without it, metric records are log records on `endpoint`, as before. It needs `serializer: "otlp"`, and `endpoint` or `transport`. Without `endpoint` and `transport`, the library reports `config.invalid`. Network capture does not log a request to it.
- With `metricsEndpoint`, each endpoint has its own throttle. A `429` from one endpoint does not stop the batches of the other endpoint. In the retry queue, a failed batch holds back only the batches of its own endpoint.
- `counter(name, { unit? })` gives a counter. `add(value, attrs?)` sums a value of 0 or larger in memory. At each `batching.metricFlushIntervalMs`, the library sends one point for each attribute set.
- `histogram(name, { unit?, boundaries? })` gives a histogram. `record(value, attrs?)` counts a value in buckets in memory. Each point has `count`, `sum`, `min`, `max` and the bucket counts. The default boundaries are the OpenTelemetry default boundaries.
- Sampling and `minLevel` do not drop a point. The console does not print it.
- Each instrument keeps at most 100 attribute sets in each interval. The values of more sets go to one set with `otel.metric.overflow: true`.
- The library drops a point attribute key that starts with `metric.`. It also drops the keys that it sets on each record, for example `page.url` and `log.type`.
- The record limits do not cut the metric fields of a point, for example the bucket counts. `redact` cannot change these fields.
- The points of the open interval go out at `flush()`, at `shutdown()` and before the exit flush.
- The package exports the types `Counter`, `Histogram`, `HistogramOptions`, `InstrumentOptions` and `MetricAttributes`.
- With `metricsEndpoint`, a counter point is an OTLP delta sum. A histogram point is an OTLP delta histogram. A `logMetric()` gauge is an OTLP gauge. A `logMetric()` histogram is a histogram with one value. The point attributes are only the attributes of the call. The context attributes stay off the point. The resource of each request still has `session.id`, `tab.id`, `context.id` and the user agent. A histogram point with a negative value has no `sum`.
- `request.kind` of a custom transport is `"metrics"` for a batch of metric records when `metricsEndpoint` is set. Each other batch has the kind `"logs"`.
- A `logMetric()` record has the new attribute `metric.attribute_keys`. It names the attributes of the call.
- `capture.httpMetrics` records the `http.client.request.duration` histogram of each request that `fetch` or `xhr` capture sees. It is on by default. The unit is seconds. The attributes are `http.request.method`, `http.response.status_code`, `server.address` and `error.type`. The path, the query and the port stay out. The boundaries are the ones that the OpenTelemetry semantic conventions advise.
- The diagnostic code `capture.transport_request`. Network capture reports it one time when it sees a request during a custom transport call. Put the URL of your transport in `capture.ignoreUrls`. Without it, each send records a duration value, and that value causes the next send.
- A child frame on an origin in `bus.trustedOrigins` is also trusted for metric points. Its points bypass the sampling and the limit of 100 attribute sets of the parent.

### Changed - v0.9.2

- `flush()` and the exit flush send the metric records and the other records in separate batches. A batch never holds both kinds.
- The keepalive fetches of one exit flush share one budget of 60,000 bytes. A batch that does not fit goes to the emergency queue.
- With `capture.fetch` or `capture.xhr` on, each interval now gives one histogram point for each method, status and server. Without `metricsEndpoint`, these points are metric log records on `endpoint`. Set `capture.httpMetrics: false` to turn them off.

## [0.9.1] - 2026-10-29

### Added - v0.9.1

- `batching` sets the batch size and the flush interval of the log stream and of the metric stream. The keys are `logFlushIntervalMs`, `logBatchSize`, `metricFlushIntervalMs` and `metricBatchSize`.
- `retention` sets `maxBatches`, `maxAgeMs` and `maxAttempts` for undelivered batches.
- With `retention.mode: "until-delivered"`, a stored batch has no age limit and no attempt limit. `maxBatches` still applies. A permanent error still drops the batch.
- With `retention.mode: "until-delivered"`, a batch that always gets a temporary error stays first in the queue. The batches behind it wait.
- `limits` sets the 8 size limits of each record: `maxBodyChars`, `maxAttributeChars`, `maxAttributeCount`, `maxStackChars`, `maxDepth`, `maxArrayLength`, `maxNodes` and `maxRecordBytes`. The console uses the same limits.
- `journey.maxAgeMs` sets the maximum open time of a journey.
- Each new key has a range. A value outside its range reports `config.invalid`. The value in force stays.
- `onDrop(summary)` receives a summary when the library loses records that it built. The summary has `reason`, `records`, `batchIds`, `journeyIds` and `actions`. Sampling, `minLevel` and `redact` do not cause a loss.
- The library joins the losses of one reason in one task into one summary. Each list holds at most 20 different values.
- The `onDrop` reasons are `buffer_full`, `expired`, `over_capacity`, `quota`, `max_attempts`, `rejected`, `unserializable`, `exit_queue_full`, `load_failed` and `not_stored`.
- `load_failed` covers the records that wait for the delivery stack when its load fails. It also covers these records when `shutdown()` comes before the load ends. After a failed load, each new record also reports `load_failed`.
- `not_stored` covers a failed send that storage did not keep. The cause is an IndexedDB write error or `storage: "none"`.
- The `onDrop` hook runs inside the library request scope and the library console scope. Network capture and console capture skip its requests and its console lines.
- Do not log through the library in the `onDrop` hook. A record from the hook can evict a stored batch.
- `onDrop` can report a batch that storage evicts during its send. The server can still receive that batch.
- The package exports the types `DropSummary` and `LossReason`.

### Changed - v0.9.1

- A later `configure()` cannot change `batching` or `retention` after the delivery stack loads. It cannot change `limits` or `journey.maxAgeMs` after the first `configure()`. It reports `config.invalid`. The values in force stay.
- A log call before `configure()` starts a runtime with defaults. The first `configure()` then sets `batching`, `retention`, `limits` and `journey.maxAgeMs` of that runtime.
- An action is an audit fact. When storage is over `retention.maxBatches` or over the quota of the browser, it removes the batches without an action first. `retention.maxAgeMs` still removes each old batch.
- The hold buffers keep up to 2000 actions before startup and while the delivery stack loads. The 500-record limit applies only to the other records.
- A prune that removes expired batches and batches over `retention.maxBatches` reports each group with its own reason. `storage.evicted` and the gap warning record come one time for each group.
- With `storage: "none"`, a failed send gives the gap warning record. A throttle limits that record.
- The gzip size budget of the main graph is 24,400 B. It was 23,700 B.

### Fixed - v0.9.1

- When a keepalive exit fetch fails or throws, the library puts the batch in the emergency queue. The next page load sends it. Before, the library lost the batch.
- `shutdown()` gives the forward buffer to the bus before the bus stops. Before, a forwarder lost the records that it logged in the same task as `shutdown()`.

## [0.9.0] - 2026-10-28

### Breaking changes - v0.9.0

- The level methods (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) give records with `log.type: "log"`. It was `"system"`. `"system"` is now for the records of the library itself.
- A cross-origin child frame forwards its records only to a parent on an origin in its `bus.trustedOrigins`, or on its own origin. It posts to that origin, not to `"*"`. With no trusted parent, the frame sends its own records at once.
- A sandboxed frame without `allow-same-origin` sends its own records. `bus.untrusted_origin` tells you to set `bus.mode: "sender"` in the frame. Add `allow-same-origin` only for content that you trust.
- `bus.trustedOrigins` does not accept `"null"`. One `"null"` entry trusts each sandboxed and `data:` document, for example a frame in an ad. Set `bus.mode: "sender"` in your sandboxed frame.
- `journey.scope` sets which contexts adopt a journey. The default `"auto"` is `"tab"` in a browser. A journey no longer goes to other tabs through the broadcast link. Set `"origin"` for the previous behavior. OpenFin and OpenFin Core Web keep `"origin"`.
- `minLevel` no longer drops action and metric records. It applies to log, event and system records.
- A string in `capture.propagateTraceHeaderTo` is an origin. It matches a request to that origin only. Before, it matched a substring of the URL. A string that is not a URL, for example `"/api/"`, reports `config.invalid`. To match a path, use a RegExp that starts with `^`.
- If the `redact` hook throws or returns a value that is not a record, the library drops the record. It counts the drop as `record.dropped_by_redact`. Before, it sent the record without redaction.
- This release removes `Sequence.reset()`.

### Added - v0.9.0

- `fatal(message, error?, payload?)` is a top-level function.
- `configure()` checks each key: `enabled`, `minLevel`, `console`, `compression`, `credentials`, `headers`, `storage`, `identity`, each `bus`, `journey`, `capture` and `sampling` key. A value of the wrong type reports `config.invalid`. The value in force stays. Level names can have any case. Each `bus.trustedOrigins` entry becomes its origin.
- `error.data` holds the own string, number and boolean fields of the reason, for example `code`. An object field, for example the `config` of an `AxiosError`, stays out. It holds credentials and request bodies.
- `timeSync` and `timeAsync` also emit the duration histogram when the function throws or the promise rejects, with `status: "FAILURE"`. The error record and the histogram give the same duration.
- If a copy of another version owns the page runtime, this copy runs console-only. It installs no capture. It reports `runtime.version_mismatch`. A later `configure()` keeps it console-only. Its log calls and its `shutdown()` do not touch the runtime of the other version.
- New diagnostic codes: `runtime.version_mismatch` and `record.dropped_no_destination`. The library now also reports `transport.timeout`. It counts `record.dropped_malformed` and `record.sanitize_failed` in more places.

### Changed - v0.9.0

- When the document becomes hidden, the library runs a normal flush with the headers, gzip and retry. On `pagehide`, `freeze` and OpenFin close, it uses a keepalive fetch with the last headers when `headers` is set. It uses `sendBeacon` only with no custom headers.
- While the document is hidden, a send of 60 KB or less uses `keepalive`. A mobile OS can stop a hidden page with no `pagehide`. The exit flush does not send that batch again.
- Until a `headers` function gives its first result, the exit flush puts the batch in the emergency queue. The next page load sends it with the headers.
- The exit flush sends the cached result of a `headers` function only while that function and the endpoint are in force.
- With a `redact` hook, a record that `redact` drops prints no console line. Before, the console printed its message.
- `shutdown()` runs a normal flush before the exit flush.
- After a 401 or 403, the library calls a `headers` function one more time. It then sends the batch one more time. A second 401 or 403 drops the batch.
- `flush()` waits for the batches in the queue and in flight. A flush while the server throttles stores the batch for the retry engine. It does not send around the throttle and the concurrency limit.
- A later `configure()` reinstalls the capture modules only when the `capture` section changes.
- A capture module restores a host function, for example `fetch` or `history.pushState`, only if the function still holds the wrapper of the library. A wrapper that another script added later stays in place.
- The library waits 60 s at most after a `Retry-After` answer.
- The library removes the journey token from the URL after it adopts the token.

### Fixed - v0.9.0

- The build works on Windows. `npm run verify` runs lint after the build.
- `headers()` and the gzip encoding run under the 15 s request deadline. A `headers()` that never settles no longer holds a send slot.
- The emergency queue import runs after the sender starts. It no longer delays startup. It no longer drops records from the boot buffer.
- OTLP sends an integer above `Number.MAX_SAFE_INTEGER` as `doubleValue`, not as a broken `intValue`.
- The fetch capture no longer throws on an input with a text form only, on a Request from another realm, or on an input it cannot read. The XHR capture no longer throws on a method that is not a string. The capture never changes the result of the call.
- The XHR capture sends `traceparent` to the targets in `propagateTraceHeaderTo`.
- An allowlisted Request from another realm keeps its own headers. The library sends it without `traceparent`.
- An Error from another realm keeps its name, message and stack in the error capture, the console capture, `log.error()`, `console.args` and `cause`.
- A failed web-vitals import gets a new attempt when a later `configure()` changes the `capture` section.
- An oversized error record drops the caller attributes first. It keeps each `error.*` field, then the breadcrumbs if they fit.
- A breadcrumb holds the body after `redact`.
- The library drops a record that `redact` breaks in place, or a `redact` result with an unknown `severityText`. It counts the drop as `record.dropped_malformed`. The library sets `severityNumber` from the `severityText` that `redact` returns.
- A payload or a reason with a throwing getter or Proxy trap no longer throws out of a log call. The record gets `uiobs.sanitize_failed: true`.
- `logMetric` drops `NaN` and `Infinity`. It counts the drop as `record.dropped_malformed`.
- The bus checks the shape of each journey message. A journey answer holds the address of the context that asked. Only that context adopts it.
- A sandboxed page without `allow-same-origin` drops each message from a child frame with the origin `"null"`. Before, it trusted those frames as its own origin.
- The `bus.untrusted_origin` detail keeps only the first 32 characters of the message type.
- An oversized record keeps `page.url`, `journey.id` and `journey.name` as `redact` left them. Before, the size limit wrote the values from before `redact` back.

## [0.8.0] - 2026-10-14

### Added - v0.8.0

- `transport` sends batches through a channel of the app, for example an API client, a WebSocket or IPC. Batching, retry, storage, splitting and the exit flush stay the same. The returned status code has the meaning of the ingest contract. With `transport`, `endpoint` is optional.
- `transportOnExit` sends the last batch while the page closes. Without it, that batch goes to the emergency queue. The next page load sends it.
- The package exports the types `Transport`, `TransportRequest`, `TransportResponse` and `ExitTransport`.
- After the delivery stack loads, `configure()` cannot add or remove `transport`. The library reports `config.invalid`. A new function in place of the one in force is accepted.
- Network capture skips each request that the library starts itself. This includes a request that a custom transport starts before its first `await`.
- `createMemoryTransport()` gives tests a transport that keeps each batch in memory. `records()` returns the accepted records. `respondWith()` sets the answer, for example `413` or `429`. The package exports the type `MemoryTransport`.
- `capture.longFrames` records each frame that freezes the page as the histogram `ui.long_frame.duration`. `capture.longFrameThresholdMs` sets the minimum duration. The default is 100 ms. A browser without `long-animation-frame` gives `longtask` entries.
- `capture.console` records the console calls of the app. `true` wraps `error` and `warn`. A list selects from `error`, `warn`, `info` and `log`. `error` and `warn` give records. `info` and `log` give breadcrumbs. The library does not record the lines that it prints itself.
- `sampling.remote` reads sampling rules from the `X-UiObs-Sampling` header of each accepted batch. The rules stay in force for their `ttlMs`, at most 1 hour. They can change rates and lower `minLevel`. `sampling.remoteMaxRate` caps each remote rate. A custom transport returns the rules in `TransportResponse.sampling`. Child frames, workers and OpenFin views ask their owner for the rules.

### Fixed - v0.8.0

- `flush()` during startup missed the records in the boot buffer. It now waits for startup to release them.
- The `sendBeacon` failure message was a fragment. It is now a complete sentence.

## [0.7.0] - 2026-10-12

### Breaking changes - v0.7.0

- A console line has the form `[namespace][LEVEL] message`. It was `[namespace] LEVEL message`.

### Added - v0.7.0

- The level in a console line has its own color. `TRACE` and `DEBUG` are gray. `INFO` is blue. `WARN` is orange. `ERROR` and `FATAL` are red.
- `console` accepts an object with `level` and `styles`. `styles` holds a CSS string for `namespace` and for each level. A key that you do not set keeps its style. The package exports the types `ConsoleOptions` and `ConsoleStyles`.
- A style can set the text color and the background together, for example `"color:#fff;background:#1e6fd9;padding:0 4px;border-radius:3px"`.
- A later `configure({ console: "WARN" })` changes the level only. A later `configure({ console: { styles } })` changes the styles only.
- An unknown style key or a style that is not a string reports `config.invalid`. The style in force stays.
- `npm run check:size` fails if the main chunk graph is above its gzip budget. `npm run check:dev` fails if the Vite dev server cannot load the library without the optional peers. `verify` runs both.

## [0.6.0] - 2026-10-11

### Breaking changes - v0.6.0

- Each diagnostic message, `TransportError` message and IndexedDB error message is a complete sentence. For example, "server throttled us" is now "The server throttles the requests." Filter on `event.code`, not on `event.message`.

### Added - v0.6.0

- The diagnostic code `platform.api_blocked` counts a browser API that a sandbox or a cross-origin boundary blocks. This includes `crypto.randomUUID`, `window.top` and `location.href`.
- `getDiagnosticCounters()["record.sanitize_failed"]` counts each value that throws during sanitization, for example a hostile getter.

### Changed - v0.6.0

- The comments, the JSDoc in the `.d.ts` files and the README follow ASD-STE100.
- The `BusMode` JSDoc said that `off` "does neither". With `off`, the context delivers its own records.

## [0.5.0] - 2026-10-11

### Breaking changes - v0.5.0

- The library does not import `@opentelemetry/api` by itself. Set `otelLoader` to put records on your spans. Without `otelLoader`, OTel is off. The library reports no diagnostic.
- `capture.webVitals` needs `capture.webVitalsLoader`. Without the loader, the library reports `config.invalid`. Navigation timing continues.
- `console` does not depend on `minLevel`. `minLevel` limits what the library sends. `console` limits what it prints.
- A console line starts with the logger namespace, for example `[board.hop] WARN`. It started with `[ui-observability]`.
- A console line shows the caller's payload. It showed all record attributes.
- With a `redact` hook, the console shows only what `redact` returns. A record that the library does not build shows its message and error only.
- After `shutdown()`, every call does nothing until the next `configure()`. A log call after `shutdown()` started a new runtime with default settings.
- After the delivery stack loads, `configure({ endpoint: null })` and `configure({ endpoint: "" })` report `config.invalid`. The endpoint in force stays.
- `OneLogger` takes a function that returns the runtime. It took the runtime.

```ts
// OpenTelemetry, imported by the library before 0.5.0
configure({ endpoint, otelLoader: () => import("@opentelemetry/api") });

// web vitals
configure({ endpoint, capture: { webVitals: true, webVitalsLoader: () => import("web-vitals") } });
```

### Added - v0.5.0

- `endpoint: null` selects console-only mode. The library sends nothing. It reports no diagnostic about the endpoint. A missing endpoint or `""` still reports `config.invalid`.
- `identity: "memory"` keeps session, tab and journey ids in memory. The library writes no key to `localStorage` or `sessionStorage` for them. You cannot change `identity` after startup.
- `npm run check:peers` fails if a built file imports an optional peer by name.

### Fixed - v0.5.0

- The Vite dev server failed when a peer was not installed. `dist/index.js` imported `web-vitals` and `@opentelemetry/api` by name. Peers load only through the loaders.
- `getLogger()` before `configure()` started a runtime with default settings. That runtime refused a later `configure({ storage })`. A logger finds the runtime on its first write.
- A logger held across `shutdown()` wrote to the destroyed runtime. After the next `configure()`, it writes to the new runtime.
- `error(message, err, payload)` printed the error without the payload. The console line shows both.
- A `shutdown()` during startup still installed the capture modules. Their window listeners stayed until the page closed.
- `endpoint: undefined` in a later `configure()` removed the live endpoint. The endpoint in force now stays.
- The runtime dropped a forwarded record that arrived before the pipeline existed. The record now waits for the delivery stack.
- A `configure()` during startup did not apply to `endpoint` or `capture`. It applies now.
- A worker registered in a nested frame lost its handshake while the bus started. The runtime now attaches the worker when it constructs the bus.
- `flush()`, `getQueueDepth()` and `shutdown()` did not wait for a delivery stack that was still loading. They wait now.
- A `%o` or `%c` in a logger namespace changed the console output. The namespace now prints as text.
- A failed exit flush install left the retry loop running. The library now stops the retry loop.

### Performance - v0.5.0

- The main chunk holds only the logger, the record builder and the console sink. The delivery stack loads only when you set an endpoint. The bus loads only when the context needs it. Each capture module loads only when you enable it. A console-only setup loads half the code of 0.4.1.

## [0.4.1] - 2026-09-09

### Fixed - v0.4.1

- A blocked IndexedDB upgrade never settled. Every storage call in the window waited with it. `IdbDriver` rejects on `onblocked`. An open connection closes on `versionchange`. A failed open is not cached.
- No storage call had a time limit. A hung adapter held a dispatch slot, the drain flag, or startup. Each call fails after `STORAGE_DEADLINE_MS` and reports `storage.degraded`.
- A refused beacon lost the batch. The keepalive fetch fallback drew on the same full budget. A refusal writes to the emergency queue. An absent `sendBeacon` still falls back to the fetch.
- `hidden` sent in-flight batches a second time under a new batch id. It drains the stream buffers only. `pagehide`, `freeze`, `openfin-close` and `shutdown` still take both.
- A `429` or `503` spent one of the five delivery attempts. A throttled answer schedules from `Retry-After`. The attempt count is unchanged.
- A same-origin frame two levels deep lost its records. The echo guard compared link kinds, and two direct links share a kind. A forwarder relays records from a direct link.
- Each `configure()` after startup added another set of web-vitals reporters and repeated the seven navigation timing metrics. `web-vitals` has no unsubscribe. Both run once per document.
- The IndexedDB probe tested presence, not operation. The factory opens the database before it keeps the adapter. A host that rejects `open()` gets localStorage.
- `bumpAttempts` read and wrote in two IndexedDB transactions. A prune in another window deleted the batch between them. One transaction holds both.
- The ingest contract did not list the request headers. A server built from the README failed every CORS preflight and received exit-flush records only. The README names `OPTIONS` and `Access-Control-Allow-Headers`.

### Performance - v0.4.1

- `prune()` parsed every stored batch to read `createdAt`. It reads `createdAt` from the key. Only a batch it drops is parsed.
- Click capture read `innerText`, which forces style and layout. It reads `textContent`. A click breadcrumb can carry text that CSS hides.

## [0.4.0] - 2026-09-09

### Breaking changes - v0.4.0

- The OpenFin bus topic is scoped to one application uuid. Upgrade all windows of an application together. A 0.3.0 window and a 0.4.0 window do not share a bus.
- ECS documents write each attribute under `labels` as a flat dotted key. A nested attribute was an object. Update saved queries.
- ECS `log.level` is `warning` for a WARN record. It was `warn`.
- `logger.error(message, payload)` reads a plain object in the error slot as the payload. It was the error reason. An array, an `Error` and a class instance stay error reasons.
- `configure({ storage })` after startup reports `config.invalid` and keeps the built adapter. The call was accepted before and did nothing.
- One record sanitizes to 10,000 nodes. Values past the cap become `[MaxNodes]`.

```ts
// ECS attributes
{ labels: { order: { id: "ORD-1" } } }  // 0.3.0
{ labels: { "order.id": "ORD-1" } }     // 0.4.0
```

### Fixed - v0.4.0

- A quota eviction dropped the write it made room for. Both persistent adapters retry the write. A failed retry counts a gap with `reason: "quota"`.
- Sampling dropped the breadcrumb with the record. A sampled-out record keeps its breadcrumb. A record dropped by `redact` does not.
- A typo inside a config section passed in silence. `capture: { webVital: true }` reports `unknown config key "capture.webVital"`. The guard reads one level into `sampling`, `bus` and `capture`.
- A console method that throws stopped the caller's log call. The mirror is guarded and reports `handler.threw`.
- The session touch throttle was module state. Two runtimes in one document silenced each other. Each runtime holds its own throttle.

## [0.3.0] - 2026-09-08

### Breaking changes - v0.3.0

- `credentials` defaults to `"omit"`. The library sends no cookie to the ingest endpoint. Set `credentials: "include"` for cookie auth.
- A recorded URL holds no query string and no fragment. This covers `page.url`, `url.full`, `resource.url`, `page.url.previous` and their breadcrumbs. Set `capture.fullUrls: true` to keep the full URL.
- `@opentelemetry/api` is an optional peer dependency. Install it to put records on the traces your spans carry. Without it, the library mints its own `trace_id` and reports `trace.otel_failed` one time. Set `otelLoader` when your bundler cannot resolve the import.
- `getLogger(namespace, options)` builds a new logger on each call. Only `getLogger(namespace)` is cached. A per-call `scopedContext` no longer stays in memory for the life of the document.

```ts
// cookie auth, the default before 0.3.0
configure({ endpoint, credentials: "include" });

// query strings, always recorded before 0.3.0
configure({ endpoint, capture: { fullUrls: true } });
```

### Fixed - v0.3.0

- `flush()` sent an in-flight batch again under a new `X-UiObs-Batch-Id`. The server could not deduplicate it. `flush()` takes the stream buffers only. The exit flush still takes both, because a closing document cannot confirm delivery.
- The bus posted to a child frame with the target origin `"*"`. A frame that navigated away received the `journey.id` and the `tab.id`. The bus posts to the origin the child last spoke from.
- An `ERROR` and a `FATAL` record bypass sampling and had no limit. A fixed window admits 500 of them per 10 seconds. It counts the rest as `record.dropped_by_ceiling`.

### Performance - v0.3.0

- Sampling runs before the library builds the record. A dropped record costs one hash. It does not pay for sanitize, the resource block, `redact` or truncation.

## [0.2.0] - 2026-09-08

### Breaking changes - v0.2.0

- Config holds 31 keys in 3 sections. It held 63 keys in 9 sections.
- A removed key is a fixed library default.
- An unknown key is ignored. `onDiagnostic` reports `config.invalid` with the message `unknown config key "<key>", ignored. Typo?`.
- `storage` is a strategy string. It was an object.
- `console` is a boolean or a level name. It was an object.

```ts
// 0.1.x
configure({ endpoint, storage: { strategy: "indexeddb", dbName: "app-logs" } });
configure({ endpoint, console: { enabled: true, level: "DEBUG" } });

// 0.2.0
configure({ endpoint, storage: "indexeddb" });
configure({ endpoint, console: true });
configure({ endpoint, console: "WARN" });
```

| Section   | Removed keys                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `streams` | `logs.batchSize`, `logs.flushIntervalMs`, `metrics.batchSize`, `metrics.flushIntervalMs`                                  |
| `retry`   | `baseDelayMs`, `maxDelayMs`, `idleDelayMs`                                                                                |
| `journey` | `maxAgeMs`, `endOnOwnerClose`, `urlParam`                                                                                 |
| `limits`  | `maxBodyChars`, `maxAttributeChars`, `maxAttributeCount`, `maxStackChars`, `maxDepth`, `maxArrayLength`, `maxRecordBytes` |
| `storage` | `dbName`, `maxBatches`, `maxAgeMs`, `maxAttempts`                                                                         |
| `bus`     | `channelName`, `handshakeTimeoutMs`, `maxHandshakeAttempts`, `maxBootBufferRecords`, `openFinHost`, `orphanPolicy`        |
| `capture` | `maxBreadcrumbs`, `errorDedupeMs`                                                                                         |
| top level | `maxConcurrentRequests`, `requestTimeoutMs`, `compressionThresholdBytes`                                                  |

`sampling` is unchanged.

### Removed

- The library replaces `rxjs` with its own buffering, batching, queueing and deferral.
- The library replaces `dexie` with raw IndexedDB behind `IdbDriver`.
- `@opentelemetry/api` is the only runtime dependency. `web-vitals` stays the optional peer.

### Changed - v0.2.0

- The IndexedDB database version is 11. The upgrade keeps a 0.1.x batch readable and retries it.

## [0.1.2] - 2026-08-30

### Fixed - v0.1.2

- `telemetry.sdk.version` reported `0.1.0` for a record from `0.1.1`. The version constant and the package version stay in sync now.

## [0.1.1] - 2026-08-30

### Changed - v0.1.1

- Version bump only.

## [0.1.0] - 2026-08-30

### Added

- First release of `@utk09/ui-observability`.
- Batching, gzip compression, OTLP/JSON and ECS serialization, IndexedDB and localStorage storage, retry with backoff, `sendBeacon` exit flush, an iframe, worker and OpenFin bus, and auto-capture of errors, network, interactions, navigation and web vitals.

# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

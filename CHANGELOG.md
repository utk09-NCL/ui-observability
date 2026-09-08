# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-08

### Breaking changes - v0.3.0

- `credentials` now defaults to `"omit"`. The library sends no cookies to the ingest endpoint. Set `credentials: "include"` for cookie auth.
- A recorded URL carries no query string and no fragment. This applies to `page.url`, `url.full`, `resource.url`, `page.url.previous` and their breadcrumbs. Set `capture.fullUrls: true` to keep the full URL.
- `@opentelemetry/api` is now an optional peer dependency. Install it to put records on the traces your spans carry. Without it, the library mints its own `trace_id` and reports `trace.otel_failed` once. Set `otelLoader` if your bundler cannot resolve the import.
- `getLogger(namespace, options)` builds a new logger on each call. Only `getLogger(namespace)` is cached. A per-call `scopedContext` no longer stays in memory for the life of the document.

```ts
// cookie auth, previously the default
configure({ endpoint, credentials: "include" });

// query strings, previously always recorded
configure({ endpoint, capture: { fullUrls: true } });
```

To join your own traces, install the peer: `npm install @opentelemetry/api`.

### Fixed - v0.3.0

- `flush()` sent in-flight batches again under a new `X-UiObs-Batch-Id`. The server could not deduplicate them. `flush()` now takes the stream buffers only. The exit flush still takes both, because a document that closes cannot confirm delivery.
- The bus posted to a child frame with the target origin `"*"`. A frame that navigated away received the `journey.id` and the `tab.id`. The bus now posts to the origin the child last spoke from.
- `ERROR` and `FATAL` records bypass sampling and had no limit. A fixed window now admits 500 of them per 10 seconds. It counts the rest as `record.dropped_by_ceiling`.

### Performance - v0.3.0

- Sampling runs before the library builds the record. A dropped record costs one hash. It no longer pays for sanitize, the resource block, `redact` or truncation.

## [0.2.0] - 2026-09-08

### Breaking changes - v0.2.0

- Config was reduced from 63 keys in 9 sections to 31 keys in 3 sections.
- Removed config keys are now fixed library defaults.
- Unknown keys are ignored and reported through `onDiagnostic` as `config.invalid` with the message `unknown config key "<key>", ignored. Typo?`.
- `storage` is now a strategy string instead of an object.
- `console` is now a boolean or log level instead of an object.

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

- `rxjs` replaced with the library's own buffering, batching, queueing, and deferral logic.
- `dexie` replaced with raw IndexedDB behind `IdbDriver`.
- Runtime dependency footprint reduced to `@opentelemetry/api`; `web-vitals` remains the optional peer dependency.

### Changed - v0.2.0

- IndexedDB database version increased to 11. Existing 0.1.x batches remain readable and are retried automatically after upgrade.

## [0.1.2] - 2026-08-30

### Fixed - v0.1.2

- `telemetry.sdk.version` was reporting `0.1.0` for records produced by `0.1.1`; the version constant and package version are now kept in sync.

## [0.1.1] - 2026-08-30

### Changed - v0.1.1

- Version bump only.

## [0.1.0] - 2026-08-30

### Added

- Initial release of `@utk09/ui-observability`.
- Batching, gzip compression, OTLP/JSON and ECS serialization, durable IndexedDB and localStorage storage, retry/backoff delivery, `sendBeacon` exit flush, iframe/worker/OpenFin cross-context bus, and automatic capture of errors, network, interactions, navigation, and web vitals.

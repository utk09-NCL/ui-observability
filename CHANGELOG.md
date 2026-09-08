# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-08

### Breaking changes

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

### Fixed

- `telemetry.sdk.version` was reporting `0.1.0` for records produced by `0.1.1`; the version constant and package version are now kept in sync.

## [0.1.1] - 2026-08-30

### Changed - v0.1.1

- Version bump only.

## [0.1.0] - 2026-08-30

### Added

- Initial release of `@utk09/ui-observability`.
- Batching, gzip compression, OTLP/JSON and ECS serialization, durable IndexedDB and localStorage storage, retry/backoff delivery, `sendBeacon` exit flush, iframe/worker/OpenFin cross-context bus, and automatic capture of errors, network, interactions, navigation, and web vitals.

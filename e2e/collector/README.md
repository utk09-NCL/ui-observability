# Collector interoperability check

`tools/check-collector.mjs` sends the output of the library to an OpenTelemetry Collector. A mock server cannot prove interoperability, because a mock accepts each body.

## What the check proves

The check loads the fixture page two times in Chromium. The first run sets `compression: "none"`. The second run sets `compression: "gzip"`. Each run sends one log record, one counter point and one span with `serializer: "otlp"`.

- The OTLP/HTTP receiver permits the origin of the page and the request headers of the library.
- The receiver answers `200` to the `POST` of `endpoint`, `metricsEndpoint` and `tracesEndpoint`.
- The receiver accepts the plain JSON body and the body with `Content-Encoding: gzip`.
- In the second run, the request of the log batch has `Content-Encoding: gzip`.
- The file exporter writes the log record, the counter point and the span of each run.
- Each item has `service.name: "collector-check"` and the attribute `check.run`.
- The counter point has the value 1.
- The library reports no drop and no diagnostic.

The check adds no padding to a body. Each body is larger than the compression threshold of the library. If the library does not compress the log batch, the second run fails.

The collector accepts a field with an incorrect name and an empty identifier. It drops them and gives no error. Thus the check also reads these fields in the output of the file exporter.

| Item | Field | Expected value |
| --- | --- | --- |
| Log record | `severityNumber` | 9 |
| Log record | `timeUnixNano` | More than zero |
| Sum | `aggregationTemporality` | 1 (delta) |
| Sum | `isMonotonic` | `true` |
| Span | `traceId` | 32 hexadecimal characters, not all zero |
| Span | `spanId` | 16 hexadecimal characters, not all zero |
| Span | `startTimeUnixNano` | More than zero |
| Span | `endTimeUnixNano` | More than zero, and not before the start time |

## Pinned collector

| Item | Value |
| --- | --- |
| Distribution | `otelcol-contrib` |
| Version | `0.164.0`, published on 2026-10-26 |
| Archive | `otelcol-contrib_0.164.0_darwin_arm64.tar.gz` |
| SHA-256 of the archive | `af6a0c56886e3cc36ccebe849fa167bad2bc47a97a48fd8497a0d6f93d0cf73a` |
| SHA-256 of the binary | `4d60abcd101c768268f885e3c42a5d2ca083d9d7461c68c6c77dc044371aa0c5` |
| Configuration | `e2e/collector/config.yaml` |

- The check runs on macOS arm64 only. On another platform, it stops with a message.
- The two SHA-256 values in `PLATFORMS` are the trust anchor. The check downloads no checksum file.
- To add a platform, add a row to `PLATFORMS` in `tools/check-collector.mjs`.
- Calculate `archiveSha256` with `shasum -a 256` on the archive. Compare it with the `<archive>.sha256` file of the release.
- Extract the archive. Calculate `binarySha256` with `shasum -a 256` on the `otelcol-contrib` file.
- To change the version, change `COLLECTOR_VERSION`, each SHA-256 in `PLATFORMS` and this table.

## Run the check

```bash
pnpm run test:collector
```

- The first run downloads the archive (98 MB) and puts the binary (370 MB) in `.otelcol/`.
- The check extracts the archive only when its SHA-256 is equal to the pinned value.
- The check installs the binary only when its SHA-256 is equal to the pinned value.
- A later run uses the binary in `.otelcol/` again. Before each use, the check calculates its SHA-256.
- If the SHA-256 is not equal to the pinned value, the check deletes the binary and downloads the archive again.
- A stop during the download can leave a `.otelcol/staging-*` folder. The next run deletes it.
- The check uses the ports 5196 (fixture page) and 14318 (collector). The two ports must be free.
- On `SIGINT` or `SIGTERM`, the check stops the collector, Vite and Chromium, and deletes its temporary folder. The exit code is then 130 or 143.
- The check needs the Chromium of Playwright. Install it with `pnpm exec playwright install chromium`.
- The check does not need a build. Vite serves the library from `src/`.
- The check prints one line for each result. The exit code is 0 when each result passes.

## What the check does not cover

- **Exit flush.** To an endpoint on another origin, the exit flush sends a batch with `Content-Type: text/plain;charset=UTF-8`. That batch is a keepalive `fetch`, or a beacon with `credentials: "include"`. This collector answers `415` to that content type. To an endpoint on the origin of the page, it sends `application/json`. Put an ingest server that meets the README rules in front of the collector, for example `tools/reference-collector.mjs`.
- **Deduplication.** The collector ignores `X-UiObs-Batch-Id` and `uiobs_batch_id`. It does not remove a batch that arrives two times.
- **Throttling and limits.** The check does not test `429`, `503`, `413`, `Retry-After` or `partialSuccess`.
- **Other signals.** The check does not assert histogram points, client spans, root spans or the replay endpoint.
- **Other formats.** The check does not test the `ecs` serializer, OTLP/protobuf or gRPC.
- **Other browsers and platforms.** The check uses Chromium on macOS arm64 only.
- **Backends.** The check reads the output of the collector. It does not send data to a storage backend.

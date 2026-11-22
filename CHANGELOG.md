# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-22

A minor release. It has no breaking change. It captures clicks in popout windows, and it finds dead clicks on pages with live data. It gives each popup its own tab id. It also closes gaps in the loss reports of `shutdown()`, and it removes a limit on the signal endpoints.

### Added - v1.1.0

- `observeWindow(target)` captures clicks, rage clicks and dead clicks in another window of the page with the same origin, for example a popout. It returns a function that stops the capture. The library does not capture a window from another origin.
- `capture.interactions.deadClickIgnoreSelector` names the regions that change on their own, for example a price cell. A change or a scroll inside such a region is not an answer to a click. The default is `[data-observability-live]`. `""` turns the filter off.
- The diagnostic code `bus.journey_denied`. The bus counts it for a journey request from a registered frame or worker without `journey:read`.
- The `tab` bus message has the optional field `since`. It holds the `performance.timeOrigin` of the document. An older library ignores it.
- `docs/guides.md` has the section "One Setup for All Specs". It configures the library one time in a Vitest setup file. No spec then needs a mock of the library.
- The `serializer` reference and the `LogSerializer` JSDoc tell that the library drops a batch that the server refuses with `400`. A custom serializer must keep each record within the limits of the server.
- `docs/configuration.md` tells that the spans of the library need no OpenTelemetry SDK.

### Changed - v1.1.0

- A journey request from a registered frame or worker without `journey:read` does not count `bus.rejected_message` now. Each frame and worker with the default permissions sends one at startup.
- When the bus finds a duplicated tab id, the newer document makes a new tab id. The older document keeps its id. Before, the document with the larger random context id made a new id, or no document did.
- A write that keeps the old value of an attribute or a text is not an answer to a click. A batch that sets `name` or `type` and then puts back the old value is not an answer either.
- A swap of marked elements under one parent is not an answer to a click. A marked element that only appears or only goes away is an answer.
- Click capture checks the node type of the clicked element, not `instanceof Element`. A click on an element of another window is then recorded.
- `metricsEndpoint` and `tracesEndpoint` work with each `serializer`. Metric batches and span batches always use OTLP. Before, the `ecs` serializer or a custom serializer turned these endpoints off and reported `config.invalid`.
- With a custom serializer, the transport worker sends the metric batches and the span batches. The log batches still use the main thread.
- The package has no `engines` field. An install with `engine-strict` no longer fails on an older Node version. Use Node 22 or later. The tests run on Node 22.22.3.
- **Development:** `devEngines` in `package.json` sets Node 22.22.3 or later for this repository.
- **Development:** the workspace accepts the `@emnapi` versions that `oxc-parser` pins for `@napi-rs/wasm-runtime@1.2.7`. `pnpm peers check` passes.
- **Development:** GitHub CI runs the `verify` steps on the Node floor and on Node 24. It also builds the playgrounds and runs the playground tests, the browser tests and the playground smoke tests.
- **Development:** the Prettier config prints Markdown tables in compact form, with no column padding.
- **Development:** `playground/react-custom-backend` is a new example. A React 19 app sends its logs to its own backend through a custom `serializer`. `tools/mock-app-api.mjs` is its mock app API, with a login, prices and orders.
- **Development:** `playground/react` is now an FX workspace on `dockview-react` 8.9.1. It has a login, a saved layout for each user and tenant, popout windows, panel windows and 11 panels. It calls `observeWindow()` for each popout.
- **Development:** the replay player in `playground/react/src/replay-player/` replaces the replay spike and the replay viewer. The workspace does not install their rrweb packages now, so it does not declare the `@rrweb/types` peer.
- **Development:** `tools/mock-ingest-server.mjs` keeps replay segments in a bounded memory store. `GET /v1/replay/recordings` and `GET /v1/replay/recordings/<id>` read them.
- **Development:** the mock ingest server and the mock app API listen on `127.0.0.1` only. They refuse a `Host` header that is not `localhost` or `127.0.0.1`.
- **Development:** `tools/mock-app-api.mjs` has `POST /api/refresh` for the token refresh recipe.
- **Development:** `pnpm run test:playground` runs one Chromium smoke test for each playground app.
- **Development:** `e2e/observe-window.e2e.ts` checks `observeWindow()` with a real popup in Chromium, Firefox and WebKit.

### Fixed - v1.1.0

- A popup that `window.open()` opens gets its own tab id at startup. Before, it kept the tab id that it copied from its opener.
- React's input writes no longer hide each `ui.dead_click`. React writes `name` and `type` at each render with no net change.
- With `diagnostics.records`, a diagnostic from the check of the next settings in a rotation goes to the new identity. An example is `config.invalid`. Before, the library dropped that record during the rotation.
- A `shutdown()` before the end of startup reports each held record to `onDrop` with `load_failed`. Before, with `bus: { mode: "off" }`, the library lost these records with no report.
- A `shutdown()` after the delivery stack loads, but before the end of startup, sends the startup records. Before, the library lost them with no report.
- A `shutdown()` during the sender load of a `carry` rotation rejects the rotation. `onDrop` reports the carried records in memory with `security_context`. Before, the rotation resolved, and the library lost the records with no report.
- A `shutdown({ clearStorage: "context" })` during that load removes the stored batches of the old context. Before, these batches stayed on the device.
- After a failed load of the delivery stack, `shutdown({ clearStorage })` still removes the stored batches that a `carry` rotation during a pause left.
- The testing examples in `docs/guides.md` and `llms.txt` call `memory.clear()` after `await shutdown()`. Before, the records that `shutdown()` sent reached the next test.
- `docs/configuration.md` and the `endpoint` JSDoc tell that a relative `endpoint` works. The library also reports `config.invalid` with the origin that gets the records.
- `docs/ingest-server.md` tells that the batches for `metricsEndpoint` and `tracesEndpoint` use OTLP with each `serializer`. This includes a `text/plain` exit batch.
- `docs/delivery-guarantees.md` tells how a `413` splits a batch. It also tells that the library loses an exit batch that gets a `413`, with no `onDrop` report.
- `docs/configuration.md` tells that an exit batch can hold more than `batching.logBatchSize` records.
- `docs/runtime-policies.md` tells that a full `payloadMode: "defer"` queue builds its pending calls inside the log call that finds it full.
- The "Logout on a shared device" recipe uses `clearStorage: "namespace"`. With `"context"`, the parked batches of earlier page loads stay on the device for `retention.maxAgeMs`.
- `docs/configuration.md` and `docs/threat-model.md` tell that the processors of the sender do not run on a record from a frame or a worker. Only `redact` runs on it again.
- `docs/threat-model.md` and `docs/production-recipes.md` tell that `shutdown()` removes each `registerFrame()` and `registerWorker()` registration.
- The "Consent withdrawal" recipe tells that a frame or a worker with its own `endpoint` becomes its own sender when the owner starts no bus.
- `CHANGELOG.md` has the 1.0.0 section one time. Before, it had that section two times.
- **Development:** the debug bundle test does not fail now when the random security context id holds "abc".

## [1.0.0] - 2026-11-20

The first stable release. It has breaking changes from 0.12.0. Read `docs/migration-v1.md` before you upgrade. Each feature of 1.0.0 is stable. `docs/release-and-support.md` gives the stability rules and the deprecation policy.

### Added - v1.0.0

- `gauge(name, options)` returns a gauge. `set(value, attributes?)` keeps the last value for each attribute set. Each interval sends that value as one point. With `metricsEndpoint`, the point is an OTLP gauge.
- `measure(name, fn, attributes?)` times one function call. A promise result ends the measure when it settles. A throw or a rejection gives the outcome `"error"`. The histogram is `ui.measure.duration` with the attributes `measure.name` and `measure.outcome`.
- `shutdown(options?)` takes options. The default `pending: "flush"` sends the open interval of the meters and the profiler, and each record in memory. It waits for those requests, then runs the exit flush and stops each request that is still open. The stored batches stay in storage.
- `shutdown({ pending: "discard" })` sends nothing and runs no exit flush. `onDrop` reports each record in memory with `discarded`.
- `shutdown({ clearStorage: "context" | "namespace" })` discards. It removes the stored batches, the emergency queue entries, the stored session id, the tab id and the journey. It also works after an earlier `shutdown()`. `clearStorage: null` removes nothing.
- `flush({ timeoutMs })` and the flush result. The result has `status`, `accepted`, `stored`, `dropped`, `forwarded` and `pending`. Each count is a number of records. `status` is `"complete"`, `"timeout"` or `"inactive"`. `"complete"` means that no record waits. It does not prove delivery.
- `getHealth().delivery` has `lastFailureAt`, `consecutiveFailures`, `throttledUntil` and `dropped`. A rotation resets the first three. It keeps `dropped` and `lastSendAt`.
- The `LossReason` `"partially_rejected"`. An OTLP `2xx` answer with `partialSuccess` gives the rejected count to `onDrop`. The library does not send the batch again.
- The `LossReason` `"disabled"`. It reports a record that a child context forwards during a pause. It also reports the held records when the first `configure()` call sets `enabled: false`. It also reports the records in memory at a `pagehide` or a `shutdown()` during a pause. Each record is reported one time.
- The `LossReason` `"discarded"`.
- `buffering.maxHeldRecords` limits each hold buffer. The default is 500, and the range is 200 to 10000.
- The diagnostic codes `transport.partial_success`, `capture.trace_header_kept`, `bus.protocol_mismatch` and `security.rotation_failed`.
- The `getHealth()` issues `security.rotation_failed` and `records.refused`.
- The bus messages `ui-observability.message.flush-request` and `ui-observability.message.flush-result`.
- New exported types: `DeliveryHealth`, `FlushOptions`, `FlushResult`, `FlushStatus`, `Gauge`, `Logger`, `RoutingOptions`, `ShutdownOptions` and `StorageScope`. The package exports the options type of each config section.
- `llms.txt` in the package. It describes the library for a large language model, with the public functions, the main config keys, the recipes and the common mistakes.
- `docs/migration-v1.md`. It gives the steps from 0.12.x to 1.0.0.
- `docs/api.md`, `docs/configuration.md`, `docs/guides.md`, `docs/ingest-server.md` and `docs/development.md`. They hold the reference text from the README.
- `docs/release-and-support.md`, the release contract. It has a release step that turns on GitHub private vulnerability reporting.
- `docs/production-recipes.md`. It gives login, logout, tenant rotation, token refresh, consent withdrawal and the initialization order. It also tells how to change the context after a failed load of the rotation code.
- `docs/architecture.md`. It gives the record path, the buffers and the state changes of the runtime.
- `SECURITY.md`. It gives the private route for a vulnerability report.
- `pnpm run check:consumers`. It packs the package and type-checks three consumers. `verify` runs it.
- `pnpm run test:e2e`. It runs the browser tests in Chromium, Firefox and WebKit. The tests include the session replay with the real `@rrweb/record` recorder, a `srcdoc` frame on the message link and a failed load of the rotation code.
- `pnpm run test:collector`. It sends records to a pinned OpenTelemetry Collector and checks what the collector wrote.
- `pnpm run bench:release`. It runs the release benchmark against `bench/budgets.json`.
- The mock ingest server has `GET /__received`, `GET /__echo` and `POST /__reset` for tests. `UIOBS_MOCK_PORT` sets its port. `UIOBS_MOCK_RECORD=1` keeps the requests.
- `uiobs doctor` names the `415` of a stock OpenTelemetry Collector in the result of the `beacon` rule.

### Changed - v1.0.0

#### Start and pause

- **Breaking:** The library starts at the first `configure()` call that works. Before that call, it installs no capture. It starts no bus and no sender. It sends nothing.
- A log call before `configure()` waits in the hold buffer. With the default `consoleOutput` settings, it prints nothing.
- At the start, a held record gets the `processors`, the `redact` hook, the identity, the levels, the sampling, the `limits` and the `page.url` rule of the startup call.
- At the start, the library removes the breadcrumbs of log calls from before the start. The breadcrumbs of `addBreadcrumb()` stay.
- Before the first `configure()` call that works, the ids stay in memory. The library writes nothing to `localStorage` or `sessionStorage`.
- The first `configure()` call that works sets each setting that is fixed at startup, also after an early log call. This includes `identity`, `correlation`, `storage`, `bus.mode`, `bus.openFinRole` and `otelLoader`.
- **Breaking:** `enabled: false` pauses the library at any time. The library first sends the open interval of the counters, gauges, histograms and probes. It then removes its captures, the replay recorder and its network patches. The sender sends nothing. The records from before the pause go out after `enabled: true`.
- A pause stores no new record. A failed request in flight, a sender load that ends, a `retain` rotation and a logout deletion still change storage.
- A first `configure()` call with `enabled: false` fixes the startup settings. It starts no bus and no sender, and it writes nothing to storage. The runtime starts at the first `enabled: true`.
- A paused forwarder drops the records of its child contexts.
- `shutdown()` during a pause sends nothing. A rotation with `pending: "flush"` during a pause acts as `discard`.
- **Breaking:** `rotateSecurityContext()` rejects before the first `configure()` call that works.
- **Breaking:** `getHealth().status` has two new values, `"unconfigured"` and `"disabled"`. A failed first `configure()` call reports `"unconfigured"`.

#### Config rules

- **Breaking:** In each `configure()` call, an omitted key or a key with the value `undefined` keeps its current value. This applies at each depth.
- **Breaking, security:** `headers: undefined` now keeps the headers and the token in them. With isolation on, which is the default, use `rotateSecurityContext()` at logout. With isolation off, use `headers: null`.
- **Breaking:** `null` removes a hook. This applies to `redact`, `onDrop`, `onDiagnostic`, `contextProvider`, `otelLoader`, `transport`, `transportOnExit`, `transportWorker`, `capture.urlTransform` and the `loader` of `capture.webVitals`.
- **Breaking, security:** A `redact` value that is not a function keeps the current hook. Without a current hook, the library drops each record until `redact` is a function or `null`.
- **Breaking, security:** A `processors` list with an entry that is not a function keeps the current list. Without a current list, the library drops each record until `processors` is a list of functions or `[]`.
- **Breaking, security:** If the first `configure()` call cannot read its options, the library writes a console warning. It installs no capture and drops each record until a call sets `redact` to a function or `null`.
- **Breaking:** On a limit key, `null` sets no limit and `0` sets a limit of zero. Before, `0` set no limit.
- **Breaking:** These keys do not accept `0`: `buffering.maxPendingRecords`, `buffering.maxPendingBytes`, `correlation.sessionIdleMs`, `correlation.traceMaxAgeMs`, `debugBuffer.maxAgeMs`, `bus.maxMessageBytes`, `bus.maxRecordsPerMessage` and `bus.maxMessagesPerSecond`. `captureLimits.windowMs` must be 1 or more.
- **Breaking:** `null` turns off `metricsEndpoint`, `tracesEndpoint` and `replay.endpoint`. Their default is `null`. An empty or blank string also turns them off, and it reports `config.invalid`.
- **Breaking, security:** A relative endpoint URL resolves against `document.baseURI`. The library reports the origin that gets the records. It refuses an endpoint URL with a user name or a password, and it refuses a blank `endpoint`.
- **Breaking:** A new `sampling.rates` map replaces the current map. A rate outside 0 to 1 removes its entry.
- **Breaking:** `sampling.alwaysSampleTypes` has the type `LogType[]`. An unknown type reports `config.invalid`.
- **Breaking:** A `consoleOutput` object without `level` keeps the current level.
- **Breaking:** `metrics.maxHistogramBoundaries` applies only to the boundaries that the app gives to `histogram()`.
- **Breaking:** You cannot change `bus.mode` and `bus.openFinRole` after startup. A later change reports `config.invalid` and keeps the value.
- An invalid `sampling.defaultRate`, `sampling.remoteMaxRate` or `serializer` keeps the current value.
- A message for a hook, a URL key or a choice key does not print the text of the value.
- A config section that is not an object reports `config.invalid`.
- These pairs report `config.invalid`, and the values stay: `transport` with `transportWorker`, `transportOnExit` without `transport`, `capture.remoteToggles` without `sampling.remote`, and `capture.propagateTraceHeaderTo` without `capture.fetch` or `capture.xhr`.
- The resolved config no longer copies an unknown key.

#### Config shape

- **Breaking:** The section `capturePolicy` is now `captureLimits`. `captureLimits.windowMs` sets only the capture rate limits.
- **Breaking:** `sampling.errorCeiling` replaces `capturePolicy.errorCeiling`. `sampling.errorCeilingWindowMs` sets its window.
- **Breaking:** `metrics.intervalMs` replaces `batching.metricFlushIntervalMs` and `profiler.flushIntervalMs`. Counters, gauges, histograms and probes use this interval.
- **Breaking:** A capture with options takes `true` or an options object. `longFrames: { thresholdMs }`, `userTiming: { include }`, `webVitals: { loader }` and `console: { levels }` replace `longFrameMs`, `userTimingInclude`, `webVitalsLoader` and the console list. An unknown key inside an options object reports `config.invalid`.
- **Breaking:** The `storage` section replaces the `storage` string and the `persistence` section: `storage: { backend, namespace, requestPersistent }`. You cannot change the section after startup.
- **Breaking:** `consoleOutput` replaces the top-level `console` key. `ConsoleOutputOptions` replaces `ConsoleOptions`.
- **Breaking:** Each section type has the name of its key plus `Options`, for example `SamplingOptions`. The `...Policy` type names are gone.
- **Breaking:** `replay.maxSegmentEvents` and `replay.maxSegmentBytes` replace `replay.batchSize` and `replay.batchBytes`.
- **Breaking:** `replay.uploadWindowMs` sets the window of `replay.uploadsPerWindow`. Before, `capturePolicy.windowMs` set it.

#### Security context rotation

- **Breaking:** `rotateSecurityContext()` takes the routing settings in `routing`. The type `DeliveryOptions` is now `RoutingOptions`. Each key that is not a routing setting reports `config.invalid`, and the rotation ignores it.
- **Breaking:** Rotation `timeoutMs` accepts 0 to 600000. A value outside this range rejects the rotation.
- **Breaking, security:** A rejected rotation stops the delivery of the old context. The library drops each new record with the `onDrop` reason `security_context` until a rotation succeeds. `getHealth()` shows `security.rotation_failed` and `senderReady: false`.
- **Breaking, security:** After a rejected rotation, the next rotation that succeeds applies its `pending` rule to the stored records and the emergency queue of the closed context. With `flush`, it removes them, as `discard` does.
- **Breaking:** `rotateSecurityContext()` calls run in call order. A call during another rotation waits, and then it runs.
- **Breaking:** A rotation rejects only for a routing value that it cannot apply. A warning does not reject it.
- **Breaking:** A rotation in a forwarder rejects, and the forwarder's delivery stays open.
- **Breaking:** A record that the library builds during a rotation goes to `onDrop` at once with `security_context`.
- A rotation with `pending: "discard"` or `"flush"` removes the stored batches of the old context also when no sender runs, for example during a pause or before consent.
- A rotation with `pending: "retain"` stores the records that wait in memory under the old context.
- `rotateSecurityContext()` rejects an `update.context` that is not an object. A `null` context counts as no context. A `null` or `undefined` value in `update.context` sets no key.
- The rotation code loads in its own chunk on the first `rotateSecurityContext()`.

#### Public API

- **Breaking:** `flush()` now returns `Promise<FlushResult>`, not `Promise<void>`.
- **Breaking:** `flush()` now waits at most 5000 ms by default. `timeoutMs` sets the wait, from 0 to 600000 ms.
- **Breaking:** In a frame, a worker or an OpenFin view, `flush()` now waits for the answer of the sender. The sender gets 90 percent of the time that is left.
- **Breaking:** `getHealth()` puts the delivery state in a `delivery` block. `pending`, `inFlight`, `stored` and `lastSendAt` are no longer top-level fields.
- **Breaking:** `setContext(values)` takes an attribute map and merges it. A `null` value removes its key. An `undefined` value keeps the current value. A value that is not an object reports `config.invalid` and changes nothing.
- **Breaking:** `getJourneyToken()` returns `null` when no journey is active.
- **Breaking:** The package exports the logger class only as the type `Logger`. `getLogger()` and `PluginContext.logger` use `Logger`.
- **Breaking:** `startTrace()` is now `newTrace()`.
- `getHealth().delivery.consecutiveFailures` resets only when the server accepts a batch.

#### Delivery

- **Breaking:** Without `headers`, the exit batch to another origin is a keepalive `fetch` with `text/plain;charset=UTF-8`. It obeys `credentials`, so by default it sends no cookie. Only `credentials: "include"` uses `sendBeacon`. The CORS answer of the ingest server must permit the origin of the page.
- **Breaking:** The exit batch to an endpoint on the origin of the page is a keepalive `fetch` with the content type of the serializer. Before, it was a `text/plain` beacon.
- **Breaking:** A `fetch` request that already has a `traceparent` header keeps it. The library records no client span for it and reports `capture.trace_header_kept`. Before, the library replaced the header.
- **Breaking:** On a metric point from a frame or a worker, the `redact` of the sender can change `metric.name`, `metric.unit` and `metric.attribute_keys`.
- A forwarded record gets its metric and span fields back only when its `log.type` and namespace are those of the library, and each field has the shape that the library writes.
- The library reads at most 16 KiB of the body of a `413` or of an OTLP `2xx` answer. `delivery.requestTimeoutMs` also limits that read.
- The main thread waits 1000 ms more for an answer from a transport worker that is ready.
- A full hold buffer keeps its first 100 records of each kind. It drops the oldest record after them.
- `StorageAdapter.save()` returns `Promise<boolean>`. The value is true only when the batch is in storage when the save ends.
- The `transport.http_error` and `transport.throttled` texts tell whether storage kept the batch.
- The exit flush counts the keepalive bytes that are still in flight from the flush of the hidden page.

#### Bus

- **Breaking:** A same-origin child frame compares the bus protocol tag of its parent with its own tag before a direct call. With a different tag, it reports `bus.protocol_mismatch` and tries a message link.
- The bus starts a flush for other contexts at most one time each second. It keeps at most 4 waiting flush requests for each source and 100 in total.
- The bus does not take a flush request on the broadcast link.
- A flush that a frame or a worker asks for does not send the open interval of the metrics and the profiler of its sender.
- The bus sends each answer for a worker to that worker only.

#### Session replay

- **Breaking:** Session replay always blocks each element in `[data-observability-ignore]`.
- The `capture.rate_limited` text for a full replay buffer says that the replay of an error in that time starts at the error, with no events from before it.

#### Build, browsers and docs

- The build targets ES2021. The library supports Chrome 85, Edge 85, Firefox 79 and Safari 14.1 and later.
- The README and `docs/browser-support.md` state that OpenFin support is not validated on a real OpenFin runtime.
- The gzip budget of the main graph is 55,524 B. The measured main graph is 50,478 B.
- The README is short. It has the installation, the quick start, three recipes and a table of the reference documents.
- The ingest contract is in `docs/ingest-server.md`. Its rules do not change.
- Lint enforces braces on each conditional again. `eslint-config-prettier` had turned the `curly` rule off.

### Removed - v1.0.0

- **Breaking:** `logMetric()` and the logger method `logMetric()`. Use `counter()`, `gauge()` or `histogram()`.
- **Breaking:** `timeSync()`, `timeAsync()` and the logger methods of the same names. Use `measure()`. `measure()` logs no ERROR record on a failure.
- **Breaking:** `getStats()` and `getQueueDepth()`. Use `getHealth().delivery`.
- **Breaking:** `clearPersistedLogs()`. Use `shutdown({ pending: "discard", clearStorage: scope })`.
- **Breaking:** `setContextMap()`. Use `setContext(values)`.
- **Breaking:** The type `DeliveryStats` and the value export `OneLogger`.
- **Breaking:** `retention.mode`. Set `retention.maxAgeMs` and `retention.maxAttempts` to `null` in place of `"until-delivered"`.
- **Breaking:** `delivery.retryIdleDelayMs`, `delivery.batchesPerDrain`, `correlation.sessionTouchMs`, `bus.maxTrackedSources` and `capturePolicy.maxErrorSignatures`. A config with one of these keys reports `config.invalid`.
- **Breaking:** `bus.validation`. The bus always checks each message. `getHealth().bus` no longer has `validation` and `maxTrackedSources`.

### Fixed - v1.0.0

- A log call no longer throws in Chrome 92, Firefox 91 and Safari 15.3 or older. Before, with console output or with `processors`, each log call threw. A second `configure()` also threw.
- Session replay sets `replay.id` when the browser has no `crypto.randomUUID`. This also applies to a page on plain `http`.
- `TransportError` keeps its `cause` in browsers without the ES2022 `cause` option.
- The type declarations work for a strict consumer with `moduleResolution` `"NodeNext"` (ES module or CommonJS) or `"Bundler"`, also with `skipLibCheck: false`. `exports` gives `import` and `require` each its own declarations, `index.d.ts` and `index.d.cts`.
- `configure({ redact: undefined })` no longer removes `redact`. The other hooks and the transports have the same fix.
- `redact`, `onDiagnostic`, `otelLoader` and the `loader` of `capture.webVitals` report `config.invalid` for a value that is not a function.
- `configure()` no longer throws when a getter in its input throws.
- `configure()` no longer writes into the app's object.
- A key that is fixed at startup no longer reports "cannot change after startup" for the value `undefined`.
- A histogram without custom boundaries no longer reports `config.invalid` when the boundary limit is low.
- `sampling: { defaultRate: undefined }` no longer sets the rate to `1`.
- `serviceName`, `serviceVersion`, `environment` and `securityContext.id` report `config.invalid` for a value that is not a string.
- An `undefined` style no longer reports `config.invalid`. `consoleOutput.styles: null` now reports `config.invalid`.
- A failed first `configure()` call after an early log call no longer lets records go out without `redact`.
- A failed first `configure()` call writes no id to `localStorage` or `sessionStorage`. It reports `config.invalid` to diagnostics, and it writes the console warning.
- A frame that logs before `configure()` uses the `bus.mode` of its first `configure()` call.
- A journey that starts before `configure()` stays active after the call. The journey token leaves the URL.
- A `newSession()` call before `configure()` keeps its session after the start.
- `onDrop` reports each lost record one time, also when a `pagehide` comes before a later rotation or `shutdown()`.
- A `shutdown()` before the end of startup reports the held records to `onDrop` with `load_failed`.
- A rotation that waits for the delivery stack load at `shutdown()` stops and rejects. Before, it could remove the stored batches of the old context.
- A rotation that a shutdown stops after it took the old records reports those records to `onDrop` with `security_context`.
- A rotation that a shutdown meets in its storage step rejects, and does not apply the new context.
- A delivery stack load that ends after a rejected rotation no longer sends the stored batches of the old context.
- After `shutdown()`, `startJourney()` and `adoptJourney()` write nothing to `sessionStorage`.
- `flush()` no longer waits without end for a request or a storage call that does not settle.
- A response body that stalls no longer holds a send past the request deadline or after a stop.
- `fetch(request, init)` with trace propagation builds the request one time with the whole init of the caller. With an empty init, it keeps the referrer of the request.
- A refused beacon marks the keepalive budget as used, so a later exit batch goes to the emergency queue.
- A diagnostic no longer says that the library stored a batch that storage did not keep.
- A `srcdoc` or `about:blank` frame forwards its records through its same-origin parent. Before, the parent refused its `"null"` origin, and the frame sent its own records past the `redact` of the parent.
- In Firefox, a `srcdoc` frame without a direct link finds its same-origin parent through the `origin` global of the parent. A `srcdoc` frame inside a `srcdoc` frame also finds it.
- A `srcdoc` or `about:blank` parent sends a new security context to its direct children. Before, the next batch of such a child was dropped with only a `security.context_mismatch` count.
- A `srcdoc` parent under `bus.sourcePolicy: "trusted-origin"` accepts its same-origin children. It also does not report them as untrusted.
- A `srcdoc` forwarder accepts the sampling rules of its parent on the message link.
- A replay snapshot that fails at an error no longer keeps the upload open. Before, each later event went to the replay endpoint with no end. Now the library sends no replay for that error and reports `capture.record_failed`.
- A replay snapshot that fails halfway sends no part of itself. The buffer then waits for the next full snapshot, so an upload always starts with one.
- A failed replay snapshot does not use an upload of `replay.uploadsPerWindow`.
- The library reports a full replay buffer one time for each recording, also when the first snapshot is too large.
- A new replay recording does not report the dropped events of an earlier recording.
- The replay uploader sends no segment after a later call removes both `replay.endpoint` and `replay.onSegment`.
- The mock ingest server no longer stops on a log record, a span or a metric point with no time. It prints `observedTimeUnixNano` for a log record, or `-` when the record has no time.
- The mock ingest server answers `400` to a JSON body that does not have the expected shape. Before, that body stopped the server.
- `docs/ingest-server.md` names `application/x-ndjson` for `serializer: "ecs"`. It says that `408` and each `5xx` make the library send the batch again.

## [0.12.0] - 2026-11-16

### Added - v0.12.0

- `profiler.probe(name, options?)` returns a probe that times spans of app code. A probe has `begin()`, `end(token)`, `endAfterPaint(token)` and `record(durationMs)`. The profiler is off by default. Set `profiler.enabled: true` to turn it on. While it is off, `begin()` returns `-1` and a probe does not read the clock. A probe stays valid across `configure()` and `shutdown()`, and no call throws.
- Every `profiler.flushIntervalMs` (default 10000, range 1000 to 600000) the library sends one `ui.profile.duration` histogram record for each probe that has data. The record has the count, sum, minimum, maximum and buckets, and the attributes `profile.probe`, `profile.sample_every`, `profile.p50`, `profile.p90`, `profile.p99`, `profile.self_p99` and `profile.overhead_ns`. `flush()`, `shutdown()`, `newSession()` and the exit flush also send the open interval. With `metricsEndpoint`, the record is an OTLP histogram point with the attributes `profile.probe` and `profile.sample_every`.
- `profiler.maxProbes` sets the number of probes. The default is 64 and the range is 1 to 1024. It cannot change after startup. A probe above the limit does nothing, and the library reports `config.invalid`.
- Probe option `sampleEvery: n` measures one span in every `n`. A span that is not measured does not read the clock.
- Probe option `slowMs` adds a breadcrumb with the new category `profile` for each span that runs longer than the value.
- Probe option `async: true` is for spans that an `await` splits. These spans report the total time only and do not change the self time of other spans.
- `profile.self_p99` is the p99 of the self time of a probe with nested spans. The self time of a span is its duration without the measured spans inside it. The span stack has 32 levels.
- `profiler.time(name, fn)` calls `fn` and times the call. When the result has a `then` function, the span ends when the result settles.
- `probe.endAfterPaint(token)` ends a span in the first task after the next paint. The duration then includes style, layout and paint. In a hidden page, or without `requestAnimationFrame`, the span ends at once.
- `profiler.framePhases: true` adds the phases of each long animation frame to every probe that had a span of 1 ms or more in that frame. The library sends them as the histogram `ui.profile.frame.duration` with the attributes `profile.probe` and `profile.frame_phase`. The phases are `script`, `render`, `style_layout` and `forced_layout`. A browser without long animation frames reports `capture.install_failed` one time.
- `profiler.framePacing: true` measures the time between frames with the probe `frame.interval`.
- At the end of the first interval with data, the profiler measures the cost of one `begin()` and `end()` pair and reports it as `profile.overhead_ns`. The measurement runs one time and blocks the thread for about 2 ms to 3 ms. `flush()`, `shutdown()` and the exit flush do not run it.
- Session replay. The new `replay` config section records the DOM with the recorder of the app, `@rrweb/record`, and keeps the recent events in memory. After an ERROR or FATAL record, the library sends the buffer and the events of the next `replay.afterErrorMs` to `replay.endpoint`. The replay is off by default. `replay.loader` loads the recorder, for example `() => import("@rrweb/record")`.
- `@rrweb/record` `^2` is a new optional peer. An app with the replay off does not need it.
- `replay.bufferMs` (default 60000) and `replay.maxBufferBytes` (default 10000000) limit the buffer. `replay.afterErrorMs` (default 5000) sets the time after an error. `replay.uploadsPerWindow` (default 3) limits the uploads in each `capturePolicy.windowMs` window.
- Replay uploads are batched. A segment closes at `replay.batchSize` events (default 200), at `replay.batchBytes` (default 512000) or after `replay.flushIntervalMs` (default 2000). One segment is in flight at a time. `replay.maxAttempts` (default 3) and `replay.maxQueueBytes` (default 20000000) limit the retries and the queue. `delivery.requestTimeoutMs`, `delivery.retryBaseDelayMs` and `delivery.retryMaxDelayMs` apply.
- `replay.headers` sets the request headers of the replay endpoint, as an object or a function. The library never sends the `headers` of the log endpoint to the replay endpoint.
- `replay.onSegment` receives each segment in place of the request to `replay.endpoint`.
- Replay privacy. `replay.maskText` and `replay.maskInputs` are `true` by default. The library masks the text of each element and the value of each `input`, `textarea` and `select`, including hidden inputs and file inputs. A masked input value is `********`. A password input is always masked. Text in an element with the attribute `data-observability-unmask` stays in clear text. `replay.maskSelectors` and `replay.blockSelectors` take CSS selectors. An invalid selector reports `config.invalid`, and the replay does not start. The library also removes the query of the page URL and masks text that sits directly in a shadow root.
- `replay.recordCanvas` (default `false`) records canvas elements.
- `replay.requireConsent: true` records nothing until `startReplay()`. `stopReplay()` stops the recorder, stops the request in flight and drops the events that are not sent. The recorder then stays off until the next `startReplay()`, also after a later `configure()`.
- Each record has the attribute `replay.id` while the recorder runs. Each segment has `replay.id`, `session.id`, `tab.id`, `service.name` and `sequence`.
- `newSession()` and `rotateSecurityContext()` drop the replay buffer and start a new recording with a new `replay.id`.
- The replay capture has its own install key. A change of another capture setting in `configure()`, or a remote capture switch, keeps the recorder, the buffer and the `replay.id`.
- A change of `replay.endpoint`, `requireConsent`, `maskText`, `maskInputs`, `maskSelectors`, `blockSelectors`, `recordCanvas`, `bufferMs`, `capture.fullUrls` or `capture.ignoreUrls` starts a new recording and drops the buffer. A new `loader` function, `onSegment` function, `recordOptions` object or plugin function also does this. The batch settings, the limits and `replay.headers` apply to the recorder that runs.
- A replay that could not start for a missing `loader`, `endpoint` or `onSegment` starts when a later `configure()` adds the missing value.
- `replay.plugins` takes functions that create record plugins of the recorder. Each function gets `transformRequest`, a `transformRequestFn` for the network plugin. It skips each request to a URL in `capture.ignoreUrls` and removes the query of a URL unless `capture.fullUrls` is set.
- `replay.recordOptions` passes `sampling`, `slimDOMOptions`, `ignoreClass`, `ignoreSelector`, `ignoreCSSAttributes`, `userTriggeredOnInput`, `recordAfter`, `inlineStylesheet` and `dataURLOptions` to the recorder. Another key reports `config.invalid`.
- The library adds `replay.endpoint` to `capture.ignoreUrls`. A failed replay request then cannot start a new upload.
- The replay endpoint contract in the README. Each segment is one `POST` with a JSON body, `X-UiObs-Batch-Id: <replay.id>-<sequence>` and `X-UiObs-Attempt`. The library sends a segment again after `429`, `5xx`, `401` and `403`.
- `collectDebugBundle()` has a `replay` summary. It shows whether headers are set, the number of plugins and the key names of `recordOptions`, not their values.
- New exported types: `Probe`, `ProbeOptions`, `Profiler`, `ProfilerPolicy`, `ReplayPolicy`, `ReplayLoader`, `ReplayPluginLoader`, `ReplayPluginTools` and `ReplaySegment`.
- `uiobs doctor` has a `beacon` rule. It sends a `POST` with `Content-Type: text/plain;charset=UTF-8`, the batch id in `uiobs_batch_id` and `uiobs_exit=pagehide`, as the exit flush does. The tool now sends four test batches.
- `uiobs doctor` accepts `--header "Name: value"`, more than one time. With a custom header the tool sends no beacon, because the exit flush then uses a keepalive fetch.
- `uiobs doctor <url> --origin <origin> --replay` tests a replay endpoint. The rules are `preflight`, `allowed headers`, `test segment`, `gzip`, `large segment` and `deduplication`. The tool sends four test segments with `service.name: "uiobs-doctor"`. The `large segment` rule sends one segment of 5 MB without gzip. It finds a body limit of the server that is too low for a full snapshot. That request has the default `delivery.requestTimeoutMs` of 15 seconds.
- `tools/mock-ingest-server.mjs` and `tools/reference-collector.mjs` accept `/v1/replay`. The reference collector limits a replay body to `MAX_REPLAY_BODY_BYTES` (16 MB by default).
- Playground pages: a profiler overhead benchmark and a blotter page in `playground/vanilla`, a session replay control on the vanilla page, and a replay example with an IndexedDB store and an `rrweb-player` viewer in `playground/react`.
- `docs/attributes.md`, `docs/runtime-policies.md` and `docs/threat-model.md` describe the profiler attributes, the `profiler` and `replay` sections and the risks of the profiler and the session replay. `docs/browser-support.md` and `docs/delivery-guarantees.md` have rows and sections for the profiler and the session replay.

### Changed - v0.12.0

- **Breaking:** `capture.longFrameThresholdMs` is now `capture.longFrameMs`. The library ignores the old key and uses the default of 100. Rename the key in your configuration.
- The usage output of `uiobs doctor` prints only the known words and a URL without its query and user info. It prints `<hidden>` for each other argument. The tool refuses a URL with a user name or a password.
- The gzip budget of the main graph is 49,993 B. The measured main graph is 45,448 B.
- A `config.invalid` message now says "the current value" where it said "the value in force". Example: "The library keeps the current value." The change applies to 16 messages of `configure()`. Update a test or an alert that compares the full text.
- The usage line of `uiobs doctor` names the option `--replay`.
- Use pnpm 12.21.0. Update the development dependencies to their latest versions. TypeScript stays at 6.0.3.
- Add the package scripts `prepare` and `fix`.

### Fixed - v0.12.0

- `counter()` and `histogram()` no longer throw when the options are `null` or have a getter or a Proxy trap that throws. The instrument uses the defaults, and the library reports `config.invalid`. This also applies to the `counter()` and `histogram()` of a capture plugin.
- `startMeasure()` no longer throws when the `toString()` of the name throws. The measure has an empty name, and the library reports `record.sanitize_failed`.
- A fault in the observer callback of the long frame capture or the user timing capture no longer becomes an uncaught error of the page. The library reports `capture.record_failed`.
- The `webVitals` capture logged `navigation.dom_interactive_ms`, `navigation.dom_complete_ms` and `navigation.load_ms` as 0 when the library started before the load event. The capture now reads the navigation timing one task after the load event. It leaves out a value that the browser has not set. When the page becomes hidden before the load event, the capture logs the values that are ready. It logs the other values after the load event.
- On a prerendered page, `navigation.dom_interactive_ms`, `navigation.dom_complete_ms` and `navigation.load_ms` counted from the start of the prerender. They now count from the activation of the page, and a value is not less than 0. The capture reports nothing before the activation. `navigation.type` is `prerender` for such a page. The `web-vitals` package uses the same rule for its metrics.

## [0.11.0] - 2026-11-07

### Changed - v0.11.0

- **Breaking:** Require Node 22.22.3 or later. Node 20 and earlier Node 22 releases are no longer supported.
- Replace npm workspaces with pnpm 12.18.0. Keep separate dependency catalogs for the library and each playground in `pnpm-workspace.yaml`.
- Replace `package-lock.json` with `pnpm-lock.yaml`. Link consumer playgrounds to the local library with `workspace:*`.
- Update development dependencies, including Angular 22, Vitest 5 and Happy DOM 21. Use TypeScript 6.0.3 to meet Angular and linter requirements.
- Update development commands and Angular configuration for pnpm. Document consumer installation with npm, pnpm and Yarn, with exact versions. Consumers do not need pnpm.

### Fixed - v0.11.0

- Give attached frame test fixtures empty `srcdoc` content. This creates their windows with iframe loading disabled in Happy DOM 21.
- Wait for runtime startup and capture imports directly in the affected tests.

## [0.10.0] - 2026-11-06

### Added - v0.10.0

- `sampling.alwaysSampleFrom` sets the lowest level that the sampling rate never drops. The default `"ERROR"` keeps the earlier behavior. `capturePolicy.errorCeiling` limits the log records at this level and higher.
- `delivery.priority` sets the fetch priority of each batch request. The default `"low"` lets the requests of the app go first. The exit flush and a keepalive send from a hidden page use the browser default.
- `persistence.requestPersistent: true` asks the browser to keep the stored batches under storage pressure. It calls `navigator.storage.persist()` one time at startup. `getHealth()` reports the state in `storagePersistence`. The default is `false`, because Firefox can show a permission prompt.
- Log and span records carry `uiobs.clock_offset_ms`, the server time minus the client time. It comes from the `Date` header of the last accepted answer. The server must expose `Date` to CORS. A custom transport returns it in `TransportResponse.date`. `metadata.clockOffset: false` turns it off.
- `diagnostics.records: true`, or a list of codes, also sends each reported diagnostic as a record in the namespace `uiobs.diagnostics`. A fault has the level `WARN`. A normal event has the level `INFO`. A diagnostic during the build of a diagnostic record gives no record. A diagnostic of the first `configure()` gives no record. In a record, the `url` and `endpoint` detail fields have no query and no fragment.
- `docs/delivery-guarantees.md` describes duplicates, order, each loss with its `onDrop` reason, retention, the exit flush and rotation.
- `debugBuffer: { enabled: true }` keeps the records that `minLevel` or sampling drops. An ERROR or FATAL record of this context sends them first, with `uiobs.debug_buffer: true`. The owner of a frame does not sample these records again. The privacy hooks run at the time of the log call. A later change of `redact` or `processors` clears the buffer. `maxRecords` (default 200) and `maxAgeMs` (default 60000) limit the buffer.
- `capture.interactions.rageClicks` records one `ui.rage_click` for each burst of 3 clicks on one element in 1 second. `capture.interactions.deadClicks` records `ui.dead_click` when a click on a control gives no DOM change, no navigation and no scroll in 1 second. A click on a `target="_blank"` or `download` link gives no event. Each event names only the action. `ui.rage_click` also has the click count. `rageClickCount`, `rageClickWindowMs` and `deadClickMs` set the thresholds.
- `capture.uncleanExit` finds a page of the tab that stopped without a clean close, for example after a crash. The next page logs WARN `ui.unclean_exit` with the previous session id, the last-seen time, the last visibility and `exit.discarded`. It keeps one `sessionStorage` key. A popup with an opener reports nothing. A duplicated tab can report a false exit. `identity: "memory"` turns the capture off.
- `capture.userTiming` records each `performance.measure()` of the app in the histogram `ui.user_timing.duration` with `user_timing.name`. Each `performance.mark()` adds a breadcrumb. `capture.userTimingInclude` keeps only the names that match. Names follow `capture.fullUrls`.
- `collectDebugBundle()` returns a JSON-safe bundle for a support ticket. It has the health, the diagnostic counters, the resource, the page URL, the breadcrumbs after the privacy hooks, the debug buffer and a config summary without headers or URL queries. A plugin or a custom serializer shows only its name. A debug buffer record keeps its context attributes. The app decides where to send the bundle.
- Remote sampling answers can carry temporary capture switches. Only the names in `capture.remoteToggles` apply. The default list is empty. Privacy controls stay local.
- `capture.serverTiming` adds response duration entries to fetch and XHR records. A valid traceparent entry links the client span to the server span.
- `capture.reports` records deprecations, interventions and CSP reports as WARN `ui.report`. It omits message text and code samples. Report URLs have no credentials, query or fragment.
- `capture.resourceTiming` records `ui.resource.duration` by initiator type and host. Its `slowMs` setting also records slow resources. The capture skips ingest endpoints and ignored URLs.
- `capture.lifecycle` records visible, hidden, frozen, resumed and restored states. Each event has the time in the previous state. A capture reinstall keeps the state and its start time.
- `capturePolicy.reportsPerWindow`, `resourcesPerWindow` and `lifecyclePerWindow` give each new capture a separate rate limit.
- `payloadMode: "defer"` keeps payload references and builds records in idle time. The default `"copy"` builds at the call. Deferred calls keep their timestamp, trace, journey and ambient context keys. Flush, shutdown, page exit and identity changes drain pending calls. The debug buffer keeps immediate builds and privacy hooks.
- `transportWorker` creates a dedicated HTTP transport worker. The worker calls `serveTransportWorker()`. Built-in encoding, gzip and HTTP sends run there. Header functions, retry, storage and exit sends stay on the main thread. A private port checks the exact SDK version. Worker startup or channel failures use HTTP fallback. A worker that does not connect before the request deadline is a startup failure. A worker module that does not load also selects HTTP. An offline failure uses no stored attempt.
- `startMeasure(name, attrs?)` times an operation with named phases. `phase(name)` closes the open phase and starts the next phase. `end(outcome?)` records the total. Each phase goes into the histogram `ui.measure.phase.duration`, and the total goes into `ui.measure.duration`, in milliseconds. With `tracesEndpoint`, the measure is a span with one child span for each phase.
- `npx @utk09/ui-observability doctor <url> --origin <origin>` checks an ingest server against the ingest contract. It tests the preflight, the allowed and exposed headers, a test batch, gzip and a repeated batch id. It prints `PASS` or `FAIL` for each rule. It sends real test batches with `service.name: "uiobs-doctor"`.

### Changed - v0.10.0

- OTLP logs and spans use the logger namespace as the instrumentation scope name, for example `blotter.grid`. A record without a namespace keeps the scope `@utk09/ui-observability`. The scope has no version. Metrics keep the library scope. Update each backend query that filters by scope name.
- `shutdown()` cancels a request that is still open after its final flush. A custom transport sees this in `request.signal`. A stored batch of that request stays in storage.

### Fixed - v0.10.0

- A rotation sends the new delivery identity at once to each same-origin frame on the direct link. The owner no longer refuses the first batch of that frame after the rotation.
- A same-origin frame with an explicit `securityContext.id` clears `security.context_mismatch` in `getHealth()` when the owner rotates to that ID.
- A `config.invalid` message no longer prints the value of `headers`. A message about an invalid `endpoint`, `metricsEndpoint` or `tracesEndpoint` has no query and no fragment.

## [0.9.5] - 2026-11-01

### Added - v0.9.5

- `rotateSecurityContext(update, options?)` changes the delivery identity and settings together. The `pending` rule is `"discard"`, `"flush"`, `"retain"` or `"carry"`. The default is `"discard"`. `"carry"` moves each stored batch to the new id with no attempts. The retry engine sends it. Logger calls during this step go to the new context. Without a new destination, the stored batches stay parked under the old id. `newSession()` stays a correlation change. Use awaited rotation for logout or tenant changes.
- `lockConfiguration` refuses changes through `configure()`. Identical repeated settings are accepted. `setConfigurationLocked(false)` permits changes again. Explicit context rotation stays available while configuration is locked.
- `getHealth()` reports SDK versions, runtime state, delivery role and counts, configuration lock state, cache usage and security/bus policies. Version conflicts and context conflicts have machine-readable issue codes. A configured console-only runtime can report `"ready"`.
- `registerFrame(frame, options)` binds a child window to an exact origin and source permissions. It accepts an iframe element or a `Window`, also a cross-origin one. `registerWorker(worker, options?)` now accepts permissions. Both functions return a function that removes the registration. The default permission is `"records"`. Journey and sampling access need separate permissions.
- `bus.sourcePolicy`, `bus.validation` and bus budgets control source checks, message checks, message bytes, record counts, message rates and named source tracking. A registration binds its exact origin under each source policy. Limits can be disabled where documented.
- `loggerCache.maxEntries` sets the LRU logger cache limit. The default is 256. Set 0 for no cache or null for no limit. A logger that the app holds stays valid after removal from the cache.
- `delivery` sets request timeouts, request concurrency, retry delays and the number of batches in one stored delivery pass.
- `buffering` sets live record and encoded-byte limits. Its overflow rule removes old records, drops new records or tries storage. A record larger than the byte limit is dropped alone. The storage rule permits only one overflow write at a time.
- `metrics` sets limits for instrument names, attribute sets and histogram boundaries. `correlation` sets session and trace timing. Correlation settings take effect at startup.
- `capturePolicy` sets breadcrumb capacity, error duplicate checks, capture rate limits and the pipeline error ceiling. `diagnostics` sets the report interval and the console fallback rule.
- `persistence.namespace` separates application batch stores, emergency queues and retry lock names. It takes effect at startup. `clearPersistedLogs()` removes the stored records of the active context. `clearPersistedLogs("namespace")` removes the stored records of all contexts in that namespace. Pending requests can store records again after removal.
- `metadata` controls page URL, user agent and OpenFin resource fields. `capture.urlTransform` replaces the default URL formatting rule. It receives the original URL. Null, an invalid result or an exception gives an empty URL. An exception reports `capture.record_failed`.
- Custom transport requests include `signal` and `routingContextId`. A custom transport must check the signal to cancel its own work when the old context stops.

### Changed - v0.9.5

- Enabled click capture records a stable `data-observability-action` value, or `"unknown-click"`, by default. `capture.interactions.actionAttribute` selects another attribute, for example `data-testid`. It does not record text or selectors. The object form of `capture.interactions` can enable those details. Selectors are in `breadcrumb.data.selector`. `ignoreSelector: null` permits capture in all regions.
- Delivery is isolated by context by default. Replay after a page reload requires an explicit stable `securityContext.id`. Batches from other contexts and old batches without an id stay stored. Storage retention and capacity limits still apply to them. Set `securityContext.isolation: false` to permit cross-context replay and ordinary delivery reconfiguration.
- With isolation enabled, changes to delivery settings or identity use `rotateSecurityContext()` instead of `configure()`. `configure()` keeps the delivery settings in force, reports `config.invalid` and applies its other settings. Delivery fields not supplied during rotation reset to their defaults. Old credentials and signal endpoints are not retained. Calls logged during rotation are dropped and counted.
- Child-frame forwarding requires registration by default, including the same-origin direct path. Select `bus.sourcePolicy: "trusted-origin"` to permit automatic source discovery by origin. Message validation defaults to `"strict"`.
- Bus messages use the envelope tag `ui-observability/2` and longer type names, for example `ui-observability.message.hello`. A frame on an earlier version ignores them. Load the same library version in each frame.
- The owner sends a new delivery identity to registered frames, workers and OpenFin views. A forwarder that knows its owner welcomes its own children. It relays their records. It sends them the identity of its owner. The first identity that a forwarder takes keeps its startup records. When the owner identity later changes, a forwarder clears its buffered records, also before startup completes. `onDrop` reports them with `security_context`.
- Live delivery buffers default to 10,000 records and 16 MiB of encoded JSON, with `"drop-oldest"` overflow. Metric instrument names default to a limit of 1,000 per collection interval. Extra instrument names are dropped and counted. Set the corresponding limit to 0 for no limit.
- `capturePolicy.breadcrumbs: 0` disables breadcrumb storage. Before, a zero capacity kept one breadcrumb.
- Diagnostic console fallback is off by default. When enabled, it prints a fixed warning if `onDiagnostic` throws. It does not print the exception, message or stack.
- `capture.urlTransform` also applies to WebSocket URLs. Without it, a socket URL still has no query or fragment, also with `capture.fullUrls`.
- IndexedDB schema version 12 adds a context/time index. Context reads and counts no longer load batches of other contexts.
- The size budget of the main graph is 36,000 B to include the operational controls.
- See [runtime policies and migration](docs/runtime-policies.md) for defaults, overrides, update timing and upgrade steps.

### Fixed - v0.9.5

- Console output below the delivery level or outside the sample now passes through configured processors and redaction. Sampled-out breadcrumbs use the processed message too. Hooks can run without a telemetry send. A local record is not processed twice for console output.
- Old queued records cannot use a new delivery context when isolation is enabled. Context ids stay with batches through storage, retries and splitting. Old HTTP requests are cancelled where possible. A request that the server already accepted cannot be recalled.
- HTTP capture ignores completions from an old security context. WebSocket capture also checks the context that opened each socket before it records lifecycle events or message counts.
- Retained memory queues survive context rotation. A slow save that completes after a discard removes its old batch. A rejected rotation no longer causes a later shutdown to reject.
- Incoming and outgoing bus controls check source permissions. Changing a self-reported context id does not reset the physical source's rate budget.
- The owner answers a hello, a journey question or a sampling question only to the child that asked. Before, each known child frame received each answer.
- The cross-origin playground server sets the library version value. Before, its child frame stopped with a `ReferenceError` at load.
- Lint rejects empty named imports and continues to permit imports that run a module for its side effects.

## [0.9.4] - 2026-10-31

### Added - v0.9.4

- `startJourney(name, { id })` sets the journey id. An id of 1 to 64 letters, digits, `_`, `.`, `:` or `-` stays. Another value gives a new id and a `config.invalid` report.
- `addBreadcrumb(message, data?)` adds a breadcrumb with the category `custom`. The library copies `data` at the call.
- `minLevels` sets a minimum level for each namespace prefix, for example `{ "trading.ticks": "DEBUG" }`. The longest prefix that matches at a dot wins. A namespace with no match uses `minLevel`. A new map replaces the map in force.
- Remote sampling rules can have `minLevels`, with at most 100 prefixes. A remote prefix wins over the remote `minLevel`. A remote level only lowers the level of a namespace.
- `contextProvider()` gives attributes for each record that sampling keeps. Its values override `setContext()` values. The logger scope and the call payload override its values. A provider that throws reports `handler.threw`. A value that is not an object reports `config.invalid`. The record is still built.
- `getStats()` gives `{ pending, inFlight, stored, lastSendAt }`. `pending` counts the records in the buffers. `inFlight` counts the records in requests. `stored` counts the batches in storage. `lastSendAt` is the time of the last batch that the server accepted. A forwarder reports only its own buffers. The package exports the type `DeliveryStats`.
- `newSession()` starts a new session in this tab, for example after a logout. It sends the open metric points, ends the active trace and journey, clears the breadcrumbs and writes the new id to `localStorage`. Other tabs read the new id at their next startup. A tab does not write its old id over the new id.
- `processors` is a list of functions that change or drop a record. They run in list order, before `redact`. A processor has the contract of `redact`. A processor that throws or returns a value that is not a record drops the record. The diagnostic code `record.dropped_by_processor` counts the drops.
- `capture.plugins` adds capture modules of the app. A plugin has `name`, `install(ctx)` and `uninstall()`. `ctx` gives `logger`, `counter()`, `histogram()`, `addBreadcrumb()` and `ownRequest(fn)`. The logger namespace is `uiobs.capture.<name>`. A plugin that throws in `install()` or `uninstall()` reports `capture.install_failed`. The package exports the types `CapturePlugin` and `PluginContext`.
- `capture.webSocket` records `websocket.open`, `websocket.close` and `websocket.error` for each WebSocket, with `url.full` and `server.address`. The URL has no user info, no query and no fragment. The counter `ui.websocket.messages` counts the messages by `network.io.direction` and `server.address`. The library never reads the content of a message. It records at most 20 lifecycle records in each 10-second window. It skips a socket in `capture.ignoreUrls`, and does not count a send of the library. `instanceof WebSocket` stays true for a socket that the app opened before the capture loaded. The capture loads as a separate chunk.
- `tracesEndpoint` sets an OTLP traces endpoint, for example `https://ingest.example/v1/traces`. With it, the library sends spans as an OTLP `ExportTraceServiceRequest`. Without it, the library sends no span. It needs `serializer: "otlp"`, and `endpoint` or `transport`. A batch of spans without `tracesEndpoint` counts `record.dropped_no_destination`.
- Each trace of the library has one root span. It ends when the trace rotates, at the exit flush, at `shutdown()` and, in a frame or a view that forwards its records, on `pagehide`. Its name is `ui.start`, `ui.interaction`, `ui.navigation` or `ui.trace`.
- Each `fetch` or XHR request that gets `traceparent` has one CLIENT span. The `traceparent` names the client span. The root span is its parent.
- `sampling.defaultRate` samples each trace by its trace id. The whole trace stays or goes. For a trace that sampling drops, `traceparent` has the sampled flag off. `minLevel` does not apply to a span. The library sends no span for a trace from the OpenTelemetry API.
- Spans go through `processors` and `redact`. The console does not print them. At exit, the logs get the beacon budget before the spans.
- `request.kind` of a custom transport is `"traces"` for a batch of span records.
- The ECS serializer writes `ecs.version` (`8.10.0`), `log.logger`, `event.kind` and `error.type`, `error.message` and `error.stack_trace`.
- On Node, the library runs console-only. It installs no capture, keeps the ids in memory, uses no storage and has no exit flush. If you set `endpoint`, `metricsEndpoint`, `tracesEndpoint` or `transport`, it reports `config.invalid` one time.
- `tools/reference-collector.mjs` is a reference ingest server with no dependencies. It implements each rule of the ingest contract, deduplicates for 24 hours and can forward to an OTLP collector. It listens on `127.0.0.1` by default, limits the rate of each client address and limits the body size after gzip decoding. It is not part of the package.
- The mock ingest server accepts `/v1/traces` and prints each span.
- The documents `docs/attributes.md`, `docs/browser-support.md` and `docs/threat-model.md`.
- The README tells that each top-level tab sends its own records.

### Changed - v0.9.4

- The type `LogType` has the new value `"span"`. The type `BatchKind` has the new value `"traces"`.
- The sender runs its `redact` on each record from a frame or a worker. A context that never calls `configure()` then cannot send a raw record. Write `redact` so that a second run gives the same result.
- A `redact` hook that changes a record in place now gets the sanitizer and the size limit. Before, only a new record from the hook got them.
- With `processors` or `redact`, a record from before startup no longer gets `journey.id` and `journey.name` after the hooks ran.
- The library removes the user info, for example `user:pass@`, from each URL that it records, also with `capture.fullUrls`. `error.source` follows `capture.fullUrls`.
- With `storage: "memory"` or `"none"`, the exit flush does not use the emergency queue in `localStorage`. A batch that it cannot send is lost, and `onDrop` reports `not_stored`.
- `adoptJourney()` refuses a token without a start time, or with a start time more than 5 minutes ahead.
- A tab no longer writes its session id over a newer session id of another tab that has not expired.
- The ECS serializer moves `app.namespace` and the string `error.type`, `error.message` and `error.stack_trace` attributes out of `labels`. The other attributes stay in `labels`.
- A console-only runtime next to another version of the library also ignores `metricsEndpoint` and `tracesEndpoint`.
- The size budget of the main graph is 32,200 B.

### Fixed - v0.9.4

- A reused XHR sent a second record for its earlier request at each later send.

## [0.9.3] - 2026-10-31

### Fixed - v0.9.3

- The limit on ERROR and FATAL records starts a new window when the clock moves back. Before, the library dropped each ERROR and FATAL record above the limit until the clock passed the old window start.

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

| Section | Removed keys |
| --- | --- |
| `streams` | `logs.batchSize`, `logs.flushIntervalMs`, `metrics.batchSize`, `metrics.flushIntervalMs` |
| `retry` | `baseDelayMs`, `maxDelayMs`, `idleDelayMs` |
| `journey` | `maxAgeMs`, `endOnOwnerClose`, `urlParam` |
| `limits` | `maxBodyChars`, `maxAttributeChars`, `maxAttributeCount`, `maxStackChars`, `maxDepth`, `maxArrayLength`, `maxRecordBytes` |
| `storage` | `dbName`, `maxBatches`, `maxAgeMs`, `maxAttempts` |
| `bus` | `channelName`, `handshakeTimeoutMs`, `maxHandshakeAttempts`, `maxBootBufferRecords`, `openFinHost`, `orphanPolicy` |
| `capture` | `maxBreadcrumbs`, `errorDedupeMs` |
| top level | `maxConcurrentRequests`, `requestTimeoutMs`, `compressionThresholdBytes` |

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

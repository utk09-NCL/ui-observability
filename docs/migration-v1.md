# Migration to 1.0.0

This document tells a user of 0.12.x how to change an app for 1.0.0. Each item is one change. `CHANGELOG.md` gives each change of the release.

Upgrade each copy of the library on a page in the same release. [Coordinated microfrontend upgrade](release-and-support.md#coordinated-microfrontend-upgrade) gives the steps. The [upgrade checklist](runtime-policies.md#upgrade-checklist) gives the steps of earlier upgrades.

## Config

1. Use `null`, not `undefined`, to remove a hook or a transport. An omitted key or `undefined` now keeps the current value.
2. At logout, use `rotateSecurityContext()`, not `headers: undefined`. `headers: undefined` now keeps the headers and the token in them.
3. Give `redact` a function or `null`. Another value now keeps the current hook. With no current hook, the library drops each record.
4. Give `processors` a list of functions or `[]`. A list with an entry that is not a function now keeps the current list. With no current list, the library drops each record.
5. Change `0` to `null` where `0` meant "no limit". On a limit key, `0` now sets a limit of zero.
6. Change `""` to `null` on `metricsEndpoint`, `tracesEndpoint` and `replay.endpoint`.
7. Give the full `sampling.rates` map in each call that sets it. A new map replaces the current map.
8. Set `bus.mode` and `bus.openFinRole` only in the first `configure()`. A later change reports `config.invalid`.
9. `captureLimits.windowMs` now sets only the window of the capture rate limits. Set the window of the replay uploads in `replay.uploadWindowMs`. Set the window of the error ceiling in `sampling.errorCeilingWindowMs`. The default of each is 10000 ms.
10. Change each key in this table. A key that the library does not know reports `config.invalid`.

| 0.12.x                                                                                                                                             | 1.0.0                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `console` (top level)                                                                                                                              | `consoleOutput`                                                   |
| `capturePolicy`                                                                                                                                    | `captureLimits`                                                   |
| `capturePolicy.errorCeiling`                                                                                                                       | `sampling.errorCeiling`                                           |
| `batching.metricFlushIntervalMs`, `profiler.flushIntervalMs`                                                                                       | `metrics.intervalMs`                                              |
| `capture.longFrameMs`                                                                                                                              | `capture.longFrames: { thresholdMs }`                             |
| `capture.userTimingInclude`                                                                                                                        | `capture.userTiming: { include }`                                 |
| `capture.webVitalsLoader`                                                                                                                          | `capture.webVitals: { loader }`                                   |
| `capture.console: ["error", "warn"]`                                                                                                               | `capture.console: { levels: ["error", "warn"] }`                  |
| `storage: "indexeddb"` with `persistence: { namespace, requestPersistent }`                                                                        | `storage: { backend: "indexeddb", namespace, requestPersistent }` |
| `retention.mode: "until-delivered"`                                                                                                                | `retention: { maxAgeMs: null, maxAttempts: null }`                |
| `delivery.retryIdleDelayMs`, `delivery.batchesPerDrain`, `correlation.sessionTouchMs`, `bus.maxTrackedSources`, `capturePolicy.maxErrorSignatures` | No key. Remove it.                                                |
| `bus.validation`                                                                                                                                   | No key. The bus always checks each message.                       |

11. Change each imported section type in this table.

| 0.12.x type                             | 1.0.0 type             |
| --------------------------------------- | ---------------------- |
| `BufferingPolicy`                       | `BufferingOptions`     |
| `CapturePolicy`                         | `CaptureLimitsOptions` |
| `ConsoleOptions`                        | `ConsoleOutputOptions` |
| `CorrelationPolicy`                     | `CorrelationOptions`   |
| `DebugBufferPolicy`                     | `DebugBufferOptions`   |
| `DeliveryPolicy`                        | `DeliveryOptions`      |
| `DeliveryOptions` (the rotation fields) | `RoutingOptions`       |
| `DiagnosticsPolicy`                     | `DiagnosticsOptions`   |
| `MetadataPolicy`                        | `MetadataOptions`      |
| `MetricsPolicy`                         | `MetricsOptions`       |
| `PersistencePolicy`                     | `StorageOptions`       |
| `ProfilerPolicy`                        | `ProfilerOptions`      |
| `ReplayPolicy`                          | `ReplayOptions`        |

## Start and pause

12. The library now starts at the first `configure()` call that works. Before that call, it installs no capture, starts no bus and sends nothing. The records wait in memory.
13. Call `setConfigurationLocked(true)` and `rotateSecurityContext()` only after `configure()`. Before it, a lock refuses the first call, and a rotation rejects.
14. `enabled: false` now also stops the captures, the replay recorder, the meters, the profiler and the delivery. The records wait. They go out after `enabled: true`.

## Functions

15. `logMetric()` has no replacement with the same name. Use a gauge, a counter or a histogram.

```ts
// 0.12.x
logMetric("queue.depth", 12, "items", "gauge", { queue: "orders" });

// 1.0.0
gauge("queue.depth", { unit: "items" }).set(12, { queue: "orders" });
```

Use `counter(name, { unit }).add(value, attributes)` for `"counter"`. Use `histogram(name, { unit }).record(value, attributes)` for `"histogram"`.

16. `timeSync()` and `timeAsync()` are now `measure()`. `measure()` does not log the error. Add a catch to keep the ERROR record of 0.12.x.

```ts
// 0.12.x
const rows = await timeAsync("rows.fetch", () => fetchRows(), { grid: "orders" });

// 1.0.0
const rows = await measure("rows.fetch", () => fetchRows(), { grid: "orders" }).catch(
  (err: unknown) => {
    getLogger("app").error("rows.fetch failed", err);
    throw err;
  },
);
```

- On an error, `timeSync()` and `timeAsync()` also logged the ERROR record `<label> failed` with the error. `measure()` records the outcome `"error"` and gives the error back to the caller. The app logs it.
- The histogram is now `ui.measure.duration` with `measure.name` and `measure.outcome`. Before, it was `<label>.duration` with `status`. Change the backend queries.
- The value `"SUCCESS"` of `status` is now the value `"ok"` of `measure.outcome`. The value `"FAILURE"` is now `"error"`.
- An attribute value must be a string, a finite number or a boolean.

17. `getStats()` and `getQueueDepth()` are now the `delivery` block of `getHealth()`.

```ts
// 0.12.x
const stats = await getStats();
const depth = await getQueueDepth();

// 1.0.0
const stats = (await getHealth()).delivery;
const depth = (await getHealth()).delivery.stored;
```

`getHealth()` does not wait for the delivery stack to load. The type `DeliveryStats` is now `DeliveryHealth`.

18. `getHealth().pending`, `.inFlight`, `.stored` and `.lastSendAt` are now in the `delivery` block.

```ts
// 0.12.x
const pending = (await getHealth()).pending;

// 1.0.0
const pending = (await getHealth()).delivery.pending;
```

19. `getHealth().bus` no longer has `validation` and `maxTrackedSources`.
20. An exhaustive `switch` on one of these unions breaks, because each one has new values. Add a case for each new value.

| Union                                  | New values since 0.12.0                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `getHealth().status`                   | `"unconfigured"`, `"disabled"`                                                                                        |
| `getHealth().issues`                   | `"security.rotation_failed"`, `"records.refused"`                                                                     |
| `LossReason`, the `reason` of `onDrop` | `"disabled"`, `"discarded"`, `"partially_rejected"`                                                                   |
| `DiagnosticCode`                       | `"bus.protocol_mismatch"`, `"capture.trace_header_kept"`, `"security.rotation_failed"`, `"transport.partial_success"` |

21. `clearPersistedLogs()` is now a `shutdown()` option. The shutdown stops the runtime, so call `configure()` again.

```ts
// 0.12.x
await clearPersistedLogs("context");

// 1.0.0
await shutdown({ pending: "discard", clearStorage: "context" });
configure(config);
```

22. `setContext(key, value)` and `setContextMap(values)` are now `setContext(values)`. A `null` value now removes its key. In 0.12.x, it set the value `null`.

```ts
// 0.12.x
setContext("tenant", "tenant-a");
setContextMap({ tenant: "tenant-a", region: "eu" });

// 1.0.0
setContext({ tenant: "tenant-a" });
setContext({ tenant: "tenant-a", region: "eu" });
```

23. `startTrace()` is now `newTrace()`.

```ts
// 0.12.x
startTrace();

// 1.0.0
newTrace();
```

24. The class `OneLogger` is now the type `Logger`. `new OneLogger()` has no replacement. Use `getLogger()`.

```ts
// 0.12.x
import { OneLogger } from "@utk09/ui-observability";
let log: OneLogger;

// 1.0.0
import type { Logger } from "@utk09/ui-observability";
let log: Logger;
```

25. `getJourneyToken()` returns `null` when no journey is active.

```ts
// 0.12.x
if (getJourneyToken() === undefined) {
  startJourney("checkout");
}

// 1.0.0
if (getJourneyToken() === null) {
  startJourney("checkout");
}
```

26. `rotateSecurityContext()` takes the routing settings in `routing`. Put only routing settings in it. Another key reports `config.invalid`, and the rotation ignores it.

```ts
// 0.12.x
await rotateSecurityContext({ id, delivery: { endpoint, headers } });

// 1.0.0
await rotateSecurityContext({ id, routing: { endpoint, headers } });
```

27. A rotation `timeoutMs` must be from 0 to 600000. A value outside this range rejects the rotation.
28. A rejected rotation now stops the delivery of the old context. The library then drops each new record with the `onDrop` reason `"security_context"` until a rotation succeeds. `getHealth().issues` has `"security.rotation_failed"`.
29. Call `rotateSecurityContext()` in the sender only. In a forwarder, the rotation rejects, and the delivery of the forwarder stays open.

## Delivery

30. Code that ignores the result of `flush()` needs no change.
31. `flush()` now waits 5000 ms at most. For a longer wait, call `flush({ timeoutMs })`.
32. Where code expects delivery after `flush()`, check the counts of the result. `status: "complete"` means only that no record waits. A dropped record and a stored record also count as complete.

```ts
// 0.12.x
await flush();

// 1.0.0
const result = await flush({ timeoutMs: 10000 });
if (result.pending > 0 || result.dropped > 0 || result.stored > 0) {
  // Some records did not reach the server yet, or never will.
}
```

33. Change a test that asserts that `flush()` resolves to `undefined`. Assert on the result.
34. After a failed load of the rotation code, do not call `rotateSecurityContext()` until a reload. Call `shutdown({ pending: "discard", clearStorage: "context" })`, then `configure()`.

## Delivery and the ingest server

These changes came after 0.12.0, before the other changes in this document. An app owner or an ingest server owner must act on them.

35. Without `headers`, the exit batch to another origin is now a keepalive `fetch` with `text/plain;charset=UTF-8`. In 0.12.x, it was a beacon.
    - The `fetch` obeys `credentials`. By default it sends no cookie. A beacon always sends the cookies.
    - The CORS answer of the server must permit the origin of the page. Otherwise a page that is still open sends the batch again at the next page load.
    - For cookie authentication, set `credentials: "include"`. The exit flush then uses a beacon.
36. The exit batch to an endpoint on the origin of the page now has the content type of the serializer, for example `application/json`. In 0.12.x, it was a `text/plain` beacon. Accept that content type on the exit path. A sandboxed, `srcdoc` or `about:blank` frame still sends `text/plain`.
37. An OTLP server can answer `2xx` with `partialSuccess` in a JSON body. The library gives the rejected count to `onDrop` with the reason `"partially_rejected"`, and reports `transport.partial_success`. It does not send the batch again.
38. The library reads at most 16 KiB of the body of a `413` or of an OTLP `2xx` answer. `delivery.requestTimeoutMs` also limits that read. Put the `maxBytes` hint of a `413` in a small JSON body.
39. A `fetch` request that already has a `traceparent` header keeps it. The library records no client span for it and reports `capture.trace_header_kept`. In 0.12.x, the library replaced the header.
40. `buffering.maxHeldRecords` limits each hold buffer. The default is 500, and the range is 200 to 10000. A full hold buffer keeps its first 100 records of each kind. It drops the oldest record after them, and `onDrop` reports `buffer_full`. Raise the limit for an app that logs a large burst before startup ends.
41. On a metric point from a frame or a worker, the `redact` of the sender can now change `metric.name`, `metric.unit` and `metric.attribute_keys`. Make sure that the `redact` of the sender keeps these fields correct.

## Frames and workers

42. Call `configure()` in each context that must send records. A frame or a worker that never calls `configure()` sends nothing.
43. Call `configure()` in the parent before child frames load. A child that starts first becomes its own sender after 1,500 ms, or after 4,500 ms in a cross-origin frame.
44. Upgrade the frames and their parent together. A parent on an older version does not answer a flush request, and the frame gets `"timeout"`.
45. A same-origin child frame now compares the bus protocol tag of its parent with its own tag before a direct call. A different tag reports `bus.protocol_mismatch`, and the frame tries a message link. A `srcdoc` or `about:blank` frame now forwards through its same-origin parent. In 0.12.x, such a frame sent its own records.

## Replay

46. Change `replay.batchSize` and `replay.batchBytes` to `replay.maxSegmentEvents` and `replay.maxSegmentBytes`.
47. If `capture.rate_limited` says that the replay buffer is above `replay.maxBufferBytes`, raise the limit. Or block a large element with `replay.blockSelectors`.
48. The replay now always blocks each element in `[data-observability-ignore]`. You cannot turn this off.

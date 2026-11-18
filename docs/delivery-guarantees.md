# Delivery Guarantees

This page tells what the library promises about delivery. It lists each case where a record can be lost or can arrive more than one time.

## Summary

- The library tries to deliver each record at least one time. It stores a batch that did not send, and sends it again.
- The library can lose records in the cases that this page lists. `onDrop` reports each loss of a record that the library built.
- The server can get one batch more than one time. Deduplicate by batch ID.
- The library does not keep the order of batches. Order records by their time and by `log.seq`.

## Accepted Batches

A batch is delivered when the server answers `2xx`. A custom transport gives the same result when it returns a `2xx` status. The exit flush does not read the answer of the server. The library counts an exit batch as sent when the browser accepts the beacon or starts the keepalive fetch.

## Duplicates

The server can get a record more than one time in these cases:

| Case                                                                                | Batch ID |
| ----------------------------------------------------------------------------------- | -------- |
| A request times out, but the server already has the batch. The library sends again. | Same ID  |
| A stored batch goes again after a failed send, also after a page reload.            | Same ID  |
| A browser without Web Locks lets two tabs send the same stored batch.               | Same ID  |
| The exit flush sends the records of a request that has no answer yet.               | New ID   |

The ingest server must deduplicate on the `X-UiObs-Batch-Id` header and the `uiobs_batch_id` query parameter. Keep each ID for at least 24 hours. To find a duplicate record with a new batch ID, use `context.id` and `log.seq` together. Each record has a different pair.

A `413` answer makes the library split the batch. Each half gets a new batch ID. The server did not accept the first batch. No duplicate occurs.

The request deadline also covers the read of a response body. A body that does not arrive in time, or that fails, does not change the result of the status code. After a `413`, the library then splits the batch with no size hint. After a `2xx`, it accepts the batch with no `partialSuccess`. It reports `transport.http_error`. A stop or a rotation during the read ends the send.

An OTLP endpoint can answer `2xx` with `partialSuccess` in a JSON body. The library then gives the rejected count to `onDrop` with the reason `partially_rejected`. The server gives only a count, so `journeyIds` and `actions` are empty. The library reports `transport.partial_success`. It does not send the batch again, because the server kept the other records. A `partialSuccess` with no rejected records gives only the diagnostic.

## Order

- In one batch, the records of one resource and one logger namespace keep their order.
- Batches can arrive in any order. Up to `delivery.maxConcurrentRequests` requests run at the same time. A stored batch goes later than newer live batches.
- Logs, metrics and spans go in separate batches. They can go to separate endpoints.
- Use `timeUnixNano` to order records. In one context, `log.seq` gives the order of the records. `uiobs.clock_offset_ms` gives the difference between the clock of the device and the clock of the server.

## Losses

`onDrop` receives a summary of each loss. The `reason` field tells the cause.

| `reason`             | Cause                                                                                            | Setting to change                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `buffer_full`        | A hold buffer before startup, or the live buffer, is full.                                       | `buffering`                                                             |
| `expired`            | A stored batch is older than `retention.maxAgeMs`.                                               | `retention.maxAgeMs`                                                    |
| `over_capacity`      | Storage has `retention.maxBatches` batches. A new batch evicts an old batch.                     | `retention.maxBatches`                                                  |
| `quota`              | The browser storage quota is full.                                                               | A lower `retention.maxBatches`                                          |
| `max_attempts`       | A stored batch reached `retention.maxAttempts`.                                                  | `retention.maxAttempts`                                                 |
| `rejected`           | The server refused the batch permanently, or one record is too large for the server.             | The ingest server, `limits`                                             |
| `partially_rejected` | An OTLP server accepted the batch but rejected some records in it.                               | The ingest server                                                       |
| `unserializable`     | The serializer threw an error on the batch.                                                      | A custom `serializer`                                                   |
| `exit_queue_full`    | The emergency queue in `localStorage` is full. It drops its oldest batch.                        | None                                                                    |
| `load_failed`        | The delivery code did not load, or `shutdown()` came first.                                      | None                                                                    |
| `not_stored`         | Storage did not keep a batch after a failed send, for example with `storage.backend: "none"`.    | `storage.backend`                                                       |
| `security_context`   | A change of the delivery identity removed the records of the old identity, or a rotation failed. | The `pending` rule of `rotateSecurityContext()`, valid routing settings |

A hold buffer keeps the records that arrive before startup ends, or while the sender loads. `buffering.maxHeldRecords` sets its limit for the records that are not actions. The default is 500. The range is 200 to 10000. Actions have a separate limit of 2000. A full hold buffer keeps its first 100 records of each kind. It drops the oldest record after them. `onDrop` reports that record with `buffer_full`. Thus the first error of a failed startup stays in the buffer. The newest records also stay.

Some records never reach delivery by design. `onDrop` does not report them. The diagnostic codes in `getDiagnosticCounters()` show these cases:

- A record below `minLevel`, or outside the sample. With `debugBuffer`, the next error of the context sends the recent ones.
- A record that a processor or `redact` drops.
- A log record above the error ceiling, `sampling.errorCeiling`. Metric points and spans do not count.
- A capture event above its rate limit.
- A logger call during a rotation. The library does not build the record. A record that the library built during a rotation goes to `onDrop` with `security_context`.
- A `startMeasure()` measure that ends after `shutdown()`. With isolation, also one that ends after a new delivery identity.
- A bus message that a budget refuses, and the records of a forwarder that has no owner.

## Retention

A batch that did not send goes to storage. The default store is IndexedDB. Without it, the library uses `localStorage`, then memory.

- By default, a stored batch stays for 24 hours or 5 attempts. Storage keeps at most 500 batches.
- An offline failure and a throttle answer use no attempt. A network failure while the browser reports online uses one. A long server outage can then reach `max_attempts`.
- With `retention.maxAgeMs: null` and `retention.maxAttempts: null`, a stored batch has no age limit and no attempt limit. `retention.maxBatches` still applies.
- A full store evicts the oldest batch without an action record first. The library keeps action records longest. An action record is not an authoritative audit record.
- The store can evict the new batch. This occurs when each older batch has an action record. `onDrop` then reports the new batch with `over_capacity`.
- With `storage.backend: "memory"`, stored batches stay only until the page closes. With `storage.backend: "none"`, a batch that did not send is lost.
- After a failed send, the `transport.http_error` diagnostic tells the result for the batch. The library stores the batch, stores it in two parts, or drops it.
- While the server throttles, the library stores a new batch and does not send it. The `transport.throttled` diagnostic tells if storage kept the batch.
- Under storage pressure, a browser can delete the store. `storage.requestPersistent` asks the browser to keep it.

## Page Exit

The exit flush is best effort.

- When the page becomes hidden, the library sends the buffered records with a normal request. A send of 60 KB or less uses `keepalive`.
- On `pagehide` and `freeze`, the library sends payloads up to about 60 KB. To an endpoint on another origin, the request has the content type `text/plain`, which needs no CORS preflight. The batch id and the exit reason are in the query.
- With `credentials: "omit"` or `"same-origin"`, that request is a keepalive fetch with no custom header. It obeys `credentials`. Thus it sends no cookie to another origin.
- With `credentials: "include"`, that request is a beacon. `sendBeacon` always sends the cookies, whatever `credentials` is. Thus the library uses it only when the app asks for cookies.
- The answer to the `text/plain` keepalive fetch must permit the origin. If it does not, the fetch fails. A page that is still open then puts the batch in the emergency queue. The server gets that batch again at the next page load.
- It is possible that a keepalive fetch is less reliable than a beacon at page exit in some browsers. This is a hypothesis. `e2e/exit-flush.e2e.ts` shows that the `text/plain` keepalive fetch arrives after a navigation in Chromium, Firefox and WebKit. No test checks a tab close, a browser close or a slow network.
- With `headers`, it uses a keepalive fetch. It also uses a keepalive fetch for an endpoint on the origin of the page. That request has the content type of the serializer. For OTLP, that is `application/json`. The endpoint origin must be the same as `location.origin` and the `origin` global of the page. A sandboxed frame, a `srcdoc` frame and an `about:blank` frame send the `text/plain` request.
- A stock OpenTelemetry Collector on another origin refuses the `text/plain` batch with `415`. The exit flush does not read that answer. `onDrop` does not report that loss.
- To prevent that loss, set `headers` or put a same-origin proxy in front of the collector.
- With `headers`, the keepalive fetch to another origin needs a CORS preflight. It is possible that a browser cancels that request during page exit. No test in this repository checks this risk.
- A batch that does not fit goes to the emergency queue in `localStorage`. The next page load sends it. After the browser refuses a beacon, the exit flush starts no keepalive fetch in that flush. A batch that needs that fetch goes to the emergency queue. The exit flush also counts the keepalive requests of the hidden-page flush that are still in flight.
- The browser can stop a page before the flush ends. A mobile OS can stop a hidden page with no `pagehide`.
- `shutdown()` runs a normal flush, then the exit flush. It then cancels a request that is still open. A stored batch of that request stays in storage.

## Rotation

`rotateSecurityContext()` changes the delivery identity. Its `pending` rule decides what happens to the records of the old identity:

- `discard`, the default, removes them. `onDrop` reports them with `security_context`.
- `flush` tries one send with the old settings.
- `retain` keeps them in storage under the old identity.
- `carry` moves them to the new identity.

During a rotation, the library drops logger calls, metric measurements and forwarded records. `onDrop` reports the forwarded records and the records that the library built during the rotation with `security_context`. The library does not hold such a record for the next identity. A forwarder clears its buffered records when its owner changes identity. Rotations run in call order. Each call waits for the earlier call.

A rotation that rejects stops the delivery of the old identity. A rotation code chunk that does not load also rejects the rotation. The library keeps the unsent records of the old identity in storage under the old ID. `getStats().stored`, `getQueueDepth()` and `getHealth().stored` still count them. It sends no record with the old endpoint or headers until a rotation succeeds. `onDrop` reports each dropped record with `security_context`. The next rotation that succeeds applies its `pending` rule to the stored records and the emergency queue of the old identity. With `flush`, it removes them as `discard` does, because a flush would use the old settings. See [runtime policies](runtime-policies.md) for each rule.

## Deferred calls

With deferred logger calls, `log.seq` follows build order. `timeUnixNano` keeps the call time.

With `payloadMode: "defer"`, the logger keeps payload references before it builds records. Explicit flush, shutdown and page exit build pending calls before delivery. Session and delivery identity changes drain the calls before they change identity. A forwarder builds its pending calls before it clears records of an old owner identity.

The deferred queue has a count cap that is separate from the delivery buffers. A full queue builds its calls first. Extra calls from a hook at the cap remain unbuilt and increment `record.dropped_by_ceiling`. Delivery stats and `onDrop` apply after record construction.

## Worker delivery

A transport worker owns encoding, compression and HTTP sends for built-in serializers. The main runtime owns batching, record byte budgets, stored retries and the exit flush. A worker result has the same status meaning as an HTTP result. Header functions run on the main thread. Both paths share the cached result for exit sends.

A worker that does not connect before the request deadline is a startup failure. The library then sends over HTTP until a new factory or a rotation. The job never left the page. No duplicate occurs. A worker module that does not load also selects HTTP.

A worker failure can leave the result of an HTTP request unknown. HTTP fallback or a stored retry keeps the batch id. The ingest server must still deduplicate it. The main exit flush can also copy an unconfirmed worker batch. The ordinary duplicate rules apply to that copy.

A delivery rotation cancels pending jobs and terminates the old worker before it applies new settings. Each job holds its own endpoint and resolved headers. A late result cannot apply to the next sender. A hidden page uses the main HTTP keepalive path. Shutdown flushes records before it terminates the worker.

## Profiler points

A profiler summary record is a metric point. It follows the rules of this page from the moment the library builds it.

- A probe keeps its durations in memory until the end of the interval. `flush()`, `shutdown()`, `newSession()` and the exit flush send the open interval.
- A page that stops without an exit event loses the open interval. The interval is `metrics.intervalMs` long at most.
- A span that is open when the profiler turns off adds no value. With `securityContext.isolation`, a span that is open at a rotation adds no value.
- A probe above `profiler.maxProbes` adds no value. The library reports `config.invalid`.
- The count in a record is the count of measured spans. With `sampleEvery`, multiply it by `profile.sample_every` for an estimate.

## Session replay segments

A replay segment is not a batch. The promises of this page do not apply to it.

- A segment is only in memory. The library does not store it. A page reload or a crash loses each segment that is not sent.
- The exit flush sends no segment. An upload that is open when the page closes stops there.
- The library sends a segment again after `429`, `5xx`, `401`, `403` and a network error, up to `replay.maxAttempts`. Then it drops the segment and reports the reason to diagnostics. `onDrop` does not report a replay segment.
- Above `replay.maxQueueBytes`, the library drops the oldest segment that waits. Above `replay.maxBufferBytes`, the buffer drops its oldest part before an upload starts.
- The library sends the segments of one recording in the order of `sequence`, one at a time. A dropped segment leaves a gap in the sequence.
- The server can get one segment more than one time. Deduplicate by `X-UiObs-Batch-Id`, which is `<replay.id>-<sequence>`.
- `stopReplay()`, `newSession()` and `rotateSecurityContext()` drop each event and each segment that is not sent.

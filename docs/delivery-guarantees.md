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

| Case | Batch ID |
| --- | --- |
| A request times out, but the server already has the batch. The library sends again. | Same ID |
| A stored batch goes again after a failed send, also after a page reload. | Same ID |
| A browser without Web Locks lets two tabs send the same stored batch. | Same ID |
| The exit flush sends the records of a request that has no answer yet. | New ID |

The ingest server must deduplicate on the `X-UiObs-Batch-Id` header and the `uiobs_batch_id` query parameter. Keep each ID for at least 24 hours. With a longer `retention.maxAgeMs`, keep each ID for that time. To find a duplicate record with a new batch ID, use `context.id` and `log.seq` together. Each record has a different pair.

A `413` answer makes the library split the batch. Each half gets a new batch ID. The server did not accept the first batch. No duplicate occurs.

- The library always splits the batch into two halves. It does not use a size limit from the `413` body.
- The halves wait in storage until the retry drain sends them. A new stored batch brings the idle poll of the drain forward. The next drain then starts after `delivery.retryBaseDelayMs`, 2 seconds by default. A new stored batch does not cut a backoff or a `Retry-After` wait short.
- A half that gets a `413` again waits for the next drain. That drain starts after `delivery.retryBaseDelayMs`. It can start later when another stored batch waits for a throttle or a backoff.
- The exit flush does not read the answer to its own request. A `413` to that request does not split the batch. See [Page Exit](#page-exit).
- With `storage.backend: "none"`, the library cannot keep the halves. It loses the batch, and `onDrop` reports `not_stored`.
- A single record that gets a `413` cannot split. The library drops it, and `onDrop` reports `rejected`.

The request deadline also covers the read of a response body. A body that does not arrive in time, or that fails, does not change the result of the status code. After a `413`, the library then splits the batch, and the `transport.batch_split` diagnostic has no server limit. After a `2xx`, it accepts the batch with no `partialSuccess`. It reports `transport.http_error`. A stop or a rotation during the read ends the send.

An OTLP endpoint can answer `2xx` with `partialSuccess` in a JSON body. The library then gives the rejected count to `onDrop` with the reason `partially_rejected`. The server gives only a count, so `journeyIds` and `actions` are empty. The library reports `transport.partial_success`. It does not send the batch again, because the server kept the other records. A `partialSuccess` with no rejected records and an `errorMessage` gives only the diagnostic.

## Order

- In one batch, the records of one resource and one logger namespace keep their order.
- Batches can arrive in any order. Up to `delivery.maxConcurrentRequests` live requests run at the same time. The retry drain sends one stored batch at a time, outside that limit. A stored batch goes later than newer live batches.
- Logs, metrics and spans go in separate batches. They can go to separate endpoints.
- Use `timeUnixNano` to order records. In one context, `log.seq` gives the order of the records. `uiobs.clock_offset_ms` gives the difference between the clock of the device and the clock of the server.

## Losses

`onDrop` receives a summary of each loss. The `reason` field tells the cause.

| `reason` | Cause | Setting to change |
| --- | --- | --- |
| `buffer_full` | A hold buffer before startup, or the live buffer, is full. | `buffering` |
| `expired` | A stored batch is older than `retention.maxAgeMs`. | `retention.maxAgeMs` |
| `over_capacity` | Storage has `retention.maxBatches` batches. A new batch evicts an old batch. | `retention.maxBatches` |
| `quota` | The browser storage quota is full. | A lower `retention.maxBatches` |
| `max_attempts` | A stored batch reached `retention.maxAttempts`. | `retention.maxAttempts` |
| `rejected` | The server refused the batch permanently, or one record is too large for the server. | The ingest server, `limits` |
| `partially_rejected` | An OTLP server accepted the batch but rejected some records in it. | The ingest server |
| `unserializable` | The serializer threw an error on the batch. | A custom `serializer` |
| `exit_queue_full` | The emergency queue in `localStorage` is full. It drops its oldest batch. | None |
| `load_failed` | The delivery code did not load, or `shutdown()` came first. | None |
| `not_stored` | Storage did not keep a batch after a failed send, for example with `storage.backend: "none"`. | `storage.backend` |
| `security_context` | A change of the delivery identity removed the records of the old identity, or a rotation failed. | The `pending` rule of `rotateSecurityContext()`, valid routing settings |
| `disabled` | `enabled` is false, so the sender sends nothing. See the rules after this table. | `enabled` |
| `discarded` | `shutdown()` with `pending: "discard"` or `clearStorage` dropped the records in memory. | The `pending` option of `shutdown()` |

`onDrop` reports `disabled` in three cases.

- A child context forwards a record to a sender or a forwarder with `enabled: false`.
- The first `configure()` call sets `enabled: false`. The records that log calls held before that call are lost. The library runs `processors` and `redact` on them before the report.
- A `pagehide` or a `shutdown()` occurs during a pause. A `shutdown()` with `pending: "discard"` or `clearStorage` reports `discarded` instead. The pause has no exit flush, so the records in memory are lost. These are the records that wait for the delivery stack, and the records in its buffers, its queue and its requests. `onDrop` reports each record one time. A later `pagehide`, rotation or `shutdown()` does not report it again. A page that the browser restores from the back/forward cache still has these records. They then go out after `enabled: true`.

A pause keeps the other records. The records in memory and the stored batches go out after `enabled: true`.

- The pause first sends the open interval of the counters, histograms and probes. During the pause, they record nothing.
- A pause stores no new record. Four cases still write to storage or delete from it.
  - A request in flight at the pause fails. The library stores its batch.
  - A delivery stack load ends during the pause. It moves the emergency queue into storage. It also stores the batches that a carry left.
  - A rotation with `pending: "retain"` stores the waiting records under the old context.
  - A rotation with `pending: "discard"` or `"flush"` removes the stored batches of the old context. This is also true before consent, when the first `configure()` call has `enabled: false`. `onDrop` reports their records with `security_context`.
- A rotation with `pending: "flush"` during a pause sends nothing. It acts as `discard`.
- A rotation with `pending: "carry"` during a pause keeps the records in memory and the stored batches. The delivery stack of the new context takes them after `enabled: true`. A later rotation in the same pause applies its own rule to them. `discard` removes them. `retain` stores them under the context that the carry made.

`getHealth().delivery.dropped` counts each loss of this table for each reason, from the start of the runtime. It counts also without an `onDrop` hook. A rotation keeps the counts.

A hold buffer keeps the records that arrive before startup ends, or while the sender loads. `buffering.maxHeldRecords` sets its limit for the records that are not actions. The default is 500. The range is 200 to 10000. Actions have a separate limit of 2000. A full hold buffer keeps its first 100 records of each kind. It drops the oldest record after them. `onDrop` reports that record with `buffer_full`. Thus the first error of a failed startup stays in the buffer. The newest records also stay.

Some records never reach delivery by design. `onDrop` does not report them. The diagnostic codes in `getDiagnosticCounters()` show these cases:

- A record below `minLevel`, or outside the sample. With `debugBuffer`, the next error of the context sends the recent ones.
- A record that a processor or `redact` drops.
- A log record above the error ceiling, `sampling.errorCeiling`. Metric points and spans do not count. `record.dropped_by_ceiling` counts the record.
- A capture event above its rate limit.
- A logger call during a rotation. The library does not build the record. A record that the library built during a rotation goes to `onDrop` with `security_context`. The exception is the diagnostic record of the rotation's check of the next settings. That record goes to the new identity (see [Operational budgets](runtime-policies.md#operational-budgets)).
- A `startMeasure()` measure that ends after `shutdown()`. With isolation, also one that ends after a new delivery identity.
- A bus message that a budget refuses, and the records of a forwarder that has no owner.
- A record that a forwarder sends with another security context. The owner counts `security.context_mismatch`.
- A record with no destination, for example in console-only mode. `record.dropped_no_destination` counts the record.

## Retention

A batch that did not send goes to storage. The default store is IndexedDB. Without it, the library uses `localStorage`, then memory.

- By default, a stored batch stays for 24 hours or 5 attempts. Storage keeps at most 500 batches.
- The first send of a batch always counts as one attempt. After that, an offline failure and a throttle answer use no attempt. A network failure while the browser reports online uses one. A long server outage can then reach `max_attempts`.
- With `retention.maxAgeMs: null` and `retention.maxAttempts: null`, a stored batch has no age limit and no attempt limit. `retention.maxBatches` still applies.
- A full store evicts the oldest batch without an action record first. The library keeps action records longest. An action record is not an authoritative audit record.
- The store can evict the new batch. This occurs when each older batch has an action record. `onDrop` then reports the new batch with `over_capacity`.
- With `storage.backend: "memory"`, stored batches stay only until the page closes. With `storage.backend: "none"`, a batch that did not send is lost.
- After a failed send, the `transport.http_error` diagnostic tells the result for the batch. The library stores the batch, stores it in two parts, or drops it.
- A store call can throw or pass `STORAGE_DEADLINE_MS`. The library then reports `storage.degraded`. A late save can still keep the batch. Thus `onDrop` reports nothing.
- While the server throttles, the library stores a new batch and does not send it. The `transport.throttled` diagnostic tells if storage kept the batch. The retry drain also sends no stored batch to that endpoint until the throttle ends. The stored batches of the other endpoints still go out.
- Under storage pressure, a browser can delete the store. `storage.requestPersistent` asks the browser to keep it.

## Page Exit

The exit flush is best effort.

- When the page becomes hidden, the library sends the buffered records with a normal request. A send uses `keepalive` only when its body fits next to the keepalive bytes already in flight, within 60,000 bytes.
- On `pagehide` and `freeze`, the library sends payloads up to about 60 KB. To an endpoint on another origin, the request has the content type `text/plain`, which needs no CORS preflight. The batch id and the exit reason are in the query.
- With `credentials: "omit"` or `"same-origin"`, that request is a keepalive fetch with no custom header. It obeys `credentials`. Thus it sends no cookie to another origin.
- With `credentials: "include"`, that request is a beacon. `sendBeacon` always sends the cookies, whatever `credentials` is. Thus the library uses it only when the app asks for cookies.
- The answer to the `text/plain` keepalive fetch must permit the origin. If it does not, the fetch fails. A page that is still open then puts the batch in the emergency queue. The server gets that batch again at the next page load.
- It is possible that a keepalive fetch is less reliable than a beacon at page exit in some browsers. This is a hypothesis. `e2e/exit-flush.e2e.ts` shows that the `text/plain` keepalive fetch arrives after a navigation in Chromium, Firefox and WebKit. `e2e/exit-close.e2e.ts` shows that the exit batch of a tab close arrives in Chromium.
- Firefox loses the exit batch of a closed tab in some runs of `e2e/exit-close.e2e.ts`. The cause is not measured yet. Playwright's WebKit fires no `pagehide` on a tab close. Chromium fires none when the whole browser context closes. The library then has no event to start the exit flush. No test checks a slow network.
- With `headers`, it uses a keepalive fetch. Before the first call of a `headers` function, the exit flush has no header values. It then puts the batch in the emergency queue. It also uses a keepalive fetch for an endpoint on the origin of the page. That request has the content type of the serializer. For OTLP, that is `application/json`. The endpoint origin must be the same as `location.origin` and the `origin` global of the page. A sandboxed frame, a `srcdoc` frame and an `about:blank` frame send the `text/plain` request.
- A stock OpenTelemetry Collector on another origin refuses the `text/plain` batch with `415`. The exit flush does not read that answer. `onDrop` does not report that loss.
- To prevent that loss, set `headers` or put a same-origin proxy in front of the collector.
- At page exit, the library puts the queued batches, the batches in flight and the buffer of one stream into one batch. That batch can hold more than `batching.logBatchSize` records. A batch that a keepalive request already carries is not in it.
- A server that answers `413` to an exit request loses that batch. The exit flush does not read the answer, so it does not split the batch. `onDrop` does not report that loss. Accept a body of 60,000 bytes or more at the ingest server.
- With `headers`, the keepalive fetch to another origin needs a CORS preflight. It is possible that a browser cancels that request during page exit. No test in this repository checks this risk.
- A batch that does not fit goes to the emergency queue in `localStorage`. The next page load sends it. After the browser refuses a beacon, the exit flush starts no keepalive fetch in that flush. A batch that needs that fetch goes to the emergency queue. The exit flush also counts the keepalive requests of the hidden-page flush that are still in flight.
- A record that reaches the sender after `pagehide` goes out at once with an exit send. Its exit reason is `pagehide`. Examples are the final LCP, INP and CLS of the `web-vitals` package. The records of one task go in one send. The exit sends of one page leave share one byte budget. A batch that does not fit goes to the emergency queue. A `pageshow` from the back/forward cache ends this rule.
- The browser can stop a page before the flush ends. A mobile OS can stop a hidden page with no `pagehide`.
- `shutdown()` runs a normal flush, then the exit flush. It then cancels a request that is still open. A stored batch of that request stays in storage. During a pause, `shutdown()` sends nothing.
- `shutdown()` before the delivery stack loads sends nothing. `onDrop` reports the records that wait for the bus role or the delivery stack with `load_failed`.
- `shutdown()` after the delivery stack loads, but before the end of startup, sends the startup records with the last flush.
- `shutdown()` during the sender load of a `carry` rotation rejects the rotation. `onDrop` reports the carried records in memory with `security_context`. A `clearStorage` shutdown at that point also removes the stored batches of the old context.

## Shutdown With Discard

`shutdown({ pending: "discard" })` stops delivery without a send. Use it at logout or when the user withdraws consent.

- It sends nothing and runs no exit flush. The emergency queue gets no new entry.
- It stops the captures, the replay recorder, the retry engine and the pipeline. The replay recorder drops its buffer and its upload queue.
- `onDrop` reports each record in memory with `discarded`. These are the records in the hold buffers, the forward buffer, the live buffers and the queue.
- A request in flight can still reach the server. The library aborts it, but it cannot recall it. `onDrop` does not report its records.
- The result of that request writes nothing to storage and starts no retry.
- The library builds no record for the open interval of the counters, gauges, histograms and probes. It does not end the root span.
- A record that a `pagehide` during a pause reported with `disabled` is not reported again.
- The stored batches stay in storage. The next runtime with the same security context sends them. Add `clearStorage` to remove them.

`clearStorage: "context"` or `"namespace"` also removes data from storage. It always discards.

- `"context"` removes the stored batches and the emergency queue entries of the active security context. It also removes the batches that a carry during a pause left under an older context. With `securityContext.isolation: false`, it removes each batch in `storage.namespace`.
- `"namespace"` removes each stored batch and each emergency queue entry in `storage.namespace`.
- Both scopes also remove the stored session id, the tab id and the journey.
- The removal runs after each writer of the store stops. A late save cannot add a batch after it.
- With `pending: "flush"`, `clearStorage` reports `config.invalid` and discards.
- Before the first `configure()` call that works, no store is known, so `clearStorage` removes nothing.
- After a first `configure()` call with `enabled: false`, `clearStorage` opens the configured store to remove the data.
- A later `shutdown()` with `clearStorage` removes the stored data of the stopped runtime. It waits until the first `shutdown()` ends. A late save of the first flush or of its exit flush thus cannot land after the removal.
- `clearStorage: null` removes nothing.

Late async work after a discard writes no record and nothing to storage. This applies to a request result, a delivery stack load, the rotation code, a capture import and a replay upload. A rotation that already stops the old sender ends first, with its own rule. A rotation that did not reach that step stops and rejects.

A shutdown can stop a rotation after the rotation took the records of the old context. The rotation then rejects. `onDrop` reports the records that nothing keeps with `security_context`.

- With `discard` and `flush`, these are the records in memory and the stored batches that the retire removed.
- With `retain`, these are the records that waited in the runtime. The retire stored the records of the old sender.
- With `carry`, these are the records in memory. The stored batches stay in storage under the old context.

A rotation that the shutdown meets in its storage step rejects too. It does not apply the new context, so `clearStorage` removes the batches of the right context.

## Flush

`flush()` sends the records in memory and reports what became of them. [Flush result](api.md#flush-result) describes each field.

- The snapshot is the records in the buffers, the queued batches and the batches in flight at the call.
- Before startup ends, the call waits for startup first. The snapshot then also has the records that the app logs during that wait.
- A record that the app logs after the call is not in the snapshot. The call does not wait for it.
- The call waits until each record has a final state, or until `timeoutMs` passes. The default is 5000 ms.
- At the time limit, the call returns. The library does not cancel the work. A batch that ends later goes to the server or to storage, as this page tells. The result does not change.
- `accepted` counts the records of a batch that the transport accepted. A `partialSuccess` answer moves its rejected count to `dropped`.
- `stored` counts the records that storage keeps after a failed send or a throttle. The retry engine sends them later.
- `dropped` counts the records that the call lost. `onDrop` reports each one, with three exceptions. A batch with no destination only counts `record.dropped_no_destination`. A forwarder with no owner drops its records with no `onDrop` report. It reports `bus.no_owner` one time at startup. A forwarder drops a record that is larger than `bus.maxMessageBytes`. It only counts `bus.rejected_message`.
- `pending` counts the records that have no final state at the end of the wait. A store that throws or passes `STORAGE_DEADLINE_MS` counts here, because a late save can still complete.
- When storage keeps only one half of a split batch, `stored` counts that half and `dropped` counts the other half.
- During a rotation, the records of the old context wait for the `pending` rule of the rotation. They count as `pending`.
- `shutdown({ pending: "discard" })` during the call counts the queued batches as `dropped`. A request in flight stays `pending`, because it can still reach the server.

These are not in the snapshot:

- The batches in storage from earlier failures. The call starts no drain. `getHealth().delivery.stored` counts them.
- The replay segments. The replay uploader sends them on its own.
- The exit flush.

In a forwarder, the call gives the forward buffer to the sender. Then it sends a flush request to the sender. A link keeps the order of its messages. The records are thus in the snapshot of the sender before the sender reads the request. The sender runs its own flush with 90 percent of the time that is left. The rest of the time is for the answer. Its counts cover all records in its snapshot, also the records of other contexts. The answer is information only. A false answer can change the counts, but it cannot change the delivery.

`shutdown()`, a rotation and the exit flush keep their own rules. The normal flush of `shutdown()` has no time limit of its own. The request deadline limits each send. A rotation with `pending: "flush"` uses its own `timeoutMs`.

## Rotation

`rotateSecurityContext()` changes the delivery identity. Its `pending` rule decides what happens to the records of the old identity:

- `discard`, the default, removes them. `onDrop` reports them with `security_context`. This includes the exit batches of the old identity that another tab put in the emergency queue.
- `flush` tries one send with the old settings.
- `retain` keeps them in storage under the old identity.
- `carry` moves them to the new identity.

On a hidden page, a batch can be in an open `keepalive` request. A rotation or a failed rotation stops that request. The `pending` rule then also applies to that batch. A failed rotation stores it under the old identity. The exit flush never sends that batch two times.

During a rotation, the library drops logger calls, metric measurements and forwarded records. `onDrop` reports the forwarded records and the records that the library built during the rotation with `security_context`. The library does not hold such a record for the next identity. The one exception is the diagnostic record of the rotation's check of the next settings. The library writes that record after the rotation, to the new identity. A forwarder clears its buffered records when its owner changes identity. Rotations run in call order. Each call waits for the earlier call.

A rotation that rejects stops the delivery of the old identity. A rotation code chunk that does not load also rejects the rotation. The library keeps the unsent records of the old identity in storage under the old ID. `getHealth().delivery.stored` still counts them. It sends no record with the old endpoint or headers until a rotation succeeds. `onDrop` reports each dropped record with `security_context`. The next rotation that succeeds applies its `pending` rule to the stored records and the emergency queue of the old identity. With `flush`, it removes them as `discard` does, because a flush would use the old settings. See [runtime policies](runtime-policies.md) for each rule.

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

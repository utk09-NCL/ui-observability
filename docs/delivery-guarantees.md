# Delivery Guarantees

This page tells what the library promises about delivery. It lists each case where a record can be lost or can arrive more than one time.

## Summary

- The library tries to deliver each record at least one time. It stores a batch that did not send, and sends it again.
- The library can lose records in the cases that this page lists. `onDrop` reports each loss of a record that the library built.
- The server can get one batch more than one time. Deduplicate by batch ID.
- The library does not keep the order of batches. Order records by their time and by `log.seq`.

## Accepted Batches

A batch is delivered when the server answers `2xx`. A custom transport gives the same result when it returns a `2xx` status. A beacon of the exit flush gets no answer. The library counts it as sent when the browser accepts the beacon.

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

## Order

- In one batch, the records of one resource and one logger namespace keep their order.
- Batches can arrive in any order. Up to `delivery.maxConcurrentRequests` requests run at the same time. A stored batch goes later than newer live batches.
- Logs, metrics and spans go in separate batches. They can go to separate endpoints.
- Use `timeUnixNano` to order records. In one context, `log.seq` gives the order of the records. `uiobs.clock_offset_ms` gives the difference between the clock of the device and the clock of the server.

## Losses

`onDrop` receives a summary of each loss. The `reason` field tells the cause.

| `reason`           | Cause                                                                                 | Setting to change                               |
| ------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `buffer_full`      | A hold buffer before startup, or the live buffer, is full.                            | `buffering`                                     |
| `expired`          | A stored batch is older than `retention.maxAgeMs`.                                    | `retention.maxAgeMs`, `retention.mode`          |
| `over_capacity`    | Storage has `retention.maxBatches` batches. A new batch evicts an old batch.          | `retention.maxBatches`                          |
| `quota`            | The browser storage quota is full.                                                    | A lower `retention.maxBatches`                  |
| `max_attempts`     | A stored batch reached `retention.maxAttempts`.                                       | `retention.maxAttempts`, `retention.mode`       |
| `rejected`         | The server refused the batch permanently, or one record is too large for the server.  | The ingest server, `limits`                     |
| `unserializable`   | The serializer threw an error on the batch.                                           | A custom `serializer`                           |
| `exit_queue_full`  | The emergency queue in `localStorage` is full. It drops its oldest batch.             | None                                            |
| `load_failed`      | The delivery code did not load, or `shutdown()` came first.                           | None                                            |
| `not_stored`       | Storage did not keep a batch after a failed send, for example with `storage: "none"`. | `storage`                                       |
| `security_context` | A change of the delivery identity removed the records of the old identity.            | The `pending` rule of `rotateSecurityContext()` |

Some records never reach delivery by design. `onDrop` does not report them. The diagnostic codes in `getDiagnosticCounters()` show these cases:

- A record below `minLevel`, or outside the sample.
- A record that a processor or `redact` drops.
- A record above the error ceiling, `capturePolicy.errorCeiling`.
- A capture event above its rate limit.
- A logger call during a rotation.
- A bus message that a budget refuses, and the records of a forwarder that has no owner.

## Retention

A batch that did not send goes to storage. The default store is IndexedDB. Without it, the library uses `localStorage`, then memory.

- With `retention.mode: "limited"`, the default, a stored batch stays for 24 hours or 5 attempts. Storage keeps at most 500 batches.
- With `retention.mode: "until-delivered"`, a stored batch has no age limit and no attempt limit. `retention.maxBatches` still applies.
- A full store evicts the oldest batch without an action record first. An action is an audit fact.
- With `storage: "memory"`, stored batches stay only until the page closes. With `storage: "none"`, a batch that did not send is lost.
- Under storage pressure, a browser can delete the store. `persistence.requestPersistent` asks the browser to keep it.

## Page Exit

The exit flush is best effort.

- When the page becomes hidden, the library sends the buffered records with a normal request. A send of 60 KB or less uses `keepalive`.
- On `pagehide` and `freeze`, the library uses `sendBeacon` for payloads up to about 60 KB. With `headers`, it uses a keepalive fetch.
- A batch that does not fit goes to the emergency queue in `localStorage`. The next page load sends it.
- The browser can stop a page before the flush ends. A mobile OS can stop a hidden page with no `pagehide`.

## Rotation

`rotateSecurityContext()` changes the delivery identity. Its `pending` rule decides what happens to the records of the old identity:

- `discard`, the default, removes them. `onDrop` reports them with `security_context`.
- `flush` tries one send with the old settings.
- `retain` keeps them in storage under the old identity.
- `carry` moves them to the new identity.

During a rotation, the library drops logger calls, metric measurements and forwarded records. A forwarder clears its buffered records when its owner changes identity. See [runtime policies](runtime-policies.md) for each rule.

# Architecture and Lifecycle

This page tells how a record moves from a logger call to the network. It names the module that owns each step, each buffer and each state change.

The section [Core Architecture](#core-architecture) is a summary for an application developer. The other sections are for a person who maintains the library. The README and the playground guides are for the application developer.

Each fact on this page describes the code of version 1.0.0. Search by symbol name. Line numbers move.

## Core Architecture

`README.md` links to this section. Before version 1.0.0, this section was in `README.md`.

- **Code splitting:** The main chunk holds the logger, the record builder and the console sink. The delivery stack loads only when you set an endpoint or a transport. The bus loads only when the context needs it. Each capture module loads only when you enable it. The rotation code loads on the first `rotateSecurityContext()` call.
- **Document singleton:** The library keeps the runtime at `globalThis[Symbol.for("ui-observability.runtime")]`. Federated microfrontends and separate bundles share one buffer, one sequence and one transport.
- **One sender:** Iframes, workers and OpenFin views find the nearest long-lived context. They forward their records to it over the bus. That context batches, stores and sends for all of them. By default, a parent accepts only the frames and workers that it registers with `registerFrame()` and `registerWorker()`. A frame that knows its owner relays the records of its own children.
- **One sender for each tab:** Each top-level tab or window has its own sender. Two tabs of one origin send their records separately. They have the same `session.id` and a different `tab.id`. A retry of stored batches runs in one tab at a time, under a Web Lock for each storage namespace.
- **Five correlation ids:** Each record carries `session.id`, `tab.id`, `context.id`, `journey.id` and `trace_id`.
- **Durability and exit flush:** The library stores a batch that fails to send, in IndexedDB or localStorage. It sends the batch again with exponential backoff and jitter. [Retention](delivery-guarantees.md#retention), [Page Exit](delivery-guarantees.md#page-exit) and [Losses](delivery-guarantees.md#losses) give the rules of storage, of the exit flush and of the hold buffers. `onDrop` tells the app about each loss.
- **Server (Node):** On Node, for example during server-side rendering, the library runs console-only. It installs no capture, keeps the ids in memory, uses no storage and has no exit flush. If you set `endpoint`, `metricsEndpoint`, `tracesEndpoint`, `transport` or `transportWorker`, it reports `config.invalid` one time.
- **One library version on a page:** If a copy of another version owns the page runtime, this copy runs console-only. It installs no capture and reports `runtime.version_mismatch`. Load one version of the library on the page.
- **Emergency queue:** The emergency queue is best effort. With `storage.backend` `"memory"` or `"none"`, the exit flush does not use it. A batch that it cannot send is then lost, and `onDrop` reports `not_stored`. It writes to `localStorage` synchronously, because no other storage works while the page unloads. If the browser refuses the write, the library reports `storage.quota_exceeded`. The library then loses the batch.
- **Configuration after startup:** A second `configure()` call merges accepted options into an unlocked live runtime. [Settings that are fixed after startup](production-recipes.md#settings-that-are-fixed-after-startup) gives each setting that it refuses, and the isolation rule. [`configure()` on a live runtime](#configure-on-a-live-runtime) names the function that keeps each one.
- **Deterministic sampling:** FNV-1a hashing applies one keep rate to a whole journey. Sampling always keeps an explicit action and each record at or above `sampling.alwaysSampleFrom`, default `"ERROR"`.

## Record path

```text
logger call                        src/index.ts, src/core/logger.ts
  |  payloadMode "defer" only      src/core/deferred.ts (deferred queue)
  v
RecordBuilder.build()              src/core/record.ts
  |  sampling, sanitize, fixed fields, processors, redact, size cut
  v
OneLogger.print()                  src/core/logger.ts (console copy, after the hooks)
  v
ObservabilityRuntime.emit()        src/core/runtime.ts
  |  boot buffer until startup completes
  |
  +-- forwarder role: forward buffer -> Bus.sendRecords()      src/bus/bus.ts
  |        the sender context then runs ingestForwarded()      src/core/runtime.ts
  |
  +-- sender role: Sender.push()                               src/core/sender.ts
           |  pendingRecords while the delivery stack loads
           v
      LogPipeline                                              src/core/pipeline.ts
           |  admit, stream buffer, batch, queue, dispatch
           v
      transport.send()                                         src/transport/
           |  2xx: the batch is complete
           |  throttle or failure: ContextStorage.save()       src/storage/
           v
      RetryEngine drain -> transport.send()                    src/transport/retry-engine.ts

document closes: ExitFlush.flush()                             src/transport/exit-flush.ts
      beacon, keepalive fetch, or emergency queue              src/storage/emergency-queue.ts
```

| Step | Module | What the step does |
| --- | --- | --- |
| Entry | `src/index.ts` | `requireRuntime()` gives the current runtime or the stopped runtime. With neither, it makes an unconfigured runtime. |
| Logger | `src/core/logger.ts` | `OneLogger` refuses a call after `shutdown()`. During a rotation it counts `record.dropped_during_rotation`. |
| Deferred queue | `src/core/deferred.ts` | With `payloadMode: "defer"`, `deferWrite()` holds the call and builds the record later. |
| Builder | `src/core/record.ts` | `RecordBuilder.build()` samples, sanitizes, adds the fixed fields, runs the hooks and applies `limits.maxRecordBytes`. |
| Console copy | `src/core/logger.ts` | `print()` writes the console line. With a hook, the line shows only the result of the hooks. |
| Routing | `src/core/runtime.ts` | `emit()` holds a record in the boot buffer until `ready`. Then `route()` selects `forward()` or `deliver()`. |
| Delivery stack | `src/core/sender.ts` | `Sender.create()` builds storage, transport, retry engine, pipeline and exit flush. The runtime loads it with a dynamic import. |
| Pipeline | `src/core/pipeline.ts` | `push()` sets `observedTimeUnixNano`. `admit()` applies the buffer limits. `claim()` makes one batch for each stream. |
| Dispatch | `src/core/pipeline.ts` | `pump()` starts on a microtask. It obeys `delivery.maxConcurrentRequests`. `dispatch()` sends, or stores the batch. |
| Transport | `src/transport/status-transport.ts` | The base class holds the status rules, the throttle state and the cancellation signal. |
| Transport types | `src/transport/http-transport.ts`, `custom-transport.ts`, `worker-transport.ts` | `Sender.create()` selects one. A custom transport comes first, then a transport worker, then HTTP. |
| Storage | `src/storage/context-storage.ts`, `src/storage/factory.ts` | `ContextStorage` limits the adapter to one delivery context. `createStorage()` selects IndexedDB, localStorage or memory. |
| Retry engine | `src/transport/retry-engine.ts` | `drain()` runs under the drain lock of `src/utils/lock.ts`. It sends stored batches with backoff and full jitter. |
| Exit flush | `src/transport/exit-flush.ts` | `flush()` runs in an unload listener. It never awaits. |

More facts about the path.

- A metric point and a span use the same path. `emitPoint()` and `recordSpan()` in `src/core/runtime.ts` call `builder.build()` and then `emit()`.
- The pipeline has three streams, `logs`, `metrics` and `traces`. `streamOf()` reads `log.type` to select one. A batch has records of one stream only.
- A throttled transport does not get the batch. `dispatch()` stores the batch and does not change `attempts`.
- `store()` returns `stored`, `not_stored` or `unknown`. `dispatch()` selects the text of `transport.throttled` from that result.
- A failed send gives the batch to `RetryEngine.storeFailed()` with `attempts + 1`.
- `RetryEngine.storeFailed()` returns the result, which is `stored`, `split`, `rejected` or `not_stored`, and the count of records that storage holds. `dispatch()` reports that result with `transport.http_error`.
- The result is `unknown` when a storage call throws or does not settle in `STORAGE_DEADLINE_MS`. The report then says that the library could not confirm the store. A late save can still complete. The retry engine then sends the batch in a later drain.
- `StorageAdapter.save()` returns `true` only when the batch is in storage at the end of the save. A save prunes after its write, and the prune can remove the new batch. After a quota error, `LocalStorageStorage` and `IndexedDbStorage` evict old batches and write again. That second write runs no prune.
- `store()`, `storeFailed()` and the `persist` rule call `nudge()` only when storage kept a batch.
- The retry engine has one timer. Each schedule path calls `schedule()`, which clears the timer first.
- A `hidden` document gets a normal flush through `LogPipeline.flushPending()`. The other exit reasons call `LogPipeline.drainForExit()`.
- An exit batch above `BEACON_LIMIT_BYTES` goes to the emergency queue. The next page load moves it to storage in `Sender.importEmergency()`.
- The public `flush()` calls `ObservabilityRuntime.flush()`. In a sender, it calls `Sender.flushUntil()` and then `LogPipeline.flushUntil()`. That claims the stream buffers and keeps the open batches as the snapshot. `run()` writes the end of each batch to its `Pending` entry, and the call adds the ends up when its wait ends.
- In a forwarder, `flush()` gives the forward buffer to `Bus.sendRecords()`. Then `Bus.requestFlush()` posts `ui-observability.message.flush-request` on the upstream link. The sender's bus calls the runtime's `flushFor()` and answers with `ui-observability.message.flush-result`.
- `shutdown()`, `Sender.retire()` and the hidden-page flush still call `LogPipeline.flushPending()`. It has no deadline of its own and returns no counts.

The delivery promises are in [Delivery Guarantees](delivery-guarantees.md). Change that page with each change to this path.

## Privacy boundary

The three rules below have no exception.

### `redact` is the last privacy gate

| Where | Enforcement |
| --- | --- |
| `RecordBuilder.build()` in `src/core/record.ts` | The hook list is `config.processors` first, then `config.redact`. `applyHooks()` sanitizes the record again after the hooks. |
| `RecordBuilder.build()` | The size cut reads `page.url`, `journey.id` and `journey.name` after `redact` (`REDACTABLE_INDEX_KEYS`). |
| `OneLogger.print()` in `src/core/logger.ts` | With a hook, the console gets the built record. A record that a hook drops prints nothing. |
| `ObservabilityRuntime.releaseBootBuffer()` | It adds the journey keys to a held record only when the config has no hook. |
| `ObservabilityRuntime.reconfigure()` | A change of `redact` or `processors` clears the debug buffer. A kept record saw only the old hooks. |
| `ObservabilityRuntime.ingestForwarded()` | It reports a loss to `onDrop` only after sampling and `redact`. |

A new record path must run `processors`, then `redact`, before a callback, the console or the network gets the record.

### A server can never change a privacy setting

| Where | Enforcement |
| --- | --- |
| `parseRemoteRules()` in `src/core/remote-rules.ts` | A remote `capture` object can have only the keys of `REMOTE_CAPTURE_FLAGS`. Each value must be a boolean. Any other key refuses the rules. |
| `REMOTE_CAPTURE_FLAGS` in `src/constants.ts` | The list has capture switches only. It has no `redact`, `fullUrls`, `ignoreUrls` or replay mask key. |
| `effectiveCapture()` in `src/core/runtime.ts` | A remote switch applies only when the application names the key in `capture.remoteToggles`. A remote `true` does not replace an object setting. |
| `RemoteSlot` in `src/core/remote-sampling.ts` | The remote rules stay in the slot. The code never writes them into the config. |
| `Bus` in `src/bus/bus.ts` | The bus accepts sampling rules only from the upstream owner. An origin outside `bus.trustedOrigins` reports `bus.untrusted_origin`. |

Do not add a privacy key to `REMOTE_CAPTURE_FLAGS`.

### A forwarded record keeps the redact result of the sender

A forwarder builds its records with its own hooks. The sender context then applies its own `redact` in `ingestForwarded()`, through `RecordBuilder.redactForwarded()`.

- `fixedOf()` in `src/core/record.ts` restores a field group after `redact` only when each value has the shape that the library writes.
- `groupsOf()` selects a group only for a metric record of `uiobs.metrics` or a span record of `uiobs.traces`.
- `metric.name`, `metric.unit` and `metric.attribute_keys` are not in a group. The `redact` of the sender controls them.
- With no `redact` in the sender, `redactForwarded()` returns the record with no change.

The residual risks of this path are in [Threat Model](threat-model.md), section "Other Documents (the Bus)".

## Buffer ownership

`onDrop` reasons are in [Delivery Guarantees, Losses](delivery-guarantees.md#losses). The table below names the owner of each buffer.

### In-memory buffers

| Buffer | Owner | Limit | Who drops a record |
| --- | --- | --- | --- |
| Deferred queue | `src/core/deferred.ts`, one queue for each runtime | `buffering.maxPendingRecords`, at most `DEFER_QUEUE_LIMIT` | `deferWrite()` counts `record.dropped_by_ceiling` when the queue stays full. `cancelDeferred()` clears it at shutdown. |
| Debug buffer | `DebugBuffer` in `src/core/debug-buffer.ts`, held by the runtime | `debugBuffer.maxRecords`, `debugBuffer.maxAgeMs` | The buffer trims itself. `resetSession()` and a hook change clear it. |
| Boot buffer | `bootBuffer` in `src/core/runtime.ts`, a `HoldBuffer` | `buffering.maxHeldRecords` and `BUS_MAX_BOOT_BUFFER_ACTIONS` | `HoldBuffer.push()` keeps the head of each kind and drops the oldest record after it. `dropHeld()` reports `buffer_full`. A shutdown before the end of startup reports `load_failed`. A discard reports `discarded`. |
| Pending records | `pendingRecords` in `src/core/runtime.ts`, a `HoldBuffer` | Same as the boot buffer | `dropHeld()` reports `buffer_full`. A failed load or a shutdown before the load reports `load_failed`. A discard reports `discarded`. |
| Forward buffer | `forwardBuffer` in `src/core/runtime.ts` | None. It lives for one microtask. | `sendForwarded()` gives it to the bus. |
| Stream buffers | `RecordStream` in `src/core/pipeline.ts` | `buffering.maxPendingRecords`, `buffering.maxPendingBytes` | `LogPipeline.admit()` and `evict()` report `buffer_full`. |
| Batch queue | `queue` and `open` in `LogPipeline` | Same budget as the stream buffers | `evict()` removes the oldest queued batch first. `destroy()` clears the queue. |
| Unconfirmed batches | `unconfirmed` in `LogPipeline` | Same budget | It holds a batch until the send ends or a keepalive request starts. `drainForExit()` copies its records into the exit batches. |
| Replay buffer | `ReplayBuffer` in `src/capture/replay-buffer.ts` | `replay.maxBufferBytes` | The buffer drops its oldest part. `resetSession()` clears it through `replay.reset()`. |
| Drop summaries | `DropReporter` in `src/core/drops.ts` | `DROP_SUMMARY_MAX_ITEMS` for each list | It sends each summary to `onDrop` on a microtask. |

Rules for the pipeline budget.

- `admit()` encodes each record one time to count its bytes. A record that JSON cannot encode reports `unserializable`.
- `buffering.overflow` selects the rule for a full buffer. `drop-oldest` calls `evict()`. `persist` stores the new record as a batch of one record.
- `evict()` cannot remove a request that the transport has. Only records before the transport can go.
- The error ceiling in `LogPipeline.route()` drops a log record and counts `record.dropped_by_ceiling`. It does not call `onDrop`.

### Stored batches

A stored batch belongs to the storage adapter. The pipeline, the retry engine and the sender use the adapter through `ContextStorage`.

| Who removes a stored batch | When | Report |
| --- | --- | --- |
| The adapter, in `prune()` | The batch is older than `retention.maxAgeMs`, or the store has more than `retention.maxBatches` batches | `expired` or `over_capacity` through `onGap` |
| The adapter, in `save()` | The browser refuses the write, or the adapter keeps nothing | `quota` or `not_stored` through `onGap` |
| `RetryEngine.deliver()` | The server accepts the batch | None. It is not a loss. |
| `RetryEngine.deliver()` | `attempts` reaches `retention.maxAttempts` | `max_attempts` and `storage.dead_lettered` |
| `RetryEngine.toStorable()` | A permanent refusal, or a 413 for a batch of one record | `rejected` |
| `Sender.retire()` | A rotation with `pending` set to `discard` or `flush` | `security_context`, from `rotateContext()` in `src/core/rotation.ts` |
| `clearStored()` | The application calls `shutdown()` with `clearStorage` | See "Open items" |

- `src/storage/eviction.ts` selects the batches to evict. A batch with no action record goes first.
- `reportGap()` in `src/core/runtime.ts` receives each `onGap` call. It reports to `onDrop` and writes one throttled warning record.
- `RetryEngine.deliver()` runs only inside `drainLocked()`. With the Web Locks API, one window drains a namespace at a time. Without that API, the drain runs with no lock.
- A throttle answer does not change the `attempts` of a stored batch.

### Emergency queue

`src/storage/emergency-queue.ts` owns a synchronous `localStorage` queue. `ExitFlush.park()` is the only writer. The queue keeps `EMERGENCY_MAX_ENTRIES` entries and drops the oldest with `exit_queue_full`. `drainEmergencyQueue()` moves the entries to storage at the next `Sender.create()`. `clearEmergencyContext()` removes them at a rotation that discards, and at `shutdown()` with `clearStorage`.

## State transitions of the runtime

The runtime keeps its state in flags of `ObservabilityRuntime` in `src/core/runtime.ts`.

| Flag | Meaning |
| --- | --- |
| `tunablesLocked` | False until the first `configure()` call that works. That call sets it. |
| `startFailed` | The first `configure()` call failed. The runtime refuses each record and stays unconfigured. |
| `running` | `start()` ran. It runs at the first configured state with `enabled: true`. |
| `roleResolved` | Startup has decided the bus role. The delivery stack loads after this. |
| `ready` | Startup is complete. `emit()` stops using the boot buffer. |
| `rotating` | A security-context rotation is in progress. |
| `closingContext` | The rotation collects the last records of the old context. `emit()` accepts them. |
| `destroyed` | `shutdown()` stopped the runtime. |
| `degraded` | The runtime is console-only. It is on Node, or another version owns the page runtime. |

| Transition | Entry point | What changes |
| --- | --- | --- |
| Implicit start | `requireRuntime()` in `src/index.ts` calls `ObservabilityRuntime.configure({}, true)` | A new unconfigured runtime with the defaults. The runtime goes on the global key. Nothing starts. |
| Explicit start | `configure()` with no live runtime | A new runtime with the config of the application. `launch()` runs. The stopped-runtime key is deleted. |
| Launch | `launch()`, from the explicit start or from `reconfigure()` | `tunablesLocked` becomes true. With `enabled: true`, `start()` runs. Otherwise the held records go to `onDrop` with `disabled`. |
| Start | `start()`, then `init()` and `boot()` | Storage ids, `rehookHeld()`, the start gate, then journey bootstrap, the bus, `syncSender()`, `ready` and `releaseBootBuffer()`. |
| Failed start | The catch in `ObservabilityRuntime.configure()` calls `refuse()` | `startFailed` is true. `redact` is `REFUSE_RECORDS`. The held records are dropped. The runtime stays unconfigured. |
| Pause | `reconfigure()` with `enabled: false` on a running runtime | `collectPoints()` runs first. `installCaptures()` removes every capture. `Sender.hold(true)` stops the pipeline, the retry engine and the exit flush. `deliver()` puts a record in `pendingRecords`. |
| Console-only start | `startDegraded()` | Another version owns the page runtime. A local runtime starts and stays off the global key. It reports `runtime.version_mismatch`. |
| Reconfigure | `configure()` with a live runtime calls `reconfigure()` | The config changes in place through `applyResolvedConfig()`. It reports `config.reconfigured`. |
| Shutdown | `shutdown(options?)` calls `destroy()` on the current runtime | `destroyed` is true. `flushHeld()` or `discardHeld()` runs. `clearStorage()` runs after each store writer stops. The runtime moves to the stopped-runtime key. |
| Rotation | `rotateSecurityContext()` | A new `securityContext.id`, new routing settings, a new delivery stack and a new session. |
| New session | `newSession()` | A new `session.id`. The delivery stack and its buffers do not change. |

### Unconfigured runtime

- A logger call, `getHealth()`, `flush()` and most other functions call `requireRuntime()`. Each one can make the unconfigured runtime.
- `shutdown()` does not make a runtime. It reads `ObservabilityRuntime.current()`, then `ObservabilityRuntime.stopped()`.
- The unconfigured runtime keeps its ids in `memoryStores()`. `start()` changes `backing` to `BROWSER_STORES` for `identity: "storage"`, and reads the ids again.
- `emit()` holds each record in the boot buffer, because `ready` is false.
- `installCaptures()` and `syncSender()` do nothing before `running`. `buildBus()` waits for `startGate`, so `registerFrame()` and `registerWorker()` attach at the start.
- The first `configure()` call that works sets each startup-fixed key. `keepStartupTunables()`, `keepBuiltIdentity()` and the loop for `correlation` and `storage` accept the new values while `tunablesLocked` is false.
- `start()` calls `RecordBuilder.rehook()` on each held record. That function applies the configured level, sampling, body limit and `page.url` rule. It puts on the configured resource, runs `processors` and `redact`, then applies `limits.maxRecordBytes` through `fit()`, as `build()` does.
- `start()` removes the breadcrumbs of log calls. It keeps a session that `newSession()` chose before the start.
- `rotateSecurityContext()` rejects while `tunablesLocked` is false.
- `boot()` never rejects. A startup fault reports `pipeline.crashed`, and `ready` still becomes true.

### `configure()` on a live runtime

`reconfigure()` refuses the full call in two cases. Each case reports `config.locked`.

- A rotation is in progress.
- `lockConfiguration` is true and the new config is different.

A fixed key keeps its value and reports `config.invalid`. The other keys of the same call still apply.

| Key | Function that keeps it |
| --- | --- |
| `correlation`, `storage` | The loop in `reconfigure()`, after `tunablesLocked` is true. |
| `limits`, `journey.maxAgeMs`, `profiler.maxProbes`, `bus.mode`, `bus.openFinRole`, `otelLoader` | `keepStartupTunables()` |
| `batching`, `retention`, after the delivery stack starts to load | `keepStartupTunables()` with `SENDER_SECTIONS` |
| `identity` | `keepBuiltIdentity()` |
| Addition or removal of `transport` or `transportWorker`, removal of `endpoint`, after the load starts | `keepDestination()` |
| The keys of `ROUTING_KEYS` and `securityContext.id`, with `securityContext.isolation` | `keepRouting()` |

Do not write to `this.config` directly. Use `applyResolvedConfig()`.

### Shutdown

`destroy()` does these steps in order. `shutdownRule()` reads the options first. `pending: "discard"` or a `clearStorage` scope selects the discard path.

1. With the flush path, it drains the deferred queue, collects the metric points and ends the root span. The discard path builds none of them.
2. It sets `destroyed`, removes its `pagehide` listener and uninstalls the captures.
3. With the flush path, `flushHeld()` runs. During a pause, it reports the records in the memory of the sender with `disabled`. It starts `Sender.destroy()`, which runs a normal flush, then the exit flush with the reason `shutdown`. A held sender runs neither. With a loaded sender, it first gives the boot buffer to that sender. It gives the forward buffer to the bus. It reports the remaining boot buffer and pending records as `load_failed`, because a stopped runtime loads no sender.
4. With the discard path, `discardHeld()` runs. It takes the hold buffers and the forward buffer, and clears the breadcrumbs, the context, the debug buffer and the active journey. `Sender.discard()` stops the sender with no send, and returns the records of its buffers and its queue. They go to `onDrop` with `discarded`.
5. It stops the journey engine and the bus.
6. It waits for the sender, for a load in progress, for a rotation in progress and for a parked sender.
7. It moves the runtime to the stopped-runtime key.
8. With a `clearStorage` scope, `clearStorage()` calls `clearStored()`. It removes the stored ids, the batches, the emergency entries and the carried batches.

`destroy()` keeps the promise of the first call in `stopping`. A later call does not stop again. It waits for that promise, then applies its own `clearStorage` scope. After step 2, the identity stores are memory stores, so a journey call on the stopped runtime writes no browser store.

After shutdown, each call goes to the stopped runtime and records nothing. The next `configure()` builds a new runtime.

### Security-context rotation

`rotateSecurityContext()` in `src/core/runtime.ts` rejects after shutdown. It sets `rotating` at once. Each call waits for the earlier call in the `rotation` promise chain. The first call also waits, so it starts on a later microtask. `runRotation()` waits for startup and rejects in a forwarder. That rejection is a usage error, and the delivery of the forwarder stays open.

`runRotation()` then loads `src/core/rotation.ts` with a dynamic import. The module is a separate chunk, so the main graph does not carry it. If the import fails, the runtime reports `pipeline.crashed`, calls `closeDelivery()` and rejects.

`rotateContext()` in `src/core/rotation.ts` runs the rotation. It changes the private state of the runtime only through the `RotationHost` from `rotationHost()`. `planRotation()` first waits for a delivery stack load in progress. It rejects for invalid options, for an unchanged id, and for a routing value that it cannot apply. Each rejection calls `closeDelivery()`. `closeDelivery()` sets `deliveryClosed`, stops the old sender with `Sender.pause()` and keeps it as `parkedSender`. A load that ends later parks its own sender, because `buildSender()` checks `deliveryClosed`. Each later record goes to `onDrop` with `security_context` until a rotation succeeds. That rotation retires `parkedSender` with its own `pending` rule, and `flush` becomes `discard`.

1. `rotating` becomes true at the call. `runRotation()` waits for startup, and `planRotation()` waits for the delivery stack load.
2. `routingOf()` puts the routing keys of the update over `ROUTING_RESET`. It reports each other key and leaves it out. `planRotation()` resolves the next config on a base with no old routing values. `unapplied()` compares each routing value with the resolved value.
3. Under `closingContext`, it collects the metric points, ends the root span and ends the journey.
4. It takes the boot buffer, the pending records and the forward buffer.
5. `Sender.retire()` stops the old exit flush, retry engine, transport and pipeline. It applies the `pending` rule.
6. With `discard` or `flush`, the runtime reports the old records as `security_context`.
7. It applies the next config. `advanceIdentity()` clears the remote rules and refreshes the captures. Then it clears the context and the breadcrumbs.
8. It calls `newSession()`, then `syncSender()`, then `Bus.rotateContext()`.
9. `rotating` becomes false, unless a later call waits. With `carry`, `Sender.adopt()` stores the old batches under the new id.
10. It reports `security.rotated`.

During a pause, `Sender.retire()` skips the flush, so a rotation with `pending: "flush"` acts as `discard`. With `carry`, the rotation routes the live records to `pendingRecords`, and `adopt` keeps the stored batches in `carried`. `buildSender()` adopts them at `enabled: true`. A later rotation takes `carried` back through `takeOld()` and applies its own `pending` rule. With no old sender, `rotateContext()` reaches storage through `src/storage/stored-context.ts`. For `discard` and `flush`, `clearStored()` removes the stored batches of the old context and the carried batches by id. For `retain`, `keepStored()` stores the held records and the carried batches under the old context. `shutdown()` with `clearStorage` uses the same module, through `clearStorage()` in `src/core/runtime.ts`.

While `rotating` is true, a logger call counts `record.dropped_during_rotation`. The one exception is a diagnostic record from the plan step of the rotation, which checks the next context's settings. The runtime holds that record. `openDelivery()` opens the new context, and `endRotation()` then writes the record. A failed, stopped or queued rotation drops it and counts it. `emit()` drops each built record at once and reports it to `onDrop` with `security_context`. Only a record under `closingContext` passes. A forwarded record reports `security_context`. A `configure()` call reports `config.locked`.

The `pending` rules are in [Runtime policies, Security context rotation](runtime-policies.md#security-context-rotation). The default is `discard`. The default `timeoutMs` is 5000.

### New session

`newSession()` calls `resetSession()` with a new id. `resetSession()` does these steps in order.

1. It collects the metric points, so the old points keep the old `session.id`.
2. It starts a new trace with `tracing.rotate("explicit")` and ends the journey.
3. It clears the breadcrumbs and the debug buffer, and resets the replay buffer.
4. It sets `identity.sessionId`, restarts the session touch and calls `builder.invalidateResource()`.

`newSession()` does nothing after shutdown.

## Cancellation rules

### Request deadline

`delivery.requestTimeoutMs` is the deadline of one send. Its default is `REQUEST_TIMEOUT_MS`, 15000 ms.

- `HttpTransport.attempt()` calculates one `deadline` at the start. The header function, the body encoding, the `fetch` and the body read share it.
- `before()` waits for a step with `withDeadline(this.untilCancelled(work), remaining)`.
- `dispatch()` makes one `AbortController` for the request. A timer aborts it at the deadline. The `fetch` and `readOptionalBody()` get its signal.
- The body read runs before the `finally` block that clears the timer and the stop listener. A stalled body cannot hold a dispatch slot after the deadline or after a stop.
- `withDeadline()` in `src/utils/deadline.ts` rejects with `DeadlineError`. It does not stop the work. Use an `AbortController` when the work must stop.
- A storage call has the deadline `STORAGE_DEADLINE_MS` in `LogPipeline.store()` and in `RetryEngine.bounded()`.

### Stop listener

`StatusTransport` has one `AbortController` for its delivery context, the field `cancellation`. `stop()` aborts it.

- `Sender.destroy()` and `Sender.retire()` call `transport.stop()`.
- Each request adds an `abort` listener to `cancellation.signal` and removes it in `finally`. No listener stays after the request.
- `untilCancelled()` ends a wait when the context stops.
- `assertContext()` runs after each asynchronous step and before a send. It throws when the context stopped. With isolation, it also throws when `routingContextId` is not the current context id.
- A stop gives a `TransportError` of the kind `permanent`. A deadline gives the kind `timeout`. `dispatch()` checks the stop first.
- After a stop, `LogPipeline.dispatch()` does not store the batch, and `RetryEngine.deliver()` returns `stop`.
- A custom transport gets the same signal in its request (`request.signal` in `src/transport/custom-transport.ts`).

### Worker reply grace

The worker transport has two timers for one job. They are in different contexts.

- `attempt()` in `src/transport/worker-transport.ts` sends the job with `timeoutMs` and `deadlineMs`.
- `run()` in `src/transport/worker-server.ts` applies that deadline in the worker with `withDeadline()`.
- `deliver()` gives the status to `onAnswer` before the body read. At the deadline, `run()` replies with that status, not with a timeout.
- `createWorkerClient()` in `src/transport/worker-client.ts` waits `timeoutMs`, then `WORKER_REPLY_GRACE_MS` more, for a ready worker. Then it cancels the job as a timeout.
- A worker that is not ready at `timeoutMs` gets no grace. The client rejects its jobs with a `channel` fault. The transport then sends the batch over HTTP.

`WORKER_REPLY_GRACE_MS` is 1000 ms in `src/constants.ts`.

### The timeout of the caller must be longer than the deadline of the callee

The callee is the code nearest to the network. It knows if the server answered before the deadline. Its reply needs time to come back to the caller.

If the two timers have the same length, the timer of the caller can fire first. An accepted batch then looks like a timeout. The pipeline stores the batch, and the retry engine sends it again. The server then gets the same batch id two times.

Apply the rule to each new wait across a context boundary.

1. Let the callee apply the deadline.
2. Give the callee the absolute deadline, as `deadlineMs` does.
3. Make the caller wait for the deadline plus a grace time.
4. Let the callee reply with a result that it got in time.

A rotation also has a deadline. `Sender.retire()` puts `timeoutMs` on the old flush with `withDeadline()`. After the deadline it reports `transport.timeout` and calls `transport.stop()`.

The exit flush has no cancellation. It never awaits, so it has nothing to cancel.

### Flush deadline

- `ObservabilityRuntime.flush()` checks the options and calls `flushFor()`. `flushFor()` starts one timer of `timeoutMs`. The wait for startup, the wait for a sender load, the wait in `LogPipeline.flushUntil()` and `Bus.requestFlush()` share it. The call clears the timer when it returns.
- The app's `flush()` sends the open interval of the meter and the profiler first. A flush that the bus starts for a child does not.
- At the deadline the call returns. Nothing is cancelled. A batch that ends later still writes its end to its `Pending` entry, but the call does not read it again.
- A forwarder asks its sender for `FLUSH_REQUEST_SHARE` of the time that is left, 90 percent, rounded down. It keeps the rest for the answer. The bus of the sender clamps the time to 0 to `FLUSH_TIMEOUT_MAX_MS` and runs `flushFor()` with it. Each hop of a chain thus keeps a margin, and the rule of the previous section applies.
- The bus keeps `flushAnswers`, the requests of this forwarder that wait for an answer. It removes each entry when its wait ends.
- The bus keeps `flushQueue`, the requests of children that wait for the next flush. `BUS_MAX_FLUSH_REQUESTS` limits all of them. `BUS_MAX_FLUSH_REQUESTS_PER_SOURCE` limits the requests of one source. `destroy()` empties the queue.
- `runFlushes()` runs one flush for the first request. Then it runs one flush for all requests that wait, with the latest end. Two flushes start at least `BUS_FLUSH_GAP_MS` apart. A request in the gap joins the next flush.
- During a rotation, `retiring` holds the sender that `Sender.retire()` stops. Its records count as `pending` in a flush.
- `RetryEngine.storeFailed()` gives the count of records that storage holds. A split that storage keeps only in part thus counts one half as `stored` and the other half as `dropped`.

## Modules and tests for common changes

The checklist of each change is in `.claude/skills/feature-change-checklist/SKILL.md`. The rule files for each folder are in `.claude/rules/`. This page does not repeat them. The rules that have no exception are in `AGENTS.md`. These files are in the checkout of the maintainer and are not in git.

| Change | Modules | Tests | Checklist section |
| --- | --- | --- | --- |
| A new config key | `src/models/config.ts`, `src/constants.ts`, `src/core/config.ts`. For a key fixed at startup, also `keepStartupTunables()` in `src/core/runtime.ts`. | `tests/config.test.ts`, `tests/policies.test.ts`, `tests/runtime.test.ts` | "A new config key", "A new config section" |
| A new capture | A module in `src/capture/`, its loader in `CAPTURE_LOADERS` and its install in `installCaptures()` in `src/core/runtime.ts`. For a remote switch, `REMOTE_CAPTURE_FLAGS`. | `tests/capture.test.ts`, `tests/phase-c-captures.test.ts`, `tests/remote-captures.test.ts`, `tests/storm.test.ts` | "A new capture", and the skill `auto-capture-safety` |
| A new transport behavior | `src/transport/status-transport.ts` for a status rule. Then each transport type, and `src/transport/worker-server.ts` for the worker side. | `tests/http-transport.test.ts`, `tests/custom-transport.test.ts`, `tests/worker-transport.test.ts`, `tests/worker-server.test.ts`, `tests/worker-client.test.ts`, `tests/worker-runtime.test.ts` | `.claude/rules/delivery.md`, and the skill `durability-and-recovery` |
| A change to retry, storage or exit | `src/transport/retry-engine.ts`, `src/storage/`, `src/transport/exit-flush.ts`, `src/core/pipeline.ts`, `src/core/sender.ts` | `tests/retry-engine.test.ts`, `tests/storage.test.ts`, `tests/eviction.test.ts`, `tests/emergency-queue.test.ts`, `tests/exit-flush.test.ts`, `tests/pipeline.test.ts`, `tests/sender.test.ts` | `.claude/rules/delivery.md` |
| A new loss reason | `LossReason` in `src/models/drop.ts`, the reporting module, and the table in [Delivery Guarantees](delivery-guarantees.md#losses) | `tests/drops.test.ts` and the test file of the reporting module | "A new attribute, code or header" |
| A new diagnostic code | `DiagnosticCode` in `src/core/diagnostics.ts`. For a code that is not a fault, `NOTICE_CODES` in `src/core/runtime.ts`. | `tests/diagnostics.test.ts`, `tests/diagnostic-records.test.ts`, and the test file of the reporting module | "A new attribute, code or header" |
| A change to the record build or a hook | `src/core/record.ts`, `src/core/logger.ts` | `tests/record.test.ts`, `tests/log-record.test.ts`, `tests/logger.test.ts`, `tests/sanitize.test.ts`, `tests/enterprise.test.ts` | "Privacy defaults" |
| A change to a lifecycle transition | `src/core/runtime.ts`, `src/index.ts` | `tests/runtime.test.ts`, `tests/enterprise.test.ts`, `tests/policies.test.ts` | "A new public function" |

Rules for each change.

- A test asserts the text of a diagnostic message. Change the test and the documents with the message.
- A transport behavior must give the same result on the HTTP path and on the worker path. Add the test to both.
- A new aggregator must collect at each place that calls `collectPoints()` in `src/core/runtime.ts`.
- A change is complete only when `pnpm run verify` passes with 100 percent coverage.
- A change to forwarding, trace propagation or the worker transport also needs `pnpm run test:e2e`. The unit tests run in happy-dom, and the browser tests run in real browsers.
- A change to the OTLP serializer also needs `pnpm run test:collector`.
- A change on the log call path also needs `pnpm run bench:release`.

## Open items

These facts are not verified against the code. Verify each one before you rely on it.

- The buffers inside `src/bus/bus.ts` and `src/bus/links.ts`. This page covers the forward buffer of the runtime only. It does not tell what the bus holds, or drops, between a forwarder and its sender.
- The aggregation state of `src/core/meter.ts` and `src/core/profiler.ts`. This page tells only that `collectPoints()` turns that state into records.
- The loss report of `shutdown()` with `clearStorage`. `clearStored()` calls no loss reporter for the stored batches that it removes. The `remove()` path of each adapter is not checked.
- The full path of a replay segment, from the replay buffer to `replay.endpoint`. See [Threat Model](threat-model.md) and [Runtime policies](runtime-policies.md) for the replay rules.
- The exact content of each test file. The test table uses the file names and the `describe` titles of `tests/`. It was not checked test by test.
- `.claude/` and `AGENTS.md` are in `.gitignore`. This page names their paths as text, because a link does not resolve in a clone of the repository.

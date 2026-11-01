# Runtime policies and migration

By default, the SDK limits captured content, isolates delivery identities and limits resources. The application owns these policies. The options below permit broader capture, relaxed bus trust, queue carryover and unbounded caching. Without `redact` and `processors`, the SDK does no content redaction. Structural sanitization and serialization still make values safe to log.

## Defaults and overrides

| Option                                | Default                       | Override                                                                                                                           |
| ------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `capture.interactions`                | `false`                       | `true`, or an options object, enables click breadcrumbs                                                                            |
| `capture.interactions.text`           | `false`                       | `true` captures `textContent`                                                                                                      |
| `capture.interactions.selector`       | `false`                       | `true` captures test IDs, IDs, ARIA labels or tag/classes                                                                          |
| `capture.interactions.ignoreSelector` | `[data-observability-ignore]` | Custom CSS selector, or `null` to include every region                                                                             |
| `capture.interactions.maxTextChars`   | `50`                          | Any nonnegative safe integer. `0` captures no text characters                                                                      |
| `redact`, `processors`                | Unset / empty                 | Application functions that rewrite or drop records                                                                                 |
| `securityContext.id`                  | Generated for this runtime    | Supply an opaque stable ID to replay its queues after reload                                                                       |
| `securityContext.isolation`           | `true`                        | `false` permits cross-context replay and ordinary routing reconfiguration                                                          |
| `lockConfiguration`                   | `false`                       | `true` rejects nonidentical `configure()` calls                                                                                    |
| `loggerCache.maxEntries`              | `256`                         | Nonnegative safe integer. `0` disables caching. `null` permits unbounded caching                                                   |
| `bus.sourcePolicy`                    | `registered`                  | `trusted-origin` restores automatic child discovery by origin                                                                      |
| `bus.validation`                      | `strict`                      | `envelope` relaxes message/record schema checks at the bus boundary                                                                |
| `bus.maxMessageBytes`                 | `262144`                      | Nonnegative safe integer. `0` disables the limit                                                                                   |
| `bus.maxRecordsPerMessage`            | `100`                         | Nonnegative safe integer. `0` disables the limit                                                                                   |
| `bus.maxMessagesPerSecond`            | `100`                         | Applies to each physical source in a fixed one-second window. `0` disables the limit                                               |
| `bus.maxTrackedSources`               | `256`                         | Capacity for named peers, for example OpenFin identities. Inactive entries expire after one second. `0` permits unbounded tracking |

An invalid tuning value reports `config.invalid`. The previous valid value stays. `configure()` applies cache, capture and bus budget changes until configuration is locked. The bus role and its links are set at startup. Register a frame before its application starts. Then its discovery handshake can succeed.

## Click capture

```ts
configure({
  endpoint: "https://ingest.example/v1/logs",
  serviceName: "orders",
  capture: { interactions: true },
});
```

```html
<button data-observability-action="submit-order"><span>Submit order</span></button>
<div data-observability-ignore>Account information</div>
```

A nested or SVG click uses the closest action attribute. The breadcrumb message is `submit-order`, or `unknown-click` when no action is present. The default reads no click text or descriptive DOM attributes. An ignored ancestor excludes its descendants. A click in an ignored region does not rotate the interaction trace. The SDK skips a target that is not an element. The application supplies action IDs. Use stable names, not client data.

For an internal application that needs more detail on purpose:

```ts
configure({
  capture: {
    interactions: {
      text: true,
      selector: true,
      ignoreSelector: null,
      maxTextChars: 120,
    },
  },
});
```

The details are in breadcrumb `data.text` and `data.selector`. An enabled selector can include sensitive IDs or accessible labels. `maxTextChars` limits the text. Record limits also apply when an error record contains the breadcrumb. Navigation capture is a separate setting.

## Console processing

Delivery sampling and minimum levels do not let console output bypass the configured processors or redaction. A console-only record goes through the same record pipeline, with context and error attributes. The SDK does not send it. A hook that drops, throws or returns a malformed record suppresses the line. The SDK reuses a record that it already processed for delivery. Thus the hooks run one time for one log call. When hooks are configured, a sampled-out breadcrumb also uses the processed message.

The SDK runs the hooks for a sampled-out record only if a breadcrumb or the console uses it. With `capturePolicy.breadcrumbs: 0`, or for a metric record, only console output runs them. With hooks and breadcrumbs on, each sampled-out call builds a full record. At a low sample rate, this cost stays.

Without processing hooks, console output shows the raw message, payload and error. The `console` option controls console output separately. SDK redaction does not remove the original `console.*` call of the application. `capture.console` observes that call and processes the record that the SDK captures. The original browser console call still occurs.

Hooks can run for a record that goes only to the console or to a breadcrumb. This includes records below the delivery level or outside the sample. Keep hooks fast. Do not assume that each hook call sends a record.

## Security context rotation

A session ID correlates activity. It does not identify a delivery partition. `newSession()` starts new correlation, ends the active trace and journey, and clears breadcrumbs. It does not isolate queues or credentials. Use the asynchronous rotation API for logout and tenant changes.

```ts
import { configure, rotateSecurityContext } from "@utk09/ui-observability";

configure({
  serviceName: "orders",
  endpoint: "https://tenant-a.example/v1/logs",
  headers: tenantAHeaders,
  securityContext: { id: opaqueLoginContextA },
  lockConfiguration: true,
});

await rotateSecurityContext(
  {
    id: opaqueLoginContextB,
    delivery: {
      endpoint: "https://tenant-b.example/v1/logs",
      headers: tenantBHeaders,
      credentials: "omit",
    },
    context: { tenant: "tenant-b" },
  },
  { pending: "discard" },
);
```

`delivery` replaces the endpoint, the metrics and traces endpoints, the headers, the cookie credentials, the custom transport and the exit transport together. An omitted field resets. The endpoint becomes `null`. The signal endpoints become empty. The SDK removes the headers and the transports. Credentials become `omit`. Other runtime settings stay. Invalid delivery settings reject before the active sender stops. Endpoint URLs must be absolute, as with `configure()`. The rotation also removes the old endpoints from `capture.ignoreUrls`.

| `pending` policy    | Behavior                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discard` (default) | Cancel old work and remove its pending and stored records                                                                                                                                                                                                                                                                                                                             |
| `flush`             | Try to send pending records and one pass of stored records with the old settings. `timeoutMs` (default 5000) limits the wait. Then discard the remaining records. Offline, throttle and drain-size limits still apply. A flush that does not complete reports `transport.timeout`                                                                                                     |
| `retain`            | Keep pending and stored records in the old partition. The SDK stores pending records as whole batches. It sends them only when that explicit ID is active again                                                                                                                                                                                                                       |
| `carry`             | Move pending and stored records into the new delivery context. The records keep their original resource and session attributes. Each stored batch keeps its batch ID and changes to the new context ID with no attempts. The retry engine sends them. Logger calls during this step go to the new context. Without a new destination, the stored batches stay parked under the old ID |

Use `flush` before you change external authentication or a live headers-provider closure. Retries stop when the old context stops. The SDK aborts HTTP sends. A custom `TransportRequest` receives `signal` and `routingContextId`. A custom transport must honor `signal` to cancel its own work. The SDK cannot recall a request or beacon that the server accepted. `timeoutMs` limits the pipeline flush. Storage cleanup has its own storage deadlines.

During rotation, the SDK drops logger calls, metric measurements and forwarded records. It does not give them to either identity. `onDrop` reports the forwarded records with `security_context`. The rotation resets context, breadcrumbs, open metric aggregates, trace and journey state, and remote sampling. Supply `context` to replace ambient attributes. The application owns its `contextProvider` closures and scoped logger attributes. Update them, or create new scoped loggers, when the user changes. An overlapping rotation rejects. Callers must wait for completion. The upstream owner does the rotation. An independent frame can use `bus.mode: 'sender'` to own its delivery.

Each batch keeps its delivery ID through persistence, splitting and retries. With isolation on, the active context does not send foreign batches or untagged legacy batches. They stay parked. Shared storage retention and capacity limits can still remove parked batches. A generated runtime-local ID does not resume the queues of a previous page. To resume after a reload, configure the correct stable context ID before the first log call. Never use one ID for two user or tenant authorization contexts. Do not put secrets or personal data in the ID.

An auto-discovered forwarder uses the delivery identity of its owner. When it knows its owner, it welcomes its own children. It relays their records. It sends them the identity of its owner. A context that still waits for its own owner sends no temporary identity. Its children get the final identity when its role is known. The first identity that a forwarder takes keeps its startup records and the context of the app. When the owner later changes its identity, the forwarder clears its buffered records before it uses the new identity. It does this also before it is ready. `onDrop` reports the cleared records with `security_context`. A same-origin forwarder then uses the new session that its owner stores. Other forwarders start a new session. A frame with an explicit ID must match the owner. It does not use another identity without notice. The owner sends the new identity to registered frames, workers and OpenFin views. A same-origin direct child gets the new identity at its next message. The owner refuses that first old batch. Other tabs keep their own active context. The host must coordinate authentication changes in other applications and tabs. The SDK does not infer them from cookies.

With isolation on, `configure()` refuses a change to delivery settings or to the context ID. It reports `config.invalid` and keeps the values in force. The other settings in the same call apply. The SDK compares resolved values. Thus an unset `endpoint` value is not a change. A new `headers`, `transport` or `transportOnExit` function is a change. Keep their references stable. To permit delivery changes and cross-partition replay, disable isolation explicitly.

```ts
configure({ securityContext: { isolation: false } });
configure({ endpoint: "https://internal.example/v1/logs" });
```

This is an intentional policy change. Old and legacy queued records can then use the active destination and credentials.

## Configuration ownership and logger cache

The shell configures the runtime. Microfrontends usually call only `getLogger()`. `lockConfiguration: true` accepts identical repeated settings, for example React StrictMode setup. It reports `config.locked` for a change. Functions and plugins must have the same references to count as identical. Rotation stays available while configuration is locked. Use `setConfigurationLocked(false)` to unlock. `configure({ lockConfiguration: false })` does not unlock a locked runtime. A lock prevents accidental changes. It does not stop malicious same-origin JavaScript.

The cache uses LRU eviction. It never caches scoped loggers. Existing logger handles stay usable. After eviction, a later `getLogger(namespace)` can return a different instance. A lower limit removes cached entries immediately. With `0`, each lookup returns a new logger. With `null`, the application accepts unbounded namespace retention. Each loaded copy of the SDK module has its own cache.

For Module Federation, configure the dependency as a singleton in the shell and in each remote. Require the same exact version.

```ts
shared: {
  '@utk09/ui-observability': {
    singleton: true,
    requiredVersion: '0.9.5',
  },
}
```

A shared runtime requires the same exact SDK version in each copy. Align the deployed versions. Do not rely only on a broad dependency range. Host code should examine health after startup.

## Registered bus sources

```ts
const unregister = registerFrame(iframe, {
  origin: "https://orders.example.com",
  permissions: ["records", "journey:read", "sampling:read"],
});

const detachWorker = registerWorker(workerOrPort, {
  permissions: ["records"],
});

// Remove the registrations when the component stops.
unregister();
detachWorker();
```

A frame registration binds the actual window and the exact expected origin. You can register an iframe element or a `Window`, for example a cross-origin popup. The registration authorizes that child origin without a second `trustedOrigins` entry. A child still lists a cross-origin parent in its own `bus.trustedOrigins`. Forwarding does not support sandboxed opaque origins. Registrations also apply to the same-origin direct path. You can call their cleanup functions before the asynchronous bus construction completes.

Permissions default to `['records']`. The other permissions are `journey:read`, `journey:write` and `sampling:read`. Incoming requests and outgoing control messages both obey these permissions. Handshakes and delivery-context updates need no permission. Only the established upstream owner can publish sampling and security-context messages. A child cannot get owner authority with a false message field.

`sourcePolicy: 'trusted-origin'` turns on automatic child discovery. Then this document's origin and the `trustedOrigins` can send messages. Explicit registrations still apply their permissions and bind their exact origin. A registered origin needs no `trustedOrigins` entry. Strict validation checks the protocol union, forwarded record fields, known severities, timestamps, trace identifiers and finite numeric values. Relaxed `envelope` validation keeps the record-builder checks that the SDK needs to process records. The child link of a nested frame ignores the messages of its parent. The parent link receives them.

Size and count limits split outgoing record batches. The bus drops a record that is too large by itself and counts `bus.rejected_message`. Rate limits apply before record processing. A change to a self-reported context ID does not reset the budget of a physical source. OpenFin stays scoped to its application UUID and provider role. The bus uses the physical identity that the OpenFin runtime supplies. Channels without this identity share one channel budget. These client controls do not replace ingest-server authentication or tenant authorization.

## Runtime health

```ts
const health = await getHealth();
if (health.status === "degraded") {
  // Report health.issues to the host's deployment monitor.
}
```

The snapshot contains these fields:

- The SDK version and the owning SDK version.
- The status, `starting`, `ready`, `rotating`, `degraded` or `stopped`.
- The mode, `sender`, `forwarder` or `console-only`.
- `senderReady`.
- The `pending`, `inFlight`, `stored` and `lastSendAt` stats.
- The lock and cache state.
- The effective security and bus policies.

`owningSdkVersion` identifies a conflicting copy. Otherwise it is `null`. A forwarder usually has `senderReady: false`. An intentional console-only runtime can be `ready`. A version conflict reports `runtime.version_mismatch` in `issues`. A failed sender initialization reports `sender.unavailable`. An explicit forwarder and owner identity conflict reports `security.context_mismatch`.

Health does not start a second runtime. It does not wait for initialization to complete. Before any configuration, it creates the lazy default runtime, as other facade functions do. The stored count needs an asynchronous storage read. Health shows the state of this copy and context only. It does not show that an upstream sender or collector is reachable. Stats and diagnostics show temporary network failures. A network failure alone does not mean an SDK version conflict.

## Upgrade checklist

1. If you used the old automatic click details, turn on `text` or `selector`. Read selectors from `breadcrumb.data.selector`.
2. Replace `newSession()` at logout with awaited rotation. Also replace `configure()` calls that change delivery. Or disable isolation explicitly.
3. Supply a stable security-context ID if you need offline replay after a page reload. The default isolation policy parks legacy untagged batches. Disable isolation only if you intend to send them with the current credentials.
4. Register child frames before they start. Grant journey and sampling permissions where necessary. Or select origin-based discovery explicitly.
5. Examine redactors and processors for console-only calls. Upgrade all frames and federated copies together. A 0.9.5 owner drops the records of a frame on an earlier version, because they have no context ID.
6. Set cache and bus budgets for the workload of the application. Then lock configuration if the shell owns it.

## Operational budgets

These controls are application policy, not fixed SDK constants. A partial update keeps the current values. An invalid value reports `config.invalid`. The previous valid value stays. Numeric values must be safe nonnegative integers. Durations are in milliseconds. They cannot be more than the platform timer limit (2,147,483,647). Concurrency, request timeouts and drain sizes must be at least 1. Breadcrumb capacity is at most 1,000,000. A larger value gives an invalid array allocation.

```ts
configure({
  delivery: {
    requestTimeoutMs: 15000,
    maxConcurrentRequests: 2,
    retryBaseDelayMs: 2000,
    retryMaxDelayMs: 60000,
    retryIdleDelayMs: 30000,
    batchesPerDrain: 20,
  },
  buffering: {
    maxPendingRecords: 10000,
    maxPendingBytes: 16777216,
    overflow: "drop-oldest",
  },
  metrics: {
    maxSeries: 100,
    maxInstruments: 1000,
    maxHistogramBoundaries: 50,
  },
  correlation: {
    sessionIdleMs: 1800000,
    sessionTouchMs: 60000,
    traceMaxAgeMs: 300000,
  },
  diagnostics: { throttleMs: 1000, consoleFallback: false },
  persistence: { namespace: "orders-production" },
  metadata: { pageUrl: true, userAgent: true, openfin: true },
  capturePolicy: {
    breadcrumbs: 50,
    errorDedupeMs: 5000,
    maxErrorSignatures: 200,
    errorsPerWindow: 20,
    consolePerWindow: 20,
    longFramesPerWindow: 20,
    webSocketPerWindow: 20,
    windowMs: 10000,
    errorCeiling: 500,
  },
});
```

The example shows the defaults. The persistence namespace is specific to the application. Correlation settings and the persistence namespace are startup settings. Use `shutdown()` and `configure()` to change them. The owning subsystems read the other budgets at runtime. A request in progress keeps its deadline. A lower buffer budget applies at the next admission. A lower metric cardinality budget applies to new instruments and series in the current interval. It applies to all series in the next interval. It does not delete measurements already aggregated.

Zero disables the buffering, metric cardinality, deduplication, error-signature cache and capture rate limits. `breadcrumbs: 0` disables breadcrumb storage. `sessionIdleMs: 0` and `traceMaxAgeMs: 0` disable idle expiration. `sessionTouchMs: 0` writes activity for each record. The SDK checks session idle expiration when it reads the persisted identity. It is not a background logout timer. `throttleMs: 0` emits each diagnostic event. `windowMs: 0` disables the fixed-window throttle. Each event then starts a new window. A retry delay of zero requests an immediate retry. The maximum delay must be at least the base delay.

Buffering budgets include buffered records and queued or in-flight pipeline records. The SDK measures each record by its encoded JSON size. These are accounting limits. They do not measure JavaScript heap use. `drop-oldest` removes buffered groups or batches that the SDK did not dispatch. It cannot stop an in-flight request. A record larger than `maxPendingBytes` never fits. The SDK drops that record only. `drop-newest` refuses the incoming record. `persist` writes an overflow record directly to storage. It does not add the record to the delivery queue. Only one overflow storage operation can be in progress. The SDK drops more overflow until that operation completes. That operation can keep one record more than the queue budget, even if storage stalls. Normal persistence retention and quota settings still apply. `onDrop` reports capacity drops with `buffer_full`.

Metric cardinality has a limit for each collection interval. The SDK adds extra attribute sets to the `otel.metric.overflow` series. The totals stay correct. The SDK drops measurements for instrument names after `maxInstruments`. It counts them as `record.dropped_by_ceiling`. Histogram budgets limit the number of boundaries that the caller supplies. An invalid list uses the default boundaries of the SDK. The SDK does not sample aggregate metric points.

The diagnostics fallback is off by default. When it is on, it prints a fixed message. It never prints the exception, its message or its stack. The SDK still counts the failure under `handler.threw`. An application that needs the exception details can catch errors in its own diagnostic handler.

### Persistence and deletion

The namespace separates IndexedDB database names, localStorage keys and emergency queues. The empty default namespace keeps the previous storage location. A namespace change does not move old data. A stable security-context ID is still necessary to resume a context after a reload. IndexedDB schema version 12 adds a compound context and time index. The upgrade also adds it to a database that has batches. With isolation on, legacy untagged entries stay parked.

```ts
await clearPersistedLogs(); // Active security context in this application's namespace.
await clearPersistedLogs("namespace"); // All contexts in this namespace, including parked data.
```

Deletion removes the normal and emergency queues that are stored now. It also works in console-only mode. Pending and in-flight records can be stored after deletion. Use awaited context rotation to stop an identity. Deletion applies only to the configured namespace. It does not cancel application requests. With isolation off, contexts share their stored batches. Then `clearPersistedLogs()` and a `discard` rotation remove the stored batches of each context in the namespace, also of other open tabs. Applications that use the empty namespace share its retention and deletion scope.

### URL and resource-field policy

`metadata.userAgent` and `metadata.openfin` control those resource fields. With `metadata.pageUrl: false`, the reserved `page.url` attribute is empty. The application controls the attributes and message strings that it supplies. They can also go through `redact`.

`capture.fullUrls` applies to page, HTTP, resource, navigation and long-frame URLs. The default removes credentials, query and fragment. A WebSocket URL never keeps its query or fragment, also with `fullUrls`. A browser cannot set a header on a socket. Thus its query often holds a token. For more control, use `capture.urlTransform`.

```ts
configure({
  capture: {
    urlTransform: (originalUrl) => {
      const url = new URL(originalUrl, location.href);
      return `${url.origin}/[route]`;
    },
  },
});
```

The callback receives the original URL. It replaces the default URL rule. If it returns `null` or a value that is not a string, the SDK records an empty URL. If it throws, the SDK records an empty URL and reports `capture.record_failed`. The callback does not change the actual network target. It does not change the full URL for ignore and trace-propagation matching. A callback can return the complete original URL on purpose. Keep the callback reference stable when configuration is locked. A new callback reinstalls captures where necessary.

With isolation on, WebSocket lifecycle events and message counters stay with the context that opened the socket. After rotation, the SDK ignores events from old sockets. With isolation disabled, those sockets continue to record under the active context. The SDK does not close application sockets.

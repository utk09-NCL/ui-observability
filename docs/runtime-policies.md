# Runtime policies and migration

By default, the SDK limits captured content, isolates delivery identities and limits resources. The application owns these policies. The options below permit broader capture, relaxed bus trust, queue carryover and unbounded caching. Without `redact` and `processors`, the SDK does no content redaction. Structural sanitization and serialization still make values safe to log.

## Defaults and overrides

| Option | Default | Override |
| --- | --- | --- |
| `transportWorker` | Unset | Creates a dedicated worker for built-in encoding, compression and HTTP sends. The app supplies a fresh worker for each call. |
| `payloadMode` | `copy` | `defer` keeps raw payload references until an idle build. The debug buffer always builds at the call. |
| `capture.remoteToggles` | `[]` | Permits remote changes to the named capture switches for the sampling TTL. Privacy controls stay local. |
| `capture.serverTiming` | `false` | Adds at most 32 Server-Timing response entries from at most 4096 header characters. |
| `capture.reports` | `false` | Records fixed report fields. URLs have no credentials, query or fragment. Text and code samples stay out. |
| `capture.resourceTiming` | `false` | Records resource duration histograms by initiator type and host. Skips ingest and ignored URLs. |
| `capture.resourceTiming.slowMs` | `1000` | Minimum duration of a slow resource event, in milliseconds. Set `0` for no slow events. |
| `capture.lifecycle` | `false` | Records page states with the duration of the previous state. |
| `captureLimits.reportsPerWindow` | `20` | Maximum browser reports in each window. Set `0` to capture none, or `null` for no limit. |
| `captureLimits.resourcesPerWindow` | `100` | Maximum resource entries in each window. Set `0` to capture none, or `null` for no limit. |
| `captureLimits.lifecyclePerWindow` | `20` | Maximum lifecycle events in each window. Set `0` to capture none, or `null` for no limit. |
| `capture.interactions` | `false` | `true`, or an options object, enables click breadcrumbs |
| `capture.interactions.text` | `false` | `true` captures `textContent` |
| `capture.interactions.selector` | `false` | `true` captures test IDs, IDs, ARIA labels or tag/classes |
| `capture.interactions.ignoreSelector` | `[data-observability-ignore]` | Custom CSS selector, or `null` to include every region. Session replay always blocks `[data-observability-ignore]` |
| `capture.interactions.actionAttribute` | `data-observability-action` | Another attribute name, for example `data-testid`. Use letters, digits, hyphens and underscores |
| `capture.interactions.maxTextChars` | `50` | Any nonnegative safe integer. `0` captures no text characters |
| `capture.interactions.rageClicks` | `false` | `true` records one `ui.rage_click` for each burst, with the action name and the click count. `rageClickCount` (3) and `rageClickWindowMs` (1000) set the burst |
| `capture.interactions.deadClicks` | `false` | `true` records `ui.dead_click` with the action name only. `deadClickMs` (1000) sets the wait for a response. A `target="_blank"` or `download` link gives no event |
| `capture.interactions.deadClickIgnoreSelector` | `[data-observability-live]` | A CSS selector. A DOM change or a scroll inside a matching element is not a response to a click. Mark the element that changes on its own, for example a price cell. `""` turns the live-region filter off. A write that keeps the same value is not a response. A batch that sets `name` or `type` and then puts the old value back is not a response. For any other attribute, each write with a new value is a response, because a class or style change can restart an animation |
| `redact`, `processors` | Unset / empty | Application functions that rewrite or drop records. A `redact` value that is not a function keeps the current hook. Without a current hook, the SDK drops each record until `redact` is a function or `null`. A `processors` list with an entry that is not a function keeps the current list. Without a current list, the SDK drops each record until `processors` is a list of functions or `[]` |
| `securityContext.id` | Generated for this runtime | Supply an opaque stable ID to replay its queues after reload |
| `securityContext.isolation` | `true` | `false` permits cross-context replay and ordinary routing reconfiguration |
| `lockConfiguration` | `false` | `true` rejects nonidentical `configure()` calls |
| `loggerCache.maxEntries` | `256` | Integer from 0 to 9007199254740991. `0` disables caching. `null` permits unbounded caching |
| `bus.sourcePolicy` | `registered` | `trusted-origin` restores automatic child discovery by origin |
| `bus.maxMessageBytes` | `262144` | Safe integer of 1 or more. `null` disables the limit |
| `bus.maxRecordsPerMessage` | `100` | Safe integer of 1 or more. `null` disables the limit |
| `bus.maxMessagesPerSecond` | `100` | Applies to each physical source in a fixed one-second window. 1 or more. `null` disables the limit |
| `sampling.alwaysSampleFrom` | `ERROR` | A lower level, for example `WARN`, also keeps the records of that level at each rate. `sampling.errorCeiling` limits these log records |
| `sampling.errorCeiling` | `500` | Maximum log records at or above `sampling.alwaysSampleFrom` in each window. Metric points and spans do not count. `0` drops each one. `null` sets no limit |
| `sampling.errorCeilingWindowMs` | `10000` | Window of `sampling.errorCeiling`, in milliseconds. 1 or more |

An invalid tuning value reports `config.invalid`. The previous valid value stays. `configure()` applies cache, capture and bus budget changes until configuration is locked. The bus role and its links are set at startup. A later change to `bus.mode` or `bus.openFinRole` reports `config.invalid`, for example `bus.mode cannot change after startup. The library keeps "auto".` A new `bus.trustedOrigins` entry does not reconnect a parent link that already exists. The parent link checks the parent origin one time, when the bus starts. Register a frame before its application starts. Then its discovery handshake can succeed.

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

Session replay always blocks each element in `[data-observability-ignore]`, so an ignored region is also absent from a replay. A custom `ignoreSelector` changes click capture only. A nested or SVG click uses the closest action attribute. `capture.interactions.actionAttribute` selects another attribute, for example `data-testid`, if your markup already names its controls. The breadcrumb message is `submit-order`, or `unknown-click` when no action is present. The default reads no click text or descriptive DOM attributes. An ignored ancestor excludes its descendants. A click in an ignored region does not rotate the interaction trace. The SDK skips a target that is not an element. The application supplies action IDs. Use stable names, not client data.

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

The SDK runs the hooks for a sampled-out record only if a breadcrumb or the console uses it. With `captureLimits.breadcrumbs: 0`, or for a metric record, only console output runs them. With hooks and breadcrumbs on, each sampled-out call builds a full record. At a low sample rate, this cost stays.

Without processing hooks, console output shows the raw message, payload and error. The `consoleOutput` option controls console output separately. SDK redaction does not remove the original `console.*` call of the application. `capture.console` observes that call and processes the record that the SDK captures. The original browser console call still occurs.

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
    routing: {
      endpoint: "https://tenant-b.example/v1/logs",
      headers: tenantBHeaders,
      credentials: "omit",
    },
    context: { tenant: "tenant-b" },
  },
  { pending: "discard" },
);
```

`routing` replaces the endpoint, the metrics and traces endpoints, the headers, the cookie credentials, the custom transport, the exit transport and the worker factory together. An omitted field resets. A field with the value `undefined` also resets. This rule is different from `configure()`. The endpoint and the signal endpoints become `null`. The SDK removes the headers and the transports. Credentials become `omit`. The rotation also removes the old endpoints from `capture.ignoreUrls`.

`routing` takes only these routing settings. A key of another setting, for example `redact` or `capture`, reports `config.invalid`. The text is `rotateSecurityContext() ignores routing.<key>. A rotation changes only the routing settings.` The rotation ignores that key, and the setting keeps its current value. A warning does not reject a rotation. For example, `transport` with `transportWorker` reports `config.invalid`, and the rotation continues. A relative endpoint URL resolves against `document.baseURI`, as with `configure()`, and the rotation uses the absolute URL. The rotation rejects when it cannot apply a routing value as given. The text is `Invalid routing settings for the next security context.` Examples are `credentials: "all"`, a `transport` that is not a function, an endpoint URL with a user name or a password, and a blank `endpoint`. The rotation first waits for a delivery stack load in progress. Then it checks the arguments. A rejected check closes the delivery, as for each rejected rotation.

`timeoutMs` accepts 0 to 600000. Its default is 5000. A value outside that range, or a value that is not a finite number, rejects the rotation. The text is `Invalid security-context rotation options.` An unknown `pending` rule, a missing `routing` object and an empty `id` also give this text. The upper limit exists because a browser timer fires at once for a delay above 2,147,483,647 ms.

Rotations run in call order. Each call waits for the earlier call. The first call also waits, so it starts on a later microtask. Thus a logout that starts during a login runs after the login. From the call on, the SDK drops each logger call and each new record at once. `onDrop` reports each built record with `security_context`. The SDK does not hold a record for the next context. A `flush` rotation can delay a waiting call by its `timeoutMs`. Keep `timeoutMs` short for a rotation that a logout can follow.

A rotation before the first `configure()` call that works rejects. The runtime then has no context to leave. A failed first `configure()` call gives the same result until a call sets `redact`. The text is `The runtime is not configured. Call configure() before rotateSecurityContext().` The rejection does not close the delivery.

A rotation during a pause sends nothing. With `pending: "flush"`, it acts as `discard`. With `pending: "carry"`, the delivery stack of the new context takes the old records after `enabled: true`.

A rotation in a forwarder rejects, because the upstream owner does the rotation. That rejection does not close the delivery of the forwarder. A record that the forwarder builds during that call also goes to `onDrop` with `security_context`.

The rotation code is a separate chunk. The SDK loads it with a dynamic import on the first `rotateSecurityContext()` call. If the chunk does not load, the rotation rejects. The delivery then closes, as for each rejected rotation. The SDK also reports `pipeline.crashed` with the text `The library could not load the security-context rotation.` A forwarder rejects before the load, and its delivery stays open.

In a sender, a rejected rotation closes the delivery of the current context, because the app asked to leave it. The SDK then sends no record with the old endpoint, the old headers or the old transport. The old sender stops. Its unsent records stay stored under the old context ID. A delivery stack load that ends later also stops its sender. If the old sender does not stop, the SDK reports `pipeline.crashed` with the text `The delivery stack of the old context did not stop. The next rotation that succeeds retires it.` The SDK drops each new record and reports it to `onDrop` with `security_context`. It also reports the records that it built during the rotation. The SDK reports `security.rotation_failed`. `getHealth()` shows `status: "degraded"`, `senderReady: false` and the issue `security.rotation_failed`. `getHealth().delivery.stored` still counts the stored batches of the closed context, until a rotation that succeeds retires them. A `configure()` call does not open the delivery again. To continue, call `rotateSecurityContext()` again with valid routing settings. That rotation applies its `pending` rule to the stored records and the emergency queue of the closed context. With `flush`, the SDK removes them as with `discard`, because a flush would use the old settings. When the rotation succeeds, the SDK sends the new records of the new context. If `shutdown()` cannot stop the delivery stack of a closed context, the SDK reports `pipeline.crashed`. The text is `The delivery stack of the old context did not stop at shutdown. The library leaves its stored batches in storage.`

| `pending` policy | Behavior |
| --- | --- |
| `discard` (default) | Cancel old work and remove its pending and stored records |
| `flush` | Try to send pending records and one pass of stored records with the old settings. `timeoutMs` (default 5000) limits the wait. Then discard the remaining records. Offline, throttle and drain-size limits still apply. A flush that does not complete reports `transport.timeout` |
| `retain` | Keep pending and stored records in the old partition. The SDK stores pending records as whole batches. It sends them only when that explicit ID is active again |
| `carry` | Move pending and stored records into the new delivery context. The records keep their original resource and session attributes. Each stored batch keeps its batch ID and changes to the new context ID with no attempts. The retry engine sends them. Logger calls during this step go to the new context. Without a new destination, the stored batches stay parked under the old ID |

Use `flush` before you change external authentication or a live headers-provider closure. Retries stop when the old context stops. The SDK aborts HTTP sends. A custom `TransportRequest` receives `signal` and `routingContextId`. A custom transport must honor `signal` to cancel its own work. The SDK cannot recall a request or beacon that the server accepted. `timeoutMs` limits the pipeline flush. Storage cleanup has its own storage deadlines.

During rotation, the SDK drops logger calls, metric measurements and forwarded records. It does not give them to either identity. With isolation, a `startMeasure()` measure of the old identity records nothing at its `end()`. `onDrop` reports the forwarded records and the records that the SDK built during the rotation with `security_context`. The rotation resets context, breadcrumbs, open metric aggregates, trace and journey state, and remote sampling. Supply `context` to replace ambient attributes. The application owns its `contextProvider` closures and scoped logger attributes. Update them, or create new scoped loggers, when the user changes. A rotation that starts during another rotation runs after it. The upstream owner does the rotation. An independent frame can use `bus.mode: 'sender'` to own its delivery.

Each batch keeps its delivery ID through storage, splitting and retries. With isolation on, the active context does not send foreign batches or untagged legacy batches. They stay parked. Shared storage retention and capacity limits can still remove parked batches. A generated runtime-local ID does not resume the queues of a previous page. To resume after a reload, configure the correct stable context ID before the first log call. Never use one ID for two user or tenant authorization contexts. Do not put secrets or personal data in the ID.

An auto-discovered forwarder uses the delivery identity of its owner. When it knows its owner, it welcomes its own children. It relays their records. It sends them the identity of its owner. A context that still waits for its own owner sends no temporary identity. Its children get the final identity when its role is known. The first identity that a forwarder takes keeps its startup records and the context of the app. When the owner later changes its identity, the forwarder clears its buffered records before it uses the new identity. It does this also before it is ready. `onDrop` reports the cleared records with `security_context`. A same-origin forwarder then uses the new session that its owner stores. Other forwarders start a new session. A frame with an explicit ID must match the owner. It does not use another identity without notice. The owner sends the new identity at once to its frames, workers and OpenFin views. This includes each same-origin frame on the direct link. A frame with an explicit ID that matches the new identity then clears `security.context_mismatch`. Other tabs keep their own active context. The host must coordinate authentication changes in other applications and tabs. The SDK does not infer them from cookies.

With isolation on, `configure()` refuses a change to routing settings or to the context ID. It reports `config.invalid` and keeps the current values. The other settings in the same call apply. The SDK compares resolved values. Thus an unset `endpoint` value is not a change. A new `headers`, `transport`, `transportOnExit` or `transportWorker` function is a change. Keep their references stable. To permit routing changes and cross-partition replay, disable isolation explicitly.

```ts
configure({ securityContext: { isolation: false } });
configure({ endpoint: "https://internal.example/v1/logs" });
```

This is an intentional policy change. Old and legacy queued records can then use the active destination and credentials.

## Configuration ownership and logger cache

The shell configures the runtime. Microfrontends usually call only `getLogger()`. `lockConfiguration: true` accepts identical repeated settings, for example React StrictMode setup. It reports `config.locked` for a change. Functions and plugins must have the same references to count as identical. Rotation stays available while configuration is locked. Use `setConfigurationLocked(false)` to unlock. `configure({ lockConfiguration: false })` does not unlock a locked runtime. A lock also keeps the refusal after a failed first `configure()` call. Unlock the runtime first, then set `redact`. A lock prevents accidental changes. It does not stop malicious same-origin JavaScript.

The cache uses LRU eviction. It never caches scoped loggers. Existing logger handles stay usable. After eviction, a later `getLogger(namespace)` can return a different instance. A lower limit removes cached entries immediately. With `0`, each lookup returns a new logger. With `null`, the application accepts unbounded namespace retention. Each loaded copy of the SDK module has its own cache.

For Module Federation, configure the dependency as a singleton in the shell and in each remote. Require the same exact version.

```ts
shared: {
  '@utk09/ui-observability': {
    singleton: true,
    requiredVersion: '1.0.0',
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

A frame registration binds the actual window and the exact expected origin. You can register an iframe element or a `Window`, for example a cross-origin popup. The registration authorizes that child origin without a second `trustedOrigins` entry. A child still lists a cross-origin parent in its own `bus.trustedOrigins`. Forwarding does not support sandboxed opaque origins. Registrations also apply to the same-origin direct path. A registration also connects a same-origin `srcdoc` or `about:blank` frame. The `location.origin` of such a frame is `"null"`. The frame gives the parent the value of its `origin` global instead. Register such a frame with the origin of the parent. You can call their cleanup functions before the asynchronous bus construction completes.

Without a direct link, a frame tries the message link to its parent. The frame looks for the origin of its parent in this order.

1. `location.ancestorOrigins`. Firefox does not have it.
2. The origin of `document.referrer`. A `srcdoc` frame in Firefox has an empty referrer.
3. The `origin` global of the parent. Only a same-origin parent gives a string. The frame refuses each other value.

The frame never uses the origin `"null"`. It posts to the parent only when that origin is its own origin or an entry of `bus.trustedOrigins`. It never posts to `"*"`. A `srcdoc` frame uses its `origin` global as its own origin. As a parent, it uses that value for the source policy and for a new security context. As a forwarder, it uses that value to check the sampling rules of its parent.

Permissions default to `['records']`. The other permissions are `journey:read`, `journey:write` and `sampling:read`. Each frame and worker asks for the journey when it starts. Only a registered frame or worker needs `journey:read`. With `journey.scope: "context"`, a frame or worker sends no request. Without `journey:read`, the bus refuses the request and counts `bus.journey_denied`. It does not count `bus.rejected_message` for it. Incoming requests and outgoing control messages both obey these permissions. Handshakes and delivery-context updates need no permission. Only the established upstream owner can publish sampling and security-context messages. A child cannot get owner authority with a false message field.

`sourcePolicy: 'trusted-origin'` turns on automatic child discovery. Then this document's origin and the `trustedOrigins` can send messages. Explicit registrations still apply their permissions and bind their exact origin. A registered origin needs no `trustedOrigins` entry. The bus always checks each record and each control message. It checks the protocol union, forwarded record fields, known severities, timestamps, trace identifiers and finite numeric values. Each bus message carries the envelope tag `ui-observability/2`. Its type name starts with `ui-observability.message.`, for example `ui-observability.message.hello`. These names are a fixed protocol. Each frame must use the same values. The child link of a nested frame ignores the messages of its parent. The parent link receives them.

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
- The status, `unconfigured`, `disabled`, `starting`, `ready`, `rotating`, `degraded` or `stopped`. `unconfigured` means that no `configure()` call has worked yet. `disabled` means that `enabled` is false.
- The mode, `sender`, `forwarder` or `console-only`.
- `senderReady`.
- The `delivery` block, with `pending`, `inFlight`, `stored`, `lastSendAt`, `lastFailureAt`, `consecutiveFailures`, `throttledUntil` and `dropped`. It has numbers and times only. A rotation resets `lastFailureAt`, `consecutiveFailures` and `throttledUntil`. It keeps `lastSendAt` and `dropped`.
- The lock and cache state.
- The effective security policy.
- The bus policy, with `sourcePolicy`, `maxMessageBytes`, `maxRecordsPerMessage` and `maxMessagesPerSecond`.
- `storagePersistence`, the state of the request of `storage.requestPersistent`.

`owningSdkVersion` identifies a conflicting copy. Otherwise it is `null`. A forwarder usually has `senderReady: false`. An intentional console-only runtime can be `ready`. A version conflict reports `runtime.version_mismatch` in `issues`. A failed sender initialization reports `sender.unavailable`. A rejected rotation reports `security.rotation_failed` until a rotation succeeds. A `redact` or `processors` value that makes the SDK drop each record reports `records.refused`. A failed first `configure()` call also reports `records.refused`, with the status `unconfigured`. An explicit forwarder and owner identity conflict reports `security.context_mismatch`.

Health does not start a second runtime. It does not wait for initialization to complete. Before any configuration, it creates the unconfigured runtime, as other facade functions do. That runtime starts nothing until a `configure()` call works. The stored count needs an asynchronous storage read. Health shows the state of this copy and context only. It does not show that an upstream sender or collector is reachable. The `delivery` block and the diagnostics show temporary network failures. A network failure alone does not mean an SDK version conflict.

## Upgrade checklist

To upgrade from 0.12.x to 1.0.0, do the steps in [Migration to 1.0.0](migration-v1.md). The steps below are from earlier upgrades.

1. If you used the old automatic click details, turn on `text` or `selector`. Read selectors from `breadcrumb.data.selector`. If your markup already names its controls, for example with `data-testid`, set `capture.interactions.actionAttribute`.
2. Replace `newSession()` at logout with awaited rotation. Also replace `configure()` calls that change delivery. Or disable isolation explicitly.
3. Supply a stable security-context ID if you need offline replay after a page reload. The default isolation policy parks legacy untagged batches. Disable isolation only if you intend to send them with the current credentials.
4. Register child frames before they start. Grant journey and sampling permissions where necessary. Or select origin-based discovery explicitly.
5. Examine redactors and processors for console-only calls. Upgrade all frames and federated copies together. The bus envelope tag is now `ui-observability/2`. A frame before 0.9.5 and an owner on 0.9.5 or later ignore each other. A same-origin child frame calls the parent runtime directly, with no envelope. A same-origin `srcdoc` frame and an `about:blank` frame also use the direct call. Their `location.origin` is `"null"`. They give the parent runtime the value of their `origin` global instead. A `srcdoc` or `about:blank` frame on 0.12 or older gives `"null"`. The parent runtime refuses its direct call. That frame becomes a sender, and only its own `redact` applies. Before a direct call, a frame compares the bus protocol tag of the parent runtime with its own tag. A parent runtime from 0.9.5 to 0.12 has no tag field. Those versions use the tag `ui-observability/2`. Their child frame uses the direct call. With a different tag, the frame reports `bus.protocol_mismatch` and tries a message link. A parent runtime before 0.9.5 has an older tag. Its child frame also reports `bus.protocol_mismatch`. A message link connects the two contexts only when their envelope tags are the same. If it does not connect them, the frame becomes a sender. Only its own `redact` then applies to its records.
6. Set cache and bus budgets for the workload of the application. Then lock configuration if the shell owns it.
7. Update each backend query that filters by OTLP scope name. Logs and spans now use the logger namespace as the scope name. Each span record has the namespace `uiobs.traces`. Metrics keep the library scope.

## Operational budgets

These controls are application policy, not fixed SDK constants. A partial update keeps the current values. An invalid value reports `config.invalid`. The previous valid value stays. Numeric values must be safe nonnegative integers. Durations are in milliseconds. They cannot be more than the platform timer limit (2,147,483,647). Concurrency and request timeouts must be at least 1. `delivery.priority` is `"low"`, `"auto"` or `"high"`. It sets the fetch priority of each batch request. With `"low"`, the requests of the app go first. The exit flush and a keepalive send from a hidden page use the browser default. Breadcrumb capacity is at most 1,000,000. A larger value gives an invalid array allocation.

```ts
configure({
  delivery: {
    requestTimeoutMs: 15000,
    maxConcurrentRequests: 2,
    retryBaseDelayMs: 2000,
    retryMaxDelayMs: 60000,
    priority: "low",
  },
  buffering: {
    maxPendingRecords: 10000,
    maxPendingBytes: 16777216,
    maxHeldRecords: 500,
    overflow: "drop-oldest",
  },
  metrics: {
    intervalMs: 10000,
    maxSeries: 100,
    maxInstruments: 1000,
    maxHistogramBoundaries: 50,
  },
  correlation: {
    sessionIdleMs: 1800000,
    traceMaxAgeMs: 300000,
  },
  diagnostics: { throttleMs: 1000, consoleFallback: false },
  storage: { namespace: "orders-production" },
  metadata: { pageUrl: true, userAgent: true, openfin: true },
  sampling: { errorCeiling: 500, errorCeilingWindowMs: 10000 },
  captureLimits: {
    breadcrumbs: 50,
    errorDedupeMs: 5000,
    errorsPerWindow: 20,
    consolePerWindow: 20,
    longFramesPerWindow: 20,
    webSocketPerWindow: 20,
    reportsPerWindow: 20,
    resourcesPerWindow: 100,
    lifecyclePerWindow: 20,
    windowMs: 10000,
  },
});
```

The example shows the defaults. The storage namespace is specific to the application. Correlation settings and the `storage` section are startup settings. Use `shutdown()` and `configure()` to change them. The owning subsystems read the other budgets at runtime. A request in progress keeps its deadline. A lower buffer budget applies at the next admission. A lower metric cardinality budget applies to new instruments and series in the current interval. It applies to all series in the next interval. It does not delete measurements already aggregated.

Some limits are fixed SDK constants, not config keys. The idle retry engine checks the stored batches each 30000 ms. One drain pass sends at most 20 batches. The SDK writes the session activity at most one time each 60000 ms. The bus tracks at most 256 named sources, for example OpenFin identities. The error capture keeps at most 200 error signatures. An old key for one of these limits reports `config.invalid`, for example `The library ignores the unknown config key "delivery.retryIdleDelayMs". Check the spelling.`

On a limit key, `null` sets no limit. `0` sets a limit of zero, so the SDK allows nothing. For example, `errorsPerWindow: 0` captures no error. `sampling.errorCeiling: 0` drops each log record at or above `sampling.alwaysSampleFrom`. `metrics.maxSeries: 0` puts each value in the overflow series. `metrics.maxInstruments: 0` drops each metric value. `metrics.maxHistogramBoundaries` limits only the boundaries that the app gives to `histogram()`. A histogram without boundaries uses the default list at each limit, and it reports nothing. With `0`, the SDK refuses each list from the app and uses the default list.

Some limit keys do not accept `0`, because zero stops the feature or ends it at once. These keys are `buffering.maxPendingRecords`, `buffering.maxPendingBytes`, `correlation.sessionIdleMs`, `correlation.traceMaxAgeMs`, `debugBuffer.maxAgeMs` and the three `bus` limits. For these keys, `0` reports `config.invalid`. The current value stays. `captureLimits.windowMs`, `sampling.errorCeilingWindowMs` and `replay.uploadWindowMs` must be 1 or more, and they do not accept `null`. To turn the capture rate limits off, set each limit of the window to `null`.

`breadcrumbs: 0` disables breadcrumb storage. `errorDedupeMs: 0` reports each error. `throttleMs: 0` emits each diagnostic event. A retry delay of zero requests an immediate retry. The maximum delay must be at least the base delay. The SDK checks session idle expiration when it reads the persisted identity. It is not a background logout timer. `traceMaxAgeMs` counts from the start of the ambient trace, not from the last record. After that time, the next record gets a new trace.

Buffering budgets include buffered records and queued or in-flight pipeline records. The SDK measures each record by its encoded JSON size. These are accounting limits. They do not measure JavaScript heap use. `drop-oldest` removes buffered groups or batches that the SDK did not dispatch. It cannot stop an in-flight request. A record larger than `maxPendingBytes` never fits. The SDK drops that record only. `drop-newest` refuses the incoming record. `persist` writes an overflow record directly to storage. It does not add the record to the delivery queue. Only one overflow storage operation can be in progress. The SDK drops more overflow until that operation completes. That operation can keep one record more than the queue budget, even if storage stalls. The normal retention and quota settings of storage still apply. `onDrop` reports capacity drops with `buffer_full`.

`buffering.maxHeldRecords` is a separate limit. It applies to each hold buffer, which keeps the records that arrive before startup ends or while the sender loads. It counts the records that are not actions. The range is 200 to 10000, and zero is not valid. A full hold buffer keeps its first 100 records of each kind. It drops the oldest record after them. `buffering.overflow` does not apply to a hold buffer. A later `configure()` can change the value. A lower value does not remove records that the buffer already holds.

Metric cardinality has a limit for each collection interval. The SDK adds extra attribute sets to the `otel.metric.overflow` series. The totals stay correct. The SDK drops measurements for instrument names after `maxInstruments`. It counts them as `record.dropped_by_ceiling`. Histogram budgets limit the number of boundaries that the caller supplies. An invalid list uses the default boundaries of the SDK. The SDK does not sample aggregate metric points.

The diagnostics fallback is off by default. When it is on, it prints a fixed message. It never prints the exception, its message or its stack. The SDK still counts the failure under `handler.threw`. An application that needs the exception details can catch errors in its own diagnostic handler.

`diagnostics.records: true` also sends each reported diagnostic as a record. A list of codes, for example `["transport.http_error", "storage.quota_exceeded"]`, sends only those codes. The records have the namespace `uiobs.diagnostics` and the type `system`. A fault has the level `WARN`. A normal event, for example `bus.role_resolved`, has the level `INFO`. The `throttleMs` interval of each code applies. A diagnostic that occurs while the SDK builds a diagnostic record gives no record. The record never contains the caught exception. A diagnostic of the first `configure()` gives no record, because the record builder does not exist yet. `onDiagnostic` still receives it. A rotation checks the settings of the next security context first. The record of a diagnostic from that check waits until the rotation ends. It then goes to the new context. `onDiagnostic` receives the diagnostic at once. If the rotation fails, or a later rotation waits, the SDK drops that record and counts `record.dropped_during_rotation`. The SDK drops the record of each other diagnostic during a rotation, because its detail can hold data of the old context. In a record, the `url` and `endpoint` detail fields have no query and no fragment. `onDiagnostic` keeps the full values.

### Debug buffer

`debugBuffer.enabled: true` keeps the records that `minLevel` or sampling drops. When this context sends an ERROR or FATAL record, it first sends the kept records. Each kept record has `uiobs.debug_buffer: true`. Then the buffer is empty.

The SDK builds each kept record at the time of the log call. The record has the time, trace and context of that call. The processors and `redact` run at once. A record that they drop is not kept. Each logger call below `minLevel` then costs a full record build. `debugBuffer.maxRecords` limits the memory, and `debugBuffer.maxAgeMs` drops old records when the library reads them. A new session, a rotation and a change of `redact` or `processors` empty the buffer. A kept record has only the hooks of its log call. Turning the buffer off empties it at its next read. Each frame and worker keeps its own buffer. The owner of a frame does not sample a forwarded kept record again.

### Profiler

`profiler.enabled: true` turns on the probes of `profiler.probe()`. The SDK sends one point for each probe with data at each interval of `metrics.intervalMs`. The meter and the profiler keep separate timers with the same interval. A later `configure()` change applies from the next interval. It also sends the open interval at `flush()`, at `shutdown()`, at `newSession()`, before the exit flush and when `configure()` turns the profiler off. A rotation closes the open interval as records of the old context. `profiler.maxProbes` is a startup setting. A later change reports `config.invalid`. The startup value stays. With isolation, the values of a rotation and each span that is open at its end add no value. During a rotation, `shutdown()` and the exit flush do not send the open interval. When its owner changes its identity, a forwarder drops the profiler data of its open interval. `profiler.framePhases: true` observes the long animation frames. It adds their phases to each probe with a span of 1 ms or more in the frame, as `ui.profile.frame.duration`. `captureLimits.longFramesPerWindow` limits these frames in each window. `profiler.framePacing: true` runs one frame callback for each frame and records the frame intervals with the probe `frame.interval`. Both need `profiler.enabled`. Both load as one separate chunk. A change of each flag in `configure()` installs or removes its observer.

### Session replay

`replay.enabled: true` loads the session replay chunk and starts the recorder of `replay.loader`. It needs `replay.endpoint` or `replay.onSegment`. Without them, the SDK reports `config.invalid` and records nothing.

| Key | Default | Range or values | Use |
| --- | --- | --- | --- |
| `enabled` | `false` | boolean | Turns the replay on. |
| `mode` | `"onError"` | `"onError"` | An ERROR or FATAL record starts an upload. |
| `endpoint` | `null` | URL string or `null` | URL of the replay endpoint. `null` turns it off. `""` also turns it off and reports `config.invalid`. |
| `requireConsent` | `false` | boolean | Nothing records before `startReplay()`. |
| `bufferMs` | `60000` | 5000 to 600000 | Time before an error that the buffer keeps. |
| `maxBufferBytes` | `10000000` | 100000 to 200000000 | Size limit of the buffer, as the JSON length of its events. |
| `afterErrorMs` | `5000` | 0 to 600000 | Time after an error that the SDK continues to send events. |
| `uploadsPerWindow` | `3` | 0 or more, or `null` | Uploads in each window of `uploadWindowMs`. `0` sends none. `null` sets no limit. |
| `uploadWindowMs` | `10000` | 1 or more | Length of the upload window, in milliseconds. |
| `maxSegmentEvents` | `200` | 1 to 10000 | Events in one segment. |
| `maxSegmentBytes` | `512000` | 10000 to 10000000 | Size of one segment, as the JSON length of its events. |
| `flushIntervalMs` | `2000` | 100 to 60000 | Wait of a partial segment. |
| `maxQueueBytes` | `20000000` | 100000 to 200000000 | Size limit of the segments that wait for a send. |
| `maxAttempts` | `3` | 1 to 10 | Send attempts of one segment. |
| `maskText` | `true` | boolean | Masks each text, except in an element with `data-observability-unmask`. |
| `maskInputs` | `true` | boolean | Masks each input value. A password input is always masked. |
| `recordCanvas` | `false` | boolean | Records canvas elements. |
| `maskSelectors` | `[]` | list of CSS selectors | Text that is always masked. |
| `blockSelectors` | `[]` | list of CSS selectors | Elements that the recorder does not record. It also always blocks `[data-observability-ignore]`. |
| `loader` | `null` | function or `null` | Loads `@rrweb/record`. |
| `onSegment` | `null` | function or `null` | Gets each segment in place of the request. |
| `headers` | `null` | object of strings, function or `null` | Request headers for `endpoint`. The `headers` of the log endpoint do not go to it. |
| `plugins` | `[]` | list of functions | Makes the record plugins of the recorder. |
| `recordOptions` | `{}` | object | Other options of the recorder. Only the keys in the `replay.recordOptions` list of [Session replay](api.md#session-replay) go to the recorder. |

An invalid value reports `config.invalid`. The current value stays. The replay capture has its own install key. A change of another capture setting in `configure()`, or a remote capture switch, keeps the recorder, the buffer and the `replay.id`. A change of one of these values stops the recorder and starts it again with a new `replay.id`: `endpoint`, `requireConsent`, `mode`, `maskText`, `maskInputs`, `maskSelectors`, `blockSelectors`, `recordCanvas`, `bufferMs`, `capture.fullUrls` and `capture.ignoreUrls`. A new `loader` function, a new `onSegment` function, a new `recordOptions` object or a new function in `plugins` also does this. Keep these references stable. The buffer and the segments that wait are then dropped. Thus an event that was recorded with an old mask does not stay, and no event goes to an endpoint that it was not recorded for. A change of the log `endpoint` changes `capture.ignoreUrls`. These `replay` values apply to the recorder that runs: `maxBufferBytes`, `afterErrorMs`, `uploadsPerWindow`, `uploadWindowMs`, `maxSegmentEvents`, `maxSegmentBytes`, `flushIntervalMs`, `maxQueueBytes`, `maxAttempts` and `headers`. A change of only `headers` keeps the buffer and the segments that wait, so a new token does not drop them. A replay that could not start for a missing `loader`, `endpoint` or `onSegment` starts when a later `configure()` adds the missing value. While the replay is off, a change of a `replay` value starts no new install of the captures. `newSession()` and `rotateSecurityContext()` drop the buffer and start a new recording. `stopReplay()` stays in force until `startReplay()`. `shutdown()` stops the recorder. `enabled: false` stops the recorder and drops the buffer. `enabled: true` then starts a new recording. The replay runs in each document that turns it on. It does not use the bus. The SDK keeps no segment in storage, and the exit flush sends no segment.

### Debug bundle

`collectDebugBundle()` collects the state of the library for a support ticket. It returns a JSON-safe object. The SDK does not send it. Your app decides where to send it.

- It has the SDK version, the health, the diagnostic counters, the resource attributes and the page URL.
- It has the breadcrumbs. The processors and `redact` process them, as in an error record.
- It has the records of the debug buffer. The privacy hooks processed them at the time of the log call.
- It has a summary of the config. The summary has no `headers`. Each URL has no user info, query or fragment. A function, a plugin and a custom serializer show only their names.
- Its own fields do not have the values of `setContext()` or `contextProvider`. A record of the debug buffer keeps its context attributes, as a sent record does. Use `redact` to remove them.

### Storage and deletion

`storage.backend` selects the store. The `storage` section is fixed at startup. A later change reports `config.invalid` with the text `storage cannot change after startup. The library keeps the current settings.` `storage.namespace` separates IndexedDB database names, localStorage keys, emergency queues and the retry lock names. Two applications on one origin then do not wait for each other. The empty default namespace keeps the previous storage location. A namespace change does not move old data. A stable security-context ID is still necessary to resume a context after a reload. IndexedDB schema version 12 adds a compound context and time index. The upgrade also adds it to a database that has batches. With isolation on, legacy untagged entries stay parked.

```ts
// Active security context in this application's namespace.
await shutdown({ pending: "discard", clearStorage: "context" });
// All contexts in this namespace, including parked data.
await shutdown({ pending: "discard", clearStorage: "namespace" });
```

Under storage pressure, a browser can delete the stored batches of a page. `storage.requestPersistent: true` asks the browser to keep them. The SDK calls `navigator.storage.persist()` one time when it opens IndexedDB or localStorage storage. Firefox can show a permission prompt. Chrome decides without a prompt. `getHealth()` gives the state in `storagePersistence`. The values are `off`, `pending`, `granted`, `denied` and `unsupported`. The option takes effect at startup.

Deletion stops the runtime first, with no send. `onDrop` reports each record in memory with `discarded`. Then the SDK removes the normal and emergency queues, the stored session id, the tab id and the journey. It also works in console-only mode. A request in flight cannot store its batch after the deletion. Deletion applies only to the configured namespace. It does not cancel application requests. Before the first `configure()` call that works, deletion removes nothing. With isolation off, contexts share their stored batches. Then `clearStorage: "context"` and a `discard` rotation remove the stored batches of each context in the namespace, also of other open tabs. Applications that use the empty namespace share its retention and deletion scope.

### URL and resource-field policy

`metadata.userAgent` and `metadata.openfin` control those resource fields. `metadata.clockOffset` controls `uiobs.clock_offset_ms` on logs and spans. With `metadata.pageUrl: false`, the reserved `page.url` attribute is empty. The application controls the attributes and message strings that it supplies. They can also go through `redact`.

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

### Temporary capture switches

`sampling.remote: true` permits trusted sampling answers to carry boolean capture switches. Only names in `capture.remoteToggles` apply. The default list is empty. The SDK keeps the local config intact. Each remote update replaces the previous update. A timer restores local capture settings at TTL expiry. A rotation or remote sampling disable also restores them. A forwarder ends the rules when its owner changes identity.

The server cannot change privacy controls, capture options, plugins, ignored URLs or trace propagation targets. A remote switch that turns on a capture with a local options object keeps that object. A capture that is `false` locally gets its default options. For `webVitals`, the defaults have no loader, so only the navigation timing runs. Each forwarder validates the rules and applies its own allowlist. Its sampling permission and upstream authority checks stay in force.

`capture.reports` always strips report URL queries, fragments and credentials. It does not apply `fullUrls` or `urlTransform` to those URLs. Other resource URLs keep the ordinary URL policy. Server-Timing descriptions come from the response server. Use the privacy hooks to remove data that the server puts in them.

### Deferred record builds

`payloadMode: "defer"` moves payload reads, processors and redaction to idle time. Each call keeps its timestamp, trace, journey and a shallow copy of ambient context. The payload, error reason, scoped context and `contextProvider` values reflect build time. The default `"copy"` builds at the call.

Each runtime holds at most 1000 pending calls. A lower `buffering.maxPendingRecords` lowers this cap. `buffering.maxPendingRecords: null` keeps the 1000-call cap. The cap applies before records exist. A full queue builds its pending calls before it takes another reference. That build runs inside the log call that finds the queue full. That call builds up to 1000 records before it returns. A hook cannot add more calls to a full draining queue. Those calls increment `record.dropped_by_ceiling`.

Idle callbacks respect the remaining idle time. After 1000 ms, a callback can build one record without idle time. A timer supports a browser without the idle API. Explicit flush, shutdown, page exit, reconfiguration and identity changes drain the pending calls. A stopped runtime releases the references that a hook adds during shutdown.

Delivery stats and byte budgets count built records. The deferred queue has a separate count cap. `onDrop` still reports only records that the library builds. `debugBuffer.enabled` keeps immediate builds and privacy hooks, regardless of `payloadMode`.

### Transport workers

`transportWorker` is a delivery setting. The app supplies a factory for a fresh dedicated worker. That worker calls `serveTransportWorker()`. The library terminates the worker when its sender stops. A custom transport takes precedence. With a custom serializer, the log batches use the main HTTP path. The metric and span batches still use the worker.

Record construction, processors, redaction, queue accounting, retry and storage stay on the main thread. Header functions also stay there. Built-in OTLP and ECS encoding, gzip and HTTP delivery run in the worker. Hidden-page keepalive sends and exit sends stay on the main thread. Both paths share the header cache.

Each connection uses a private transferred port and the exact SDK version. The worker accepts one connection. It limits active jobs to 64. The main request deadline covers all steps. The main thread waits 1 second more for the answer of a ready worker. The worker can then send a status that it got before the deadline. Worker startup failures or channel failures during a send select HTTP fallback for that sender. A worker that does not connect before the request deadline is a startup failure. A worker module that does not load also selects HTTP. Timeouts and network failures use the normal retry policy. An offline failure uses no stored attempt.

Set the factory before the delivery stack loads. `configure()` cannot add or remove it after that point, also with isolation off. With isolation off, a new factory closes the old channel before the next worker request. Use `rotateSecurityContext()` for normal routing changes. An omitted factory in the new routing settings resets to the main HTTP path.

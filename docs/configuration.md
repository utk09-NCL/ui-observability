# Configuration Options

This document gives each key of `configure()`, its default and its rules. [API Reference](api.md) gives each function.

Set `endpoint` and `serviceName` in the first `configure()`. Without them, the library reports `config.invalid`. Set `endpoint: null` for console-only mode. A value of the wrong type or outside its range reports `config.invalid`. The current value stays. Level names can have any case. You cannot change `batching` and `retention` after the delivery stack loads. The first `configure()` call that works sets `limits`, `journey.maxAgeMs`, `profiler.maxProbes`, `correlation`, `identity`, `storage`, `bus.mode` and `bus.openFinRole`. This is also true after an early log call. A later change of these settings reports `config.invalid`. A key that the library does not know reports `config.invalid`, for example `The library ignores the unknown config key "delivery.batchesPerDrain". Check the spelling.` [Runtime policies](runtime-policies.md) gives each default and range of the policy sections.

Each `configure()` call merges its keys into the current settings. These rules apply to each key at each depth.

- An omitted key keeps its current value. A key with the value `undefined` also keeps its current value. Thus an unset environment variable cannot remove `redact`.
- `null` removes a hook, for example `redact`, `onDrop` or `transport`. `null` also removes the `headers`.
- A `redact` value that is not a function keeps the current hook. Without a current hook, the library drops each record until `redact` is a function or `null`.
- `null` turns off an endpoint. This applies to `endpoint`, `metricsEndpoint`, `tracesEndpoint` and `replay.endpoint`. On the last three keys, an empty or blank string also turns the endpoint off and reports `config.invalid`. On `endpoint`, an empty string is the same as a missing endpoint. A blank `endpoint` reports `config.invalid`, and the current value stays.
- A relative endpoint URL resolves against `document.baseURI`, or against `location.href` without a document. The library keeps the absolute URL and reports the origin that receives the records. This report has the code `config.invalid`, but the endpoint works. An endpoint URL with a user name or a password reports `config.invalid`, and the current value stays.
- A `processors` list with an entry that is not a function keeps the current list. Without a current list, the library drops each record until `processors` is a list of functions or `[]`.
- If the first `configure()` call cannot read its options, for example because a getter throws, the library writes a warning to the console. It installs no capture and drops each record until a `configure()` call sets `redact` to a function or to `null`. A call that leaves out `redact` does not end this state, because the library cannot know which `redact` the app meant. A later call that fails keeps the current settings. `configure()` never throws.
- On a limit key, `null` sets no limit. `0` sets a limit of zero, so the library allows nothing. Some limit keys do not accept `0`, because zero stops the feature.
- `null` on a key that does not accept `null` reports `config.invalid`. The current value stays.
- Some settings need another setting. For example, `transportOnExit` needs `transport`. A call that sets one of them without the other reports `config.invalid`. The values stay.

| Key | Default | Description |
| --- | --- | --- |
| `endpoint` | Unset | HTTP endpoint that receives the batches. `null` selects console-only mode. A missing endpoint or `""` reports `config.invalid`. A relative URL resolves against the page and works. It also reports `config.invalid` with the origin that receives the records. A URL with a user name or a password is refused. Without `transport`, `configure()` cannot remove the endpoint after the delivery stack loads. |
| `metricsEndpoint` | `null` | OTLP metrics endpoint, for example `https://ingest.example/v1/metrics`. With it, each batch of metric records goes there as an OTLP `ExportMetricsServiceRequest`. Without it, metric records are log records on `endpoint`. It works with each `serializer`, because metric batches always use OTLP. It needs `endpoint` or `transport`. `null` turns it off. `""` also turns it off and reports `config.invalid`. |
| `tracesEndpoint` | `null` | OTLP traces endpoint, for example `https://ingest.example/v1/traces`. With it, the library records spans and sends them there as an OTLP `ExportTraceServiceRequest`. Without it, the library sends no span. It works with each `serializer`, because span batches always use OTLP. It needs `endpoint` or `transport`. `null` turns it off. `""` also turns it off and reports `config.invalid`. See [Spans](#spans). |
| `serviceName` | `""` | `service.name` on every record. Without it, the library reports `config.invalid`. Each record then has the value `unknown-service`. |
| `serviceVersion` | `""` | `service.version` on every record. |
| `environment` | `""` | `deployment.environment` on every record. |
| `enabled` | `true` | Set `false` to pause the library at any time, also in the first `configure()`. Log calls then do nothing. The pause first sends the open interval of the counters, histograms and probes. During the pause, they record nothing. The library removes its captures, the replay recorder and its network patches. It then adds no trace header. The sender sends nothing. The pause stores no new record. Storage still changes in four cases. A request in flight at the pause fails and stores its batch. A sender load that ends during the pause moves the emergency queue into storage. A `retain` rotation stores the waiting records under the old context. A `discard` or `flush` rotation removes the stored batches of the old context. The records from before the pause stay in memory or in storage. They go out after `enabled: true`. The bus of a running runtime stays connected. A paused forwarder drops the records of its child contexts. `onDrop` reports `disabled` for a record that a child context forwards during the pause. It also reports `disabled` for the records in memory at a `pagehide` or a `shutdown()` during the pause. A `shutdown()` with `pending: "discard"` or `clearStorage` reports them with `discarded`. If the first `configure()` sets `false`, `onDrop` reports the held records with `disabled`. The runtime then starts at the first `enabled: true`, with the startup settings of the first call. `getHealth().status` is `"disabled"` during the pause. |
| `payloadMode` | `"copy"` | `"defer"` keeps payload references until idle time. The debug buffer always builds records at the call. |
| `minLevel` | `"INFO"` | Lowest level that the library sends (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`). It does not drop actions and metrics. |
| `minLevels` | `{}` | Lowest level for each namespace prefix, for example `{ "trading.ticks": "DEBUG" }`. The longest matching prefix wins. A prefix matches its own namespace and the namespaces below it after a dot. A namespace with no match uses `minLevel`. A new map replaces the current map. |
| `compression` | `"gzip"` | `gzip` or `none`. The library compresses only a payload of 1 KiB or more. |
| `serializer` | `"otlp"` | `otlp`, `ecs`, or a custom `LogSerializer`. `ecs` writes ECS 8.10 NDJSON. It maps `app.namespace` to `log.logger`, `error.type`, `error.message` and `error.stack_trace` to `error.*`, and `log.type` to `event.kind`. The other attributes go to `labels`. The serializer formats each batch for `endpoint`. A batch for `metricsEndpoint` or `tracesEndpoint` always uses OTLP. The library drops a batch that the server refuses with `400`. A custom serializer must keep each record within the limits of the server. |
| `credentials` | `"omit"` | Fetch credentials mode. Set `"include"` for cookie auth. The exit flush uses `sendBeacon` only with `"include"`, because a beacon always sends the cookies. With the other values, it uses a keepalive `fetch` that obeys `credentials`. |
| `headers` | Unset | Static headers, or a function that returns them. After a 401 or 403, a function gets one more call and the batch one more send. The exit flush sends the last headers. Before a function gives its first result, the exit flush puts the batch in the emergency queue. `headers: undefined` keeps the headers, also the token. With isolation on, which is the default, use `rotateSecurityContext()` at logout. `configure({ headers: null })` is then a refused change. With isolation off, `headers: null` removes the headers. |
| `storage.backend` | `"auto"` | Store for undelivered batches: `auto`, `indexeddb`, `localstorage`, `memory` or `none`. The `storage` section is fixed at startup. A string, for example `storage: "memory"`, reports `config.invalid`, and the current values stay. |
| `storage.namespace` | `""` | Separates the batch stores, the emergency queue and the retry locks of one application. |
| `storage.requestPersistent` | `false` | Asks the browser to keep the stored batches under storage pressure. Firefox can show a prompt. `getHealth().storagePersistence` reports the answer. |
| `identity` | `"storage"` | Store for session, tab and journey ids. `memory` writes no key. Fixed at startup. |
| `sampling.defaultRate` | `1` | Keep rate for a namespace with no rule. |
| `sampling.rates` | `{}` | Keep rate per namespace. The longest matching prefix wins. A new map replaces the current map. A rate outside 0 to 1 removes its entry, and a shorter prefix or `defaultRate` applies. |
| `sampling.alwaysSampleTypes` | `["action"]` | Record types that ignore the rate: `action`, `event`, `metric`, `log`, `system` or `span`. An unknown type reports `config.invalid`. |
| `sampling.alwaysSampleFrom` | `"ERROR"` | Lowest level that ignores the rate. `sampling.errorCeiling` limits these log records. |
| `sampling.errorCeiling` | `500` | Maximum log records at or above `sampling.alwaysSampleFrom` in each window of `sampling.errorCeilingWindowMs`. Metric points and spans do not count. `0` drops each one. `null` sets no limit. |
| `sampling.errorCeilingWindowMs` | `10000` | Length of the error ceiling window, in milliseconds. The value is 1 or more. |
| `sampling.remote` | `false` | Reads sampling rules from the `X-UiObs-Sampling` header of each accepted batch (see [Remote Sampling](guides.md#remote-sampling)). |
| `sampling.remoteMaxRate` | `1` | Highest rate that a remote rule can set. It applies to the remote `defaultRate` and to each remote namespace rate. |
| `bus.mode` | `"auto"` | `auto`, `sender`, `forwarder` or `off`. With `off`, this context sends its own records and opens no link. A same-origin child frame that the page registers can still forward to it. Fixed at startup. |
| `bus.trustedOrigins` | `[]` | Origins of other documents that this document trusts. A cross-origin child frame forwards its records only to a parent on these origins. With `bus.sourcePolicy: "trusted-origin"`, a parent also accepts records from a child frame on these origins. With the default policy, use `registerFrame()`. The library keeps the origin of each URL. For a sandboxed frame, set `bus.mode: "sender"` in the frame. A trusted origin is also trusted for metric points. Its points bypass the sampling and the limit of 100 attribute sets of this document. A new entry does not reconnect a parent link that already exists. The parent link checks the parent origin one time, when the bus starts. |
| `bus.sourcePolicy` | `"registered"` | `registered` accepts only the frames and workers that the page registers. `trusted-origin` also accepts each frame on the page origin or in `bus.trustedOrigins`. |
| `bus.maxMessageBytes`, `bus.maxRecordsPerMessage`, `bus.maxMessagesPerSecond` | `262144`, `100`, `100` | Bus budgets for each message and each source. Each value is 1 or more. `null` turns a limit off. The bus always checks the fields of each record and each control message. |
| `bus.openFinRole` | `"auto"` | `auto`, `provider` or `client`. Fixed at startup. |
| `journey.scope` | `"auto"` | Which contexts adopt a journey. `context`: each context keeps its own. `tab`: a frame or a worker adopts the journey of its owner. `origin`: each context of the origin, also in other tabs. `auto` is `origin` in OpenFin and `tab` in a browser. |
| `journey.maxAgeMs` | `1800000` | Maximum open time of a journey, in milliseconds. Then the library ends it. The range is 60000 to 86400000. |
| `batching.logFlushIntervalMs` | `2000` | Maximum wait of a partial log or span batch, in milliseconds. The range is 100 to 60000. |
| `batching.logBatchSize` | `100` | Maximum records in one live log or span batch. The range is 1 to 1000. An exit batch can hold more records (see [Page Exit](delivery-guarantees.md#page-exit)). |
| `batching.metricBatchSize` | `500` | Maximum records in one metric batch. The range is 1 to 1000. |
| `retention.maxBatches` | `500` | Maximum stored batches. A new batch evicts the oldest batch without an action first. The range is 1 to 5000. |
| `retention.maxAgeMs` | `86400000` | Maximum age of a stored batch, in milliseconds. The range is 60000 to 604800000. `null` sets no age limit. |
| `retention.maxAttempts` | `5` | Maximum send attempts of a stored batch. The range is 1 to 20. `null` sets no attempt limit. With `maxAgeMs: null` and `maxAttempts: null`, a stored batch stays until the library delivers it. `retention.maxBatches` still applies. A permanent error still drops the batch. A batch that always gets a temporary error stays first. The batches of the same endpoint behind it wait. |
| `limits.maxBodyChars` | `4096` | Maximum body length, in characters. The range is 256 to 65536. |
| `limits.maxAttributeChars` | `8192` | Maximum length of a string attribute, in characters. The range is 256 to 65536. |
| `limits.maxAttributeCount` | `128` | Maximum keys in one object. The range is 1 to 1024. |
| `limits.maxStackChars` | `8192` | Maximum length of an error stack, in characters. The range is 256 to 65536. |
| `limits.maxDepth` | `6` | Maximum depth of a nested value. The range is 1 to 16. |
| `limits.maxArrayLength` | `100` | Maximum items in one array, set or map. The range is 1 to 10000. |
| `limits.maxNodes` | `10000` | Maximum values in one sanitize pass. The range is 100 to 100000. |
| `limits.maxRecordBytes` | `32768` | Maximum attribute bytes of one record. Above it, the library drops the caller attributes. The range is 1024 to 60000. |
| `securityContext.id` | Generated | Delivery identity of this runtime. Supply a stable opaque id to send stored batches after a reload. Do not put secrets or personal data in it. |
| `securityContext.isolation` | `true` | Keeps the stored batches of each identity apart. Delivery changes then need `rotateSecurityContext()`. |
| `lockConfiguration` | `false` | Refuses changes through `configure()`. Identical repeated settings are accepted. `setConfigurationLocked(false)` unlocks. |
| `loggerCache.maxEntries` | `256` | LRU limit of cached loggers. `0` turns the cache off. `null` sets no limit. |
| `delivery` | See policies | Request timeout, request concurrency, retry delays and fetch priority (`"low"` by default). |
| `buffering` | 10,000 records, 16 MiB, `"drop-oldest"` | Limits of the live buffers, and the overflow rule. |
| `buffering.maxHeldRecords` | `500` | Maximum records other than actions in one hold buffer. A hold buffer keeps the records that arrive before startup ends, or while the sender loads. A full hold buffer keeps its first 100 records of each kind. It drops the oldest record after them. `onDrop` reports `buffer_full`. A lower value removes no held record. The range is 200 to 10000. |
| `debugBuffer` | `{ enabled: false, maxRecords: 200, maxAgeMs: 60000 }` | Keeps the records that `minLevel` or sampling drops. An ERROR or FATAL record of this context sends them first, with `uiobs.debug_buffer: true`. A later change of `redact` or `processors` empties the buffer. |
| `profiler` | `{ enabled: false, maxProbes: 64, framePhases: false, framePacing: false }` | Times code spans with probes. The library sends one histogram summary record for each probe at each interval of `metrics.intervalMs`. The range of `maxProbes` is 1 to 1024. `maxProbes` is fixed at startup. `framePhases` adds the phases of each long animation frame to the probes in that frame. `framePacing` measures the time between two frames. See [Profiler](api.md#profiler). |
| `replay` | `{ enabled: false, mode: "onError", bufferMs: 60000, maxBufferBytes: 10000000, afterErrorMs: 5000, uploadWindowMs: 10000, maxSegmentEvents: 200, maxSegmentBytes: 512000, flushIntervalMs: 2000, maskText: true, maskInputs: true, ... }` | Records the DOM with the recorder of your app and sends the recent events in segments after an error. It needs `loader`, and `endpoint` or `onSegment`. See [Session replay](api.md#session-replay) and [Runtime policies](runtime-policies.md) for each key and range. |
| `metrics.intervalMs` | `10000` | Interval of counters, histograms and profiler probes, in milliseconds. A partial metric batch also waits this long. The range is 1000 to 600000. A change applies from the next interval. |
| `metrics` | See policies | Limits of instrument names, attribute sets and histogram boundaries. |
| `correlation` | See policies | Session idle time and trace age. Fixed at startup. |
| `captureLimits` | See policies | Breadcrumb capacity, error duplicate check and capture rate limits. |
| `diagnostics` | `{ throttleMs: 1000, consoleFallback: false, records: false }` | Report interval of each diagnostic code, and the console fallback when `onDiagnostic` throws. `records: true`, or a list of codes, also sends each report as a record in the namespace `uiobs.diagnostics`. |
| `metadata` | All `true` | `pageUrl`, `userAgent` and `openfin` include `page.url`, `browser.user_agent` and the OpenFin fields. `clockOffset` adds `uiobs.clock_offset_ms` to logs and spans. |
| `capture` | See below | Auto-capture settings. |
| `capture.remoteToggles` | `[]` | Capture switches that remote rules can change for their TTL. Requires `sampling.remote`. Without it, the library reports `config.invalid`. Privacy controls stay local. |
| `capture.serverTiming` | `false` | Adds Server-Timing response entries to fetch and XHR records. Links a valid traceparent entry to the client span. |
| `capture.reports` | `false` | Records deprecations, interventions and CSP reports as WARN `ui.report`. |
| `capture.resourceTiming` | `false` | Records `ui.resource.duration` by initiator type and host. Accepts `true` or an object with `slowMs`. |
| `capture.resourceTiming.slowMs` | `1000` | Minimum duration of a `ui.resource.slow` event, in milliseconds. Set `0` for no slow events. |
| `capture.lifecycle` | `false` | Records visible, hidden, frozen, resumed and restored states with the duration of the previous state. |
| `captureLimits.reportsPerWindow` | `20` | Maximum browser reports in each capture window. Set `0` to capture none, or `null` for no limit. |
| `captureLimits.resourcesPerWindow` | `100` | Maximum resource entries in each capture window. Set `0` to capture none, or `null` for no limit. |
| `captureLimits.lifecyclePerWindow` | `20` | Maximum lifecycle events in each capture window. Set `0` to capture none, or `null` for no limit. |
| `captureLimits.windowMs` | `10000` | Length of the capture window, in milliseconds. The value is 1 or more. It applies only to the capture rate limits. |
| `consoleOutput` | `false` | Prints records to devtools. `true` prints from `DEBUG` up. A level name prints from that level up. An object sets `level` and `styles` (see [Console Output](guides.md#console-output)). An object without `level` keeps the current level. It does not depend on `minLevel`. |
| `transport(request)` | `undefined` | Sends batches through a channel of your app in place of HTTP (see [Custom Transport](guides.md#custom-transport)). |
| `transportWorker()` | `undefined` | Creates a dedicated HTTP worker. It calls `serveTransportWorker()`. Retry, storage, header functions and exit sends stay on the main thread. With `transport`, the library does not start the worker and reports `config.invalid`. |
| `transportOnExit(request)` | `undefined` | Sends the last batch while the page closes. It must return a boolean and must not wait. It needs `transport`. Without it, the library reports `config.invalid`. |
| `otelLoader()` | `undefined` | Loads `@opentelemetry/api`. Without it, OTel is off. |
| `contextProvider()` | `undefined` | Returns attributes for each built record, including console/breadcrumb-only candidates, for example the current route. Its values override `setContext()` values. The logger scope and the call payload override its values. Keep it fast and synchronous. A provider that throws reports `handler.threw`. A value that is not an object reports `config.invalid`. The record is still built. |
| `processors` | `[]` | Functions that change or drop a record. They run in list order, before `redact`. A processor has the contract of `redact`. Return the record or a new record to keep it, or `null` to drop it. If a processor throws or returns a value that is not a record, the library drops the record. It counts `record.dropped_by_processor`. A new list replaces the current list. A list with an entry that is not a function keeps the current list. Without a current list, the library drops each record until `processors` is a list of functions or `[]`. The processors do not run on a record from a frame or a worker. That record has the processors of its own context. Only `redact` runs on it again. |
| `redact(record)` | `undefined` | Changes a record before the library sends or prints it, including console-only candidates. Return `null` to drop the record. If the hook throws or returns a value that is not a record, the library drops the record. It counts `record.dropped_by_redact`. The sender also runs its `redact` on each record from a frame or a worker. A record that the child already redacted then runs through `redact` again. Write `redact` so that a second run gives the same result. A value that is not a function keeps the current hook. Without a current hook, the library drops each record until `redact` is a function or `null`. |
| `onDiagnostic(event)` | `undefined` | Receives the faults of the library itself. |
| `onDrop(summary)` | `undefined` | Receives a summary when the library loses records that it built. The summary has `reason`, `records`, `batchIds`, `journeyIds` and `actions`. The reasons are `buffer_full`, `expired`, `over_capacity`, `quota`, `max_attempts`, `rejected`, `partially_rejected`, `unserializable`, `exit_queue_full`, `load_failed`, `not_stored`, `security_context`, `disabled` and `discarded`. [Delivery guarantees](delivery-guarantees.md#losses) gives the cause of each reason. Sampling, `minLevel`, `processors` and `redact` do not cause a loss. Do not log through the library in the hook. A record from the hook can evict a stored batch. A batch that storage evicts during its send can still reach the server. |

## Deferred payloads

```ts
configure({ payloadMode: "defer" });
const payload = { status: "before" };
getLogger("orders").info("Order state", payload);
payload.status = "after";
```

With `defer`, the record sees `status: "after"` if the idle build runs after the assignment. With the default `copy`, it sees `"before"`. The queue keeps the payload reference without reading its fields. Error reasons and metric attributes also wait for the build. Console output and breadcrumbs wait with the record. A call below the level queues nothing unless the console uses it. Sampling checks use the current rules at build time.

The call keeps its timestamp, trace, journey and a shallow copy of the ambient context. The builder reads `contextProvider`, scoped context and payload fields at build time. Processors and `redact` also run at build time. The queue can hold raw values until then. Debug bundle output does not include those raw queued values.

`requestIdleCallback` builds records while idle time remains. A callback timeout of 1000 ms permits one build without idle time. A timer runs the build when the idle API is absent. `flush()`, shutdown and page exit build pending records first. Reconfiguration, session changes and delivery identity changes also drain pending calls first.

The queue holds at most 1000 calls for each runtime. A lower positive `buffering.maxPendingRecords` also lowers this cap. A full queue builds its calls before it accepts another payload reference. Calls from a hook wait for the next callback. Extra calls from a hook at the cap increment `record.dropped_by_ceiling`. The library does not build those calls.

The deferred cap is separate from the delivery buffer. Delivery byte budgets and stats apply to built records. With `debugBuffer.enabled`, the logger builds every record at the call, also with `payloadMode: "defer"`. This preserves the debug buffer's immediate privacy processing.

## Remote capture switches

```ts
configure({
  sampling: { remote: true },
  capture: { remoteToggles: ["fetch", "resourceTiming", "lifecycle"] },
});
```

```http
X-UiObs-Sampling: {"v":1,"ttlMs":60000,"capture":{"fetch":true,"lifecycle":false}}
```

The rules change only the switches in this context's `remoteToggles`. The empty default list permits no changes. Each switch is boolean. An invalid switch or a privacy control rejects the whole header. The allowed names are `errors`, `rejections`, `resourceErrors`, `fetch`, `xhr`, `httpMetrics`, `interactions`, `navigation`, `webVitals`, `longFrames`, `console`, `webSocket`, `uncleanExit`, `userTiming`, `serverTiming`, `reports`, `resourceTiming` and `lifecycle`.

A remote enable keeps the local options object of a capture, for example click privacy settings or console levels. A capture that is `false` locally gets its defaults. For `webVitals`, the defaults have no loader, so only the navigation timing runs. The server cannot change text capture, selectors, URL rules, trace propagation, plugins or thresholds. The library restores local settings when the TTL ends, remote sampling stops, or the delivery identity changes. The trusted sampling path also sends these rules to forwarders. Each forwarder applies its own allowlist.

## Auto-Capture Options

```ts
capture: {
  errors: true,          // Uncaught window.onerror exceptions (default: true)
  rejections: true,      // Unhandled promise rejections (default: true)
  resourceErrors: false, // <img>, <script>, <link> load failures
  fetch: false,          // window.fetch duration and status codes
  xhr: false,            // XMLHttpRequest duration and status codes
  httpMetrics: true,     // http.client.request.duration histogram of fetch and xhr requests, in seconds.
                         // Attributes: http.request.method, http.response.status_code, server.address, error.type
  interactions: false,   // Click action names. The object form sets actionAttribute, text, selector,
                         // ignoreSelector, maxTextChars and the rage and dead click options below
  navigation: false,     // Single-page navigation URL changes
  webVitals: false,      // Core Web Vitals (LCP, CLS, INP, FCP, TTFB). Object: { loader }
  longFrames: false,     // Frames that freeze the page, as ui.long_frame.duration.
                         // Object: { thresholdMs }, with default 100
  console: false,        // App console calls. true wraps error and warn.
                         // Object: { levels }, for example { levels: ["error", "warn", "info"] }
  fullUrls: false,       // Keep query strings and fragments on recorded URLs
  urlTransform: undefined, // Function that replaces the default URL rule
  ignoreUrls: [],        // URL patterns excluded from network capture
  propagateTraceHeaderTo: [], // Origins, or RegExp patterns, that receive traceparent
  webSocket: false,      // WebSocket open, close and error, and ui.websocket.messages
  uncleanExit: false,    // WARN ui.unclean_exit when the previous page of the tab did not close cleanly
  userTiming: false,     // performance.measure() as ui.user_timing.duration. A mark gives a breadcrumb.
                         // Object: { include }. The default [] records each name
  remoteToggles: [],     // Capture switches that a remote rule can change for its TTL
  serverTiming: false,   // Server-Timing entries on fetch and XHR records
  reports: false,        // Browser reports as WARN ui.report
  resourceTiming: false, // Resource durations. An object sets slowMs, with default 1000
  lifecycle: false,      // Page states and the duration of the previous state
  plugins: [],           // Capture plugins of your app
}
```

`interactions`, `webVitals`, `longFrames`, `console`, `userTiming` and `resourceTiming` take `true`, `false` or an options object.

- `true` turns the capture on with the default options.
- An object turns the capture on. An omitted field keeps its current value. After `true` or `false`, an omitted field takes its default.
- `httpMetrics` and `serverTiming` are booleans only, because they apply to the fetch capture and the xhr capture.
- The URL rules `fullUrls`, `ignoreUrls`, `propagateTraceHeaderTo` and `urlTransform` are keys of `capture` too. They are not capture switches.

`interactions: { rageClicks: true, deadClicks: true }` finds frustrated clicks. Each event names only the action, in `click.action`.

- A rage click is `rageClickCount` clicks (default 3) on one element in `rageClickWindowMs` (default 1000). It gives the event `ui.rage_click` with `click.count`. More clicks in the same burst give no second event. A burst ends when no click stays in the window.
- A dead click is a click on a control that gives no DOM change, no navigation and no scroll in `deadClickMs` (default 1000). It gives the event `ui.dead_click`. A control is a link, a `button`, a `summary`, or a button, submit or reset `input`. An element with the role `button`, `link`, `menuitem` or `tab` is also a control. An element with the action attribute is also a control. A click on a `target="_blank"` or `download` link gives no event.
- A request alone is not a response. A page that changes its DOM all the time gives no dead click.
- A DOM change or a scroll inside an element that matches `deadClickIgnoreSelector` is not a response. The default is `[data-observability-live]`. Mark the element that changes on its own, for example a price cell. Do not mark a panel that also holds the controls. `""` turns the live-region filter off.
- A write that keeps the same value is not a response. A framework can write the same `type` attribute at each render. A batch that sets `name` or `type` and then puts the old value back is not a response. The same rule applies to a text. For any other attribute, each write with a new value is a response, because a class or style change can restart an animation. A swap of elements that match `deadClickIgnoreSelector` under one parent is not a response. An added or removed matching element alone is a response, because a click can show or hide it. One limit is known. A text change counts as a response when its element leaves the page in the same task.
- To capture clicks in a popout window of the page, pass the window to `observeWindow()`.

`uncleanExit` finds a page of this tab that stopped without a clean close, for example after a crash. The top document keeps a marker in `sessionStorage`. A clean close removes it. The next page of the tab logs WARN `ui.unclean_exit`. A popup with an opener reports nothing, because it copies the `sessionStorage` of its opener. A duplicated tab copies it too, and can report a false exit. `identity: "memory"` turns this capture off, because that mode writes nothing to the device.

- The attributes are `exit.session_id`, `exit.last_seen_ms`, `exit.visibility` and `exit.discarded`.
- The marker updates every 30 seconds and at each visibility change. `exit.last_seen_ms` is correct to about 30 seconds.
- A mobile OS can stop a hidden page with no close event. `exit.visibility: "hidden"` shows this case. `exit.discarded: true` shows a page that the browser discarded to free memory.

`userTiming` records each `performance.measure()` of the app in the histogram `ui.user_timing.duration`, in milliseconds, with the attribute `user_timing.name`. Each `performance.mark()` adds a breadcrumb. Frameworks create many marks and measures. Set `userTiming: { include: [/^app\./] }` to keep only the names of your app. `metrics.maxSeries` limits the number of names in one interval. Names follow `fullUrls`. Without it, a name loses the part after the first `?` or `#`.

`serverTiming` reads the `Server-Timing` response header of captured fetch and XHR requests. It adds `server.timing` entries with `name`, `duration` and `description`. A valid `traceparent;desc="00-<trace-id>-<span-id>-01"` adds an OTLP link to the client span. The client span keeps its own trace and parent. Set `tracesEndpoint`, `propagateTraceHeaderTo`, and `capture.fetch` or `capture.xhr` to record client spans.

For cross-origin requests, expose `Server-Timing` with `Access-Control-Expose-Headers`. Also send `Timing-Allow-Origin` for access through browser performance tools. The [Server Timing specification](https://www.w3.org/TR/server-timing/) defines that interface. The library reads at most 4096 header characters and 32 entries. The privacy hooks process the entries before delivery.

`reports` records deprecations and interventions through ReportingObserver. CSP reports use the `securitypolicyviolation` event. Each WARN `ui.report` has the type, the URL and the available source location or CSP directive. Report URLs never keep credentials, queries or fragments. This rule also applies with `fullUrls` or `urlTransform`. Message text and code samples stay out.

`resourceTiming: true` records the histogram `ui.resource.duration` in milliseconds. Its attributes are `resource.initiator_type` and `server.address`. Each resource at or above 1000 ms also gives `ui.resource.slow`. Set `resourceTiming: { slowMs: 500 }` to change the threshold. Set `slowMs: 0` for no slow events. The capture skips ingest endpoints, ignored URLs and non-HTTP resources. Only the first install reads buffered resources. `metrics.maxSeries` limits the host and initiator series.

`lifecycle` records `ui.lifecycle` at install and on each state change. The states are `visible`, `hidden`, `frozen`, `resumed` and `restored`. `restored` means a back-forward cache restore. Each event has `lifecycle.previous_state` and `lifecycle.duration_ms`. A monotonic clock measures the duration.

The three captures have separate rate limits in `captureLimits`. They use `captureLimits.windowMs`, which defaults to 10000 ms. Disabling a capture removes its listeners or disconnects its observer.

`longFrames` records each frame at or above `longFrames.thresholdMs` (default 100) as the histogram `ui.long_frame.duration`. Set `longFrames: { thresholdMs: 200 }` to record only longer frames. Each long frame also adds a breadcrumb. The next error record then shows the freeze before it.

- The library observes `long-animation-frame`. A browser without it gives `longtask` entries, with no script attributes.
- The attributes are `frame.type`, `frame.blocking_ms`, `frame.script.invoker` and `frame.script.source`. The source URL follows `fullUrls`.
- The library records at most `captureLimits.longFramesPerWindow` long frames (default 20) in each `captureLimits.windowMs` window (default 10000 ms).

`capture.console` records the console calls of your app and of third-party code. It is different from the top-level `consoleOutput` option, which prints records.

> **Set `redact` before you turn on `capture.console`.** A call such as `console.error("Request failed", error.response)` sends the request headers, for example `Authorization`. Third-party code on the page writes such lines too.

- `true` wraps `console.error` and `console.warn`. `{ levels }` selects from `error`, `warn`, `info` and `log`. An empty `levels` list wraps nothing.
- `error` gives an ERROR record, and `warn` gives a WARN record. `info` and `log` give a breadcrumb only.
- The first string is the message. The first `Error` of an `error` call gives the `error.*` fields. The other arguments go into `console.args`.
- The wrapper calls the original method first. Devtools shows the same text. The source link of the line points to the library wrapper.
- The library does not record the lines that it prints itself.
- The library records at most `captureLimits.consolePerWindow` `error` and `warn` calls (default 20) in each `captureLimits.windowMs` window. The error capture has a separate limit. Console noise cannot hide an uncaught error.
- To record an argument, the library reads each property, also a getter. A getter with a side effect then runs during the console call.
- On `shutdown()`, the library restores each method. If another script wrapped the method later, the library leaves it and reports `capture.install_failed`.

`webSocket` records the lifecycle of each WebSocket that the app opens after the capture loads.

- `websocket.open` and `websocket.close` are events. `websocket.error` is a WARN record. Each has `url.full` and `server.address`.
- `websocket.close` adds `websocket.close.code` and `websocket.close.clean`.
- `url.full` has no user info, no query and no fragment, also with `fullUrls`. A socket URL often holds a token. Only `urlTransform` can record more of the URL.
- The counter `ui.websocket.messages` counts the messages, with `network.io.direction` (`transmit` or `receive`) and `server.address`.
- The library never reads the content of a message.
- The library records at most `captureLimits.webSocketPerWindow` lifecycle records (default 20) in each `captureLimits.windowMs` window. The counter counts each message.

`plugins` adds your own capture modules. A plugin is an object with `name`, `install(ctx)` and `uninstall()`.

- `ctx` gives `logger`, `counter()`, `histogram()`, `addBreadcrumb()` and `ownRequest(fn)`. The logger namespace is `uiobs.capture.<name>`.
- `ownRequest(fn)` runs `fn`. The network capture does not record a request that `fn` starts before its first `await`, and does not add `traceparent` to it.
- A `configure()` that changes the capture section calls `uninstall()`, then `install(ctx)` again. `shutdown()` calls `uninstall()`.
- If `install()` or `uninstall()` throws, the library reports `capture.install_failed`. The other capture modules keep working.
- The console-only runtime next to another version of the library installs no plugin.

```ts
import { type CapturePlugin, configure } from "@utk09/ui-observability";

let onChange: (() => void) | undefined;

const visibility: CapturePlugin = {
  name: "visibility",
  install(ctx) {
    onChange = () => {
      ctx.logger.logEvent("page.visibility", { state: document.visibilityState });
    };
    document.addEventListener("visibilitychange", onChange);
  },
  uninstall() {
    if (onChange) {
      document.removeEventListener("visibilitychange", onChange);
    }
  },
};

configure({ endpoint: "https://ingest.example/v1/logs", capture: { plugins: [visibility] } });
```

`fullUrls` is off by default. The library then cuts each recorded URL at the first `?` or `#`. This applies to the page URL, the request target and the URL of a failed resource. `ignoreUrls` and a RegExp in `propagateTraceHeaderTo` match the full URL. `urlTransform` replaces this rule. It receives the original URL. If it throws, the library records an empty URL and reports `capture.record_failed`.

`propagateTraceHeaderTo` needs `capture.fetch` or `capture.xhr`. Without them, the library reports `config.invalid`. A string in `propagateTraceHeaderTo` is an origin, for example `"https://api.example"`. It matches a request to that origin only. A URL with a path gives its origin. A relative request URL resolves against the page. To match a path, use a RegExp. A RegExp tests the request URL in the form that the caller gives. Start each RegExp with `^`. Without it, `/\/api\//` also matches `https://vendor.example/api/`. For example, `/^https:\/\/api\.example\/v2\//` matches one path on one origin. `/^\/api\//` matches a relative request URL only.

## Spans

With `tracesEndpoint`, the library sends spans. The backend then has a root span for each trace of the library. Span batches always use OTLP. This is also true with the `ecs` serializer or a custom serializer. You do not need an OpenTelemetry SDK for these spans.

- **Root span:** Each ambient trace has one root span of kind INTERNAL. It starts with the trace and ends when the trace rotates. Its name tells why the trace started: `ui.start`, `ui.interaction`, `ui.navigation` or `ui.trace`.
- **Client span:** Each `fetch` or XHR request that gets `traceparent` from `capture.propagateTraceHeaderTo` has one span of kind CLIENT. The `traceparent` names the client span, and the root span is its parent. Its name is the HTTP method. Its attributes are `http.request.method`, `url.full`, `server.address`, `http.response.status_code` and `error.type`. A status of 0 or 400 and more sets the status ERROR. A `fetch` request that already has a `traceparent` header keeps it. The library then records no client span and reports `capture.trace_header_kept`.
- **Measure span:** Each `startMeasure()` call has one span of kind INTERNAL under the root span. Each phase has one child span. Sampling and the OpenTelemetry rule apply to it as to a client span.
- **Sampling:** `sampling.defaultRate` samples each trace by its trace id. The whole trace stays or goes. `minLevel` does not apply to a span. For a trace that sampling drops, the `traceparent` has the sampled flag off. A downstream service then drops its spans too.
- **Exit:** The exit flush and `shutdown()` end the root span of the active trace. The root span of a trace ends one time. A tab that becomes hidden ends it too, because a mobile OS can stop a hidden page.
- **OpenTelemetry:** With `otelLoader`, a trace from the OpenTelemetry API keeps its own spans. The library sends no span for it.
- `getTraceHeaders()` names the root span. Your server span is then a child of the root span.
- Span records go through `processors` and `redact`. They also carry the context attributes of a record, for example `page.url` and `journey.id`.

## Browser Storage Keys

| Key | Store | Written when | Option that stops it |
| --- | --- | --- | --- |
| `ui-observability.session` | `localStorage` | At startup, then at most one time each minute while logging | `identity: "memory"` |
| `ui-observability.tab` | `sessionStorage` | At startup. A popup writes a new id when its opener has the same id. When the bus finds a duplicated tab, the newer document writes a new id. With an older library or an equal `since`, the context id comparison decides. Then either document can write the new id. | `identity: "memory"` |
| `ui-observability.journey` | `sessionStorage` | When a journey starts or ends | `identity: "memory"` |
| `ui-observability.alive` | `sessionStorage` | At startup, at each visibility change and at each interval | `capture.uncleanExit: false` or `identity: "memory"` |
| `ui-observability.batch.*` | `localStorage` | When a send fails and the `localstorage` adapter holds the batch | `storage.backend` other than `auto` or `localstorage` |
| `ui-observability.emergency.*` | `localStorage` | When the exit flush cannot send a batch | `endpoint: null`, `storage.backend` `"memory"` or `"none"` |
| `ui-observability.probe` | `localStorage` | One write and one remove, when the library tests `localStorage` | `storage.backend` other than `auto` or `localstorage` |

IndexedDB holds undelivered batches with `storage.backend` `"auto"` or `"indexeddb"`, in the database `UiObservability`.

With `storage.namespace`, the batch keys start with `ui-observability:namespaced:<namespace>:batch:`, the emergency keys start with `ui-observability:namespaced:<namespace>:emergency:`, and the database is `UiObservability:<namespace>`. The keys hold the namespace in URL-encoded form. The database name holds it as given.

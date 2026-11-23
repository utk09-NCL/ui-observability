# API Reference

This document gives each function that the package exports. [Configuration Options](configuration.md) gives each key of `configure()`.

## Lifecycle & Setup

| Function | Description |
| --- | --- |
| `configure(config)` | Starts the runtime singleton, or updates it. |
| `shutdown(options?)` | Stops every subsystem. By default it sends the pending records, runs the exit flush and cancels a request that is still open after that. `pending: "discard"` sends nothing. `clearStorage` also removes the stored data. Later calls do nothing until the next `configure()`. See [Shutdown options](#shutdown-options). |
| `rotateSecurityContext(update, options?)` | Changes the delivery identity and the routing settings in `update.routing` together. Use it at logout or a tenant change. A call during another rotation runs after it. The rotation code loads on the first call. See [runtime policies](runtime-policies.md#security-context-rotation). It rejects before the first `configure()` call that works and after `shutdown()`. |
| `setConfigurationLocked(locked)` | Locks or unlocks changes through `configure()`. Call it after `configure()`. A lock before the first `configure()` refuses that call too. |

## Logging Methods

| Function | Description |
| --- | --- |
| `getLogger(namespace, options?)` | Returns the cached logger for a namespace. With `options`, it returns a new logger that is not cached. |
| `trace(msg, payload?)` | Logs a TRACE record. |
| `debug(msg, payload?)` | Logs a DEBUG record. |
| `info(msg, payload?)` | Logs an INFO record. |
| `warn(msg, payload?)` | Logs a WARN record. |
| `error(msg, err?, payload?)` | Logs an ERROR record with the error and the breadcrumb trail. |
| `fatal(msg, err?, payload?)` | Logs a FATAL record with the error and the breadcrumb trail. |
| `logAction(name, payload?)` | Logs one user action. |
| `logEvent(name, payload?)` | Logs one domain or lifecycle event. |
| `counter(name, { unit? })` | Gives a counter. `add(value, attrs?)` sums a value of 0 or larger in memory. The library sends one point for each attribute set at each interval. |
| `gauge(name, { unit? })` | Gives a gauge. `set(value, attrs?)` keeps the last value for each attribute set in memory. The library sends that value as one point at each interval. |
| `histogram(name, { unit?, boundaries? })` | Gives a histogram. `record(value, attrs?)` counts a value in buckets in memory. The library sends one point for each attribute set at each interval. |
| `measure(name, fn, attrs?)` | Calls `fn` and times the call with a measure. A promise result ends the measure when it settles. A throw or a rejection gives the outcome `"error"`, and the caller gets the error. See [Measures](#measures). |
| `startMeasure(name, attrs?)` | Times an operation with named phases. See [Measures](#measures). |
| `profiler.probe(name, options?)` | Gives a probe that times code spans with a small fixed cost. See [Profiler](#profiler). |
| `profiler.time(name, fn)` | Calls `fn` and times the call with the probe of the name. A promise result ends the span when it settles. See [Profiler](#profiler). |
| `startReplay()` | Starts the session replay recorder. With `replay.requireConsent`, nothing records before this call. See [Session replay](#session-replay). |
| `stopReplay()` | Stops the session replay recorder and drops each replay event that is not sent. |

The level methods give records with `log.type: "log"`. Records of the library itself have `log.type: "system"`. A logger has no metric method. Use `counter`, `gauge` or `histogram`. Each instrument drops a value that is not finite and reports `record.dropped_malformed`.

`counter` and `histogram` sum their values for `metrics.intervalMs`. `gauge` keeps the last value. Then each instrument sends one point for each attribute set. 1000 calls of `add(1)` give one point with the value 1000. With `metricsEndpoint`, a gauge point is an OTLP gauge, and a counter point is an OTLP sum. Sampling and `minLevel` do not drop a point. The console does not print it. Each instrument keeps at most `metrics.maxSeries` attribute sets in each interval. The default is 100. The values of more sets go to one set with `otel.metric.overflow: true`. Attribute values must be strings, finite numbers or booleans. The library drops an attribute key that starts with `metric.`. It also drops the keys that it sets on each record, for example `page.url` and `log.type`. With `metricsEndpoint`, a point never takes a record key or a resource key as an OTLP point attribute. Examples are `session.id`, `tab.id` and `journey.id`. This rule also applies when `metric.attribute_keys` names the key. The record limits do not cut the metric fields of a point, for example the bucket counts. `redact` cannot change them. On a point from a frame or a worker, the sender's `redact` can change `metric.name`, `metric.unit` and `metric.attribute_keys`. Do not use a user id or a URL as an attribute. Each value makes a new series in the backend. The default histogram boundaries are `[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`. The points of the open interval go out at `flush()`, at `shutdown()` and before the exit flush. `shutdown({ pending: "discard" })` drops them. A frame that forwards its records sends its points at the interval, at `flush()` and at `shutdown()` only.

## Measures

`startMeasure()` times an operation with named phases.

```ts
const measure = startMeasure("checkout", { tier: "gold" });
measure.phase("validate");
await validate();
measure.phase("payment");
await pay();
measure.end();
```

- `phase(name)` closes the open phase and starts the next phase. `end(outcome?)` closes the open phase and records the total. Later calls of the handle do nothing.
- Each phase goes into the histogram `ui.measure.phase.duration` with `measure.name` and `measure.phase`. The total goes into `ui.measure.duration` with `measure.name` and `measure.outcome`. Both are in milliseconds.
- The default outcome is `"ok"`. Each name, outcome and attribute set makes one series. Keep these values small in number.
- With `tracesEndpoint`, the measure is a span of kind INTERNAL with one child span for each phase. The outcome `"error"` marks the measure span and its open phase as failed.
- A shutdown drops a measure that has no end. With isolation, a new delivery identity also drops it.
- `measure(name, fn, attrs?)` calls `fn` in a measure with no phases. The measure ends when `fn` returns. If the result has a `then` function, the measure ends when the result settles. A throw or a rejection gives the outcome `"error"`. The caller gets the same error.

## Profiler

`profiler.probe()` gives a probe that times a span that runs very often, for example a grid transaction, a sort or a render. `startMeasure()` makes a handle for each operation. A probe is one handle for all spans of its name. The profiler code makes no object for a `begin()` and `end()` pair, except one timer at the first value of each interval. The clock read of the platform can make one, for example in Node.js. The library sends one summary record for each probe at each interval, not one record for each span.

```ts
configure({ profiler: { enabled: true } });

const probe = profiler.probe("grid.applyTransaction");

const token = probe.begin();
grid.applyTransaction(update);
probe.end(token);

// Add a duration from another source, in milliseconds.
probe.record(durationMs);

// Measure one span of each 10 spans.
const sort = profiler.probe("grid.sort", { sampleEvery: 10 });

// End the span after the next paint. A span longer than 16 ms adds a breadcrumb.
const render = profiler.probe("grid.render", { slowMs: 16 });
const renderToken = render.begin();
grid.render();
render.endAfterPaint(renderToken);

// Time one call of a function. A promise result ends the span when it settles.
const rows = await profiler.time("rows.fetch", () => fetchRows());

// A span that an await splits needs an async probe.
const load = profiler.probe("blotter.load", { async: true });
```

- The profiler is off by default. While it is off, `begin()` returns `-1`. A probe then reads no clock.
- A probe stays valid across `configure()` and `shutdown()`. An app can make a probe before `configure()`. The same name gives the same probe. The first options of a name stay. A call never throws.
- A probe sums its durations for `metrics.intervalMs`. The default is 10 seconds. Counters and histograms use the same interval. Then the library sends one `ui.profile.duration` histogram record for each probe with data. `flush()`, `shutdown()`, `newSession()` and the exit flush also send the open interval.
- A record has the count, the sum, the minimum, the maximum and the buckets. Its attributes are `profile.probe`, `profile.sample_every`, `profile.p50`, `profile.p90`, `profile.p99`, `profile.self_p99` and `profile.overhead_ns`. See [Profile Attributes](attributes.md#profile-attributes).
- The library counts each duration in a bucket, in whole microseconds. Each power of two has 16 buckets. Below 16 microseconds, a bucket is 1 microsecond wide. Above that, a bucket is at most 6.25 percent wide. The minimum and the maximum are exact. A duration above approximately 67 seconds counts in the last bucket. A record has at most 100 buckets. For a wider range of durations, the library merges adjacent buckets in the record.
- `sampleEvery: n` measures one span of each `n` spans. The probe uses a counter, not a random number. A span that the probe does not measure reads no clock. Its `begin()` returns `-1`. `record()` uses the same counter. The count in the record is the count of measured spans. A backend multiplies it by `profile.sample_every` for an estimate of all spans.
- A record of a probe with nested spans also has `profile.self_p99`. The self time of a span is its duration without the durations of the measured spans inside it. The library keeps the open spans on a stack of 32 levels. A span gets a self time when its `begin()` and `end()` run in nested order.
- A span with no `end()` call loses its stack level when a span around it ends, or when the stack is full. A span at level 33 clears the stack. The spans below it keep their durations and get no self time.
- `async: true` is for a probe with a span that an `await` splits. Its spans are not on the stack. They give the total time only. They take no time from the self time of another span. Without the option, the spans of other tasks count as spans inside the open span.
- `profiler.time(name, fn)` calls `fn` and times the call with the probe of the name. An error of `fn` goes to the caller. For a result with a `then` function, the span ends when the result settles. `time()` then returns the result of that `then` call, not the result of `fn`.
- `endAfterPaint(token)` ends the span in the first task after the next paint. The duration then includes the style, the layout and the paint of the browser. In a hidden page, or in a context with no `requestAnimationFrame`, it ends the span at once. A page that becomes hidden ends each span that waits. The span has no self time. `endAfterPaint()` and a `profiler.time()` call with a promise result make a small number of objects.
- `slowMs` adds a breadcrumb for each span that is longer than the value. The breadcrumb has the category `profile` and a message such as `grid.render 48 ms`. The next error record carries it. Use a threshold that only a slow span passes, because each breadcrumb is an object.
- `profiler.framePhases: true` adds the phases of each long animation frame to each probe with a span of 1 ms or more in that frame. The library sends them as the histogram `ui.profile.frame.duration` with the attributes `profile.probe` and `profile.frame_phase`. The phases are `script`, `render`, `style_layout` and `forced_layout`. `forced_layout` is the layout time that a script forced with a read after a write. It is a part of the `script` phase.
- `framePhases` uses the last 256 spans of the probes that are not async. `captureLimits.longFramesPerWindow` limits the frames in each window. A browser with no long animation frames reports `capture.install_failed` one time. `framePhases` is then off. Firefox and Safari are such browsers.
- `profiler.framePacing: true` measures the time between two frames with the probe `frame.interval`. The probe uses one of the `maxProbes` slots. The library runs one frame callback for each frame while the page is visible. The first frame after a hidden time gives no value.
- `framePhases` and `framePacing` load as a separate chunk. They need `profiler.enabled`.
- `profiler.maxProbes` is the maximum number of probes. The default is 64. The range is 1 to 1024. You cannot change it after startup. A probe above the limit does nothing. The library reports `config.invalid` one time for each start of the profiler. The diagnostics throttle can drop that report. The library then reports again each time it collects the profiler points, until one report passes the throttle. Each try adds 1 to the `config.invalid` counter.
- Each probe slot holds 2 times 368 bucket counts of 4 bytes, 4 numbers of 8 bytes and 2 numbers of 4 bytes. One slot is 2984 bytes. The library allocates one slot more than `maxProbes` when the profiler first turns on. The default of 64 probes uses 65 slots. That is 193,960 bytes.
- At the end of the first interval with data, the library measures the cost of one `begin()` and `end()` pair. The measurement runs one time. It blocks the thread for approximately 2 ms to 3 ms. Each record from that time has the result as `profile.overhead_ns`. The result is the cost of a pair in a short loop. A pair in app code can cost more or less. `flush()`, `shutdown()` and the exit flush do not run the measurement. A clock that is too coarse gives no value. The measurement can then block for longer.
- With `metricsEndpoint`, a record is an OTLP histogram point. Its point attributes are `profile.probe` and `profile.sample_every` only. The percentiles and the overhead value are on the log record and the ECS document only. A backend computes percentiles from the buckets.
- `processors` and `redact` apply to the `profile.*` attributes of the record. Use a small number of fixed probe names, because each name is one series.
- A rotation sends the open interval as records of the old context. With `securityContext.isolation` (the default), the values of the rotation add no value. Each span that is open at its end also adds no value. On a coarse clock, this includes a span that begins in the last clock tick of the rotation.
- A span that is open when `configure()` turns the profiler off adds no value. During a rotation, `shutdown()` and the exit flush do not send the open interval.
- A name that is not a string, or an empty name, gives a probe that does nothing. A `sampleEvery` value that is not an integer from 1 to 2147483647 uses 1. A `slowMs` value that is not a finite number of 0 or more adds no breadcrumb. An `async` value that is not a boolean uses `false`. Each of these reports `config.invalid` to the current runtime. A call before the first `configure()` reports nothing.
- A probe name stays for the life of the page. The library keeps at most 1024 names. The order of the `probe()` calls decides which probes are in the `maxProbes` limit.
- The clock of the platform limits the resolution of one span. A browser rounds `performance.now()`, for example to 0.1 ms or to 1 ms. A span shorter than one clock step reads 0 or one step.
- Give `end()` only the token of `begin()`. `end(-1)` does nothing. Another token that is not a number, is below 0 or gives a negative duration adds no value. While the profiler is on, the library counts that token as `record.dropped_malformed`.

## Session replay

The session replay records the DOM of the page with the recorder of your app, [`@rrweb/record`](https://rrweb.com/docs/guide). The library keeps the recent events in memory. After an ERROR or FATAL record, it sends them in segments to a separate endpoint. A person can then watch what the user saw before the error.

```ts
configure({
  replay: {
    enabled: true,
    endpoint: "https://replay.example/v1/replay",
    // Your app owns the import. The library has no recorder of its own.
    loader: () => import("@rrweb/record"),
  },
});
```

- The replay is off by default. `@rrweb/record` is an optional peer. An app with the replay off does not need it.
- The buffer keeps the last `replay.bufferMs` (60 seconds by default), and at most 1.5 times that. The recorder takes a full snapshot at each half of that time. `replay.maxBufferBytes` limits the buffer. Above it, the buffer drops its oldest part. The next upload reports `capture.rate_limited`. When the buffer must drop its only part, it keeps no event until the next full snapshot. It reports `capture.rate_limited` one time for each recording. The replay of an error in that time starts at the error, with no events from before it.
- An ERROR or FATAL record starts an upload. The library sends the buffer, then each new event for `replay.afterErrorMs`. An error in that time is a part of the same upload and does not extend the time. `replay.uploadsPerWindow` limits the uploads in each window of `replay.uploadWindowMs`. A stream of errors then cannot upload the full session. An upload always starts with a full snapshot. For an empty buffer, the library takes a new one. If the recorder cannot take it, for example before its start, the library sends no replay for that error. It reports `capture.record_failed`.
- The library sends the events in segments. A segment closes at `replay.maxSegmentEvents` events, at `replay.maxSegmentBytes` or after `replay.flushIntervalMs`. One event that is larger than `maxSegmentBytes` is a segment of its own. A full snapshot of a large page is such an event.
- One segment is in flight at a time. A failed send has `replay.maxAttempts` attempts, with the wait of `delivery.retryBaseDelayMs` and `delivery.retryMaxDelayMs`. `delivery.requestTimeoutMs` limits each request. The segments that wait have the limit `replay.maxQueueBytes`. A segment is only in memory. The exit flush sends no segment.
- The request has the headers of `replay.headers`, an object or a function. It does not have the `headers` of the log endpoint, because that token can be for another host. `credentials` applies to the replay request also.
- `replay.maxBufferBytes`, `replay.maxSegmentBytes` and `replay.maxQueueBytes` count the length of the JSON text. A text with a character above U+00FF uses 2 bytes of memory for each character.
- Each segment has `replay.id`, `session.id`, `tab.id`, `service.name` and a `sequence` number. Each record has the attribute `replay.id` while the recorder runs. Use it to find the replay of a log record.
- `replay.onSegment` gets each segment in place of the request. Use it for your own transport. A call that does not end in `delivery.requestTimeoutMs` drops the segment. If the function sends a request, add its URL to `capture.ignoreUrls`. Without that, a failed request gives an error record, and that record gives a new upload.
- **Privacy.** The recorder masks the text of each element. It masks the value of each `input`, `textarea` and `select`, also of a hidden input and a file input. A masked value is `********`. A masked text keeps the length of each word. The text in an element with the attribute `data-observability-unmask` stays. `replay.maskSelectors` is a list of CSS selectors with text that is always masked. `replay.blockSelectors` is a list of CSS selectors of elements that the recorder does not record. The recorder also always blocks each element in `[data-observability-ignore]`, which click capture skips. You cannot turn this off. A password input is always masked. `redact` and `processors` do not apply to a replay event.
- **What stays in clear text.** The recorder does not mask an attribute value, for example `title`, `alt`, `placeholder`, `aria-label`, `data-*`, `id` and `class`. It does not mask the `value` of a checkbox, a radio button, a button and an `<option>`. It does not mask a URL in `href` or `src` with its query, the CSS text, the content of a `<meta>` element and a comment. It records the mouse positions and the scroll positions. The library removes the query of the page URL unless `capture.fullUrls` is set. Block an element with `replay.blockSelectors` when one of these can identify a person or an account.
- Do not put `data-observability-unmask` on an element that shows content from a user. That content can then add text that stays in clear text. With `replay.maskText: false`, a `maskSelectors` entry does not reach an element inside a shadow root.
- A `maskSelectors` or `blockSelectors` entry that is not valid CSS reports `config.invalid`. The replay then does not start, because a missing mask shows text that you wanted to hide. The library also joins each list into one selector for the recorder. A joined list that is not valid CSS has the same result, also when each entry is valid alone. An entry that hides the entries after it, for example one with an unclosed quote, also has this result.
- With `replay.requireConsent: true`, nothing records before `startReplay()`.
- `stopReplay()` stops the recorder, stops the request in flight and drops each event that is not sent. The recorder then stays off until the next `startReplay()`, also after a later `configure()`. This rule applies with and without `requireConsent`.
- `newSession()` and `rotateSecurityContext()` drop the buffer and start a new recording with a new `replay.id`. The next user of a shared device does not get the page of the previous user.
- A change of another capture setting in `configure()` keeps the recording and its buffer. A change of `replay.endpoint`, a mask setting, a selector list, `recordCanvas`, `bufferMs`, `requireConsent`, `capture.fullUrls` or `capture.ignoreUrls` starts a new recording with a new `replay.id` and drops the buffer. The segment settings, the limits and `replay.headers` apply to the recording that runs. See [Runtime policies](runtime-policies.md).
- `replay.recordOptions` gives other options to the recorder. The library accepts `sampling`, `slimDOMOptions`, `ignoreClass`, `ignoreSelector`, `ignoreCSSAttributes`, `userTriggeredOnInput`, `recordAfter`, `inlineStylesheet` and `dataURLOptions`. It sets each mask, block, canvas, plugin and event option itself. It ignores another key and reports `config.invalid`.
- The recorder reads each DOM change. A change of many nodes costs time and memory. Block a large list with `replay.blockSelectors` when its content is not necessary in the replay.

`replay.plugins` is a list of functions that make the record plugins of the recorder. Your app owns each import.

```ts
configure({
  replay: {
    plugins: [
      async () =>
        (await import("@rrweb/rrweb-plugin-sequential-id-record")).getRecordSequentialIdPlugin(),
      async () =>
        (await import("@rrweb/rrweb-plugin-console-record")).getRecordConsolePlugin({
          level: ["warn", "error"],
        }),
      async ({ transformRequest }) =>
        (await import("@rrweb/rrweb-plugin-network-record")).getRecordNetworkPlugin({
          recordHeaders: false,
          recordBody: false,
          transformRequestFn: transformRequest,
        }),
    ],
  },
});
```

- The sequential id plugin numbers each event. A server can then find a lost event.
- The console plugin and the network plugin wrap the same functions as the console capture and the network capture of the library. Both pairs work together. A plugin event does not pass through `redact`. Do not record headers or bodies unless you mask them in the options of the plugin.
- Give `transformRequest` to the network plugin. It skips each request to a URL in `capture.ignoreUrls`. That list has each endpoint of the library, also `replay.endpoint`. Without it, an upload gives a new event, and that event gives a new upload. It also removes the query of a URL unless `capture.fullUrls` is set. It always removes the user name and the password.
- The network plugin gives its event some time after the request. An upload directly after a request does not have that event.
- A new `loader` function, `onSegment` function, `recordOptions` object or plugin function in `configure()` starts a new recording and drops the buffer. The library compares the references. Keep them stable, and do not make a new function or object in each `configure()` call.

## Context & Correlation

| Function | Description |
| --- | --- |
| `setContext(values)` | Merges an attribute map into the ambient context. Each later record has the attributes. A `null` value removes its key. An `undefined` value keeps the current value. A value that is not an object reports `config.invalid` and changes nothing. |
| `removeContext(key)` | Removes one attribute from the ambient context. |
| `addBreadcrumb(message, data?)` | Adds a breadcrumb with the category `custom`. The next error record carries the trail. The library copies `data` at the call. |
| `startJourney(name, options?)` | Starts a journey across windows. `options.parent: true` links the active journey as the parent. `options.id` sets the id, 1 to 64 letters, digits, `_`, `.`, `:` or `-`. Another value gives a new id and a `config.invalid` report. |
| `endJourney()` | Ends the active journey. |
| `currentJourney()` | Returns the active `Journey`, or null. |
| `getJourneyToken()` | Serializes the active journey into a URL token. Returns null with no active journey, or for a token above the size limit. |
| `adoptJourney(token)` | Adopts a journey token into this context. |
| `newTrace()` | Starts a new trace. Later records and requests have the new trace id. |
| `getTraceHeaders()` | Returns the W3C `traceparent` header for an outgoing request. |
| `registerWorker(worker, options?)` | Attaches a Web Worker or MessagePort to the bus, with its permissions. Returns a function that removes the registration. |
| `registerFrame(frame, options)` | Registers a child iframe element or window at its exact origin, with its permissions. Returns a function that removes the registration. A child frame forwards only after its registration, unless `bus.sourcePolicy` is `trusted-origin`. |
| `observeWindow(target)` | Captures clicks in another window of the page, for example a popout whose code runs in the page. It records click breadcrumbs, rage clicks and dead clicks. It adds no navigation capture. The window must have the origin of the page. A window from another origin reports `capture.install_failed`. The library listens only while `capture.interactions` is on. The window stays across `shutdown()` and the next `configure()`. Returns a function that stops the observation. While `capture.interactions` is on, the window also leaves at its `pagehide`. The result of `window.open()` works at once, because the `pagehide` of its initial `about:blank` does not end the capture. A closed `about:blank` popout leaves at the next dead click check, install or `observeWindow()` call. After the app fills `about:blank` and loads a page in it, call `observeWindow()` again. A navigation to another origin ends the capture in that window. A window that opens to another origin and is observed at once gets no report. The library forgets it at its next dead click check. |
| `newSession()` | Rotates correlation in this tab. Use `rotateSecurityContext()` for logout or tenant changes. It sends the open metric points, ends the active trace and journey, and clears the breadcrumbs. Other tabs read the new id at their next startup. |

See [runtime policies, operational budgets and migration](runtime-policies.md) for `rotateSecurityContext()`, `registerFrame()`, source permissions, `setConfigurationLocked()`, `getHealth()` and configurable cache/bus budgets. Defaults favor privacy and isolation; applications can explicitly choose broader capture and delivery policies.

`serveTransportWorker({ onDiagnostic? })` starts the dedicated transport worker service. It returns a function that stops the service.

## Delivery & Diagnostics

| Function | Description |
| --- | --- |
| `flush(options?)` | Sends the records in memory. Then it waits until each record has a final state, or until `timeoutMs` passes. The default is 5000 ms. It returns a `FlushResult` and never rejects. See [Flush result](#flush-result). |
| `getDiagnosticCounters()` | Returns the count of each diagnostic code. |
| `getHealth()` | Returns the state of this SDK copy. It has the SDK version, the status, the delivery role, the lock and cache state, the issue codes and the policies. The status is `unconfigured`, `disabled`, `starting`, `ready`, `rotating`, `degraded` or `stopped`. The `delivery` block has the delivery state. See [Delivery health](#delivery-health). |
| `collectDebugBundle()` | Returns a JSON-safe bundle for a support ticket. It has the health, the diagnostic counters, the resource, the breadcrumbs, the debug buffer and a config summary. The summary has no headers and no URL query. A plugin or a custom serializer shows only its name. The privacy hooks process the breadcrumbs. A debug buffer record keeps its context attributes. Your app decides where to send it. |

## Delivery health

`getHealth().delivery` has numbers and times only. It has no response text, no header and no URL.

| Field | Description |
| --- | --- |
| `pending` | The records in the buffers of the library, not yet in a request. A forwarder counts only its own buffers. |
| `inFlight` | The records in requests that are not complete. |
| `stored` | The batches in storage that wait for a retry. A forwarder stores nothing and reports 0. |
| `lastSendAt` | The epoch time in ms of the last batch that the server accepted, or null. |
| `lastFailureAt` | The epoch time in ms of the last failed send, or null. |
| `consecutiveFailures` | The failed sends after the last batch that the server accepted. A batch that makes no request does not change it. The exit flush does not count. |
| `throttledUntil` | The epoch time in ms when the latest server throttle ends, over all endpoints. Null when no endpoint is throttled. |
| `dropped` | The lost records for each `onDrop` reason, from the start of the runtime. A reason with no loss has no key. |

- The library counts `dropped` also without an `onDrop` hook.
- A security context rotation resets `lastFailureAt`, `consecutiveFailures` and `throttledUntil`. It keeps `lastSendAt` and `dropped`.
- `getHealth()` does not wait for startup or for the delivery stack to load.
- The next `configure()` after `shutdown()` starts a new runtime. Each field then starts at zero or null.

## Flush result

`flush(options?)` sends the records in memory and returns a `FlushResult`. Each count is a number of records, not batches.

```ts
const result = await flush({ timeoutMs: 2000 });
if (result.status !== "complete") {
  // Some records have no final state yet. The library still sends or stores them later.
}
```

| Field | Description |
| --- | --- |
| `status` | `"complete"`, `"timeout"` or `"inactive"`. |
| `accepted` | The records that the transport accepted. For HTTP, the server answered `2xx`. For a custom transport, it returned a `2xx` status. For the transport worker, the worker confirmed the send. |
| `stored` | The records that storage keeps after a failed send or a throttle. The retry engine sends them later. |
| `dropped` | The records that the library lost. `onDrop` reports them. A record with no destination only counts `record.dropped_no_destination`. A forwarder with no owner drops its records with no `onDrop` report. It reports `bus.no_owner` one time at startup. |
| `forwarded` | In a forwarder, the records that the call gave to the sender. In a sender, 0. |
| `pending` | The records that have no final state at the end of the wait. A store with an unknown result counts here. |

- `timeoutMs` is from 0 to 600000 ms. The default is 5000 ms. The wait includes startup and the load of the delivery stack.
- A `timeoutMs` that is not a number in the range reports `config.invalid`. Options that are not an object also report it. The call then uses 5000 ms. `null` gives 5000 ms with no report.
- The snapshot is the records in memory at the call. These are the records in the buffers, the queued batches and the batches in flight. A record that you log after the call is not in the snapshot.
- Before startup ends, the call waits for startup first. The snapshot then also has the records that you log during that wait.
- Two calls at the same time each have a snapshot and a time limit. A batch that is in flight at both calls counts in both results.
- `status` is `"complete"` when `pending` is 0.
- `status` is `"timeout"` when `pending` is more than 0. The time limit passed, or a store passed its own time limit. A pause, a `shutdown()` or a rotation that ends the wait also gives `"timeout"`. A pause that starts while the call waits for startup or for the delivery stack gives `"inactive"`.
- During a rotation, the records of the old context wait for the `pending` rule of the rotation. The result counts them as `pending`.
- At the time limit, the call returns. The library does not cancel the work. A batch that ends later goes to the server or to storage as usual. The result does not change.
- `status` is `"inactive"` before the first `configure()` call that works, after a failed first call, while `enabled` is false and after `shutdown()`. The call sends nothing and waits for nothing. `pending` is the count of the records that wait in memory. The other counts are 0.
- A forwarder gives its records to its sender and asks the sender to flush. The sender gets 90 percent of the time that is left. The rest is for the answer. `status`, `accepted`, `stored`, `dropped` and `pending` come from the answer of the sender. They count all records in the snapshot of the sender. That includes the records of other contexts.
- A forwarder that gets no valid answer in time counts its forwarded records as `pending`. A sender on an older version does not answer.
- A forwarder with no owner sends nothing. It counts its records as `dropped` and returns `"complete"` at once.
- A flush that a frame or a worker asks for does not send the open interval of the metrics and the profiler of its sender.
- The batches in storage from earlier failures are not in the snapshot. `getHealth().delivery.stored` counts them. The call starts no drain.
- Replay segments and the exit flush are not in the snapshot.

## Shutdown options

`shutdown(options?)` takes `pending` and `clearStorage`.

```ts
// Logout on a shared device: send nothing more, and remove the stored data.
await shutdown({ pending: "discard", clearStorage: "context" });
```

| Option | Values | Effect |
| --- | --- | --- |
| `pending` | `"flush"` (default), `"discard"` | `"flush"` sends the records in memory, then runs the exit flush. `"discard"` sends nothing and runs no exit flush. |
| `clearStorage` | `"context"`, `"namespace"`. Not set by default. | Removes the stored batches, the emergency queue entries, the stored session id, the tab id and the journey. `"namespace"` removes the batches of each context in `storage.namespace`. |

- A discard reports each record in memory to `onDrop` with the reason `"discarded"`. A request in flight can still reach the server. The library does not report its records. Its result writes nothing and starts no retry.
- A discard stops the captures, the replay recorder, the retry engine and the pipeline. The replay recorder drops its buffer and its upload queue.
- A discard also clears the breadcrumbs, the ambient context, the debug buffer and the active journey of the stopped runtime. The stored journey stays, unless `clearStorage` removes it.
- `clearStorage` always discards. With `pending: "flush"`, the library reports `config.invalid` and discards.
- `"context"` also removes the batches that a carry during a pause left under an older context.
- `clearStorage: null` removes nothing, as when it is not set.
- An invalid `pending` value reports `config.invalid` and discards. An invalid `clearStorage` value reports `config.invalid`, discards and removes the `"context"` scope.
- A value that is not an object, for example `shutdown("discard")`, reports `config.invalid` and discards.
- A later `shutdown()` stops nothing more. Its `clearStorage` still removes the stored data of the stopped runtime. The removal waits until the first `shutdown()` ends, so a late save of the first flush cannot land after it.
- After `shutdown()`, `startJourney()` and `adoptJourney()` keep the journey in memory only. They write nothing to `sessionStorage`.
- Before the first `configure()` call that works, no store is known. `clearStorage` then removes nothing. After a first `configure()` with `enabled: false`, it opens the configured store to remove the data.
- Late work after a discard writes nothing. This applies to a request result, a delivery stack load, the rotation code, a capture import and a replay upload.
- A rotation that already stops the old sender ends first. Its own rule applies to the records of the old context. A rotation that did not reach that step stops and rejects.
- A rotation that the shutdown stops after it took the old records rejects. `onDrop` reports the records that it took and that nothing keeps, with `security_context`. A rotation that the shutdown meets in its storage step does not apply the new context.

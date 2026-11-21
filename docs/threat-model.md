# Threat Model

The library runs inside your page. It reads values from your code, from other documents and from the ingest server. It sends records to a server that you own. This page lists the trust boundaries, the threats at each boundary and the controls of the library.

## Assets

- The records, and the personal data or secrets that they can hold.
- The request headers, for example an `Authorization` token from `headers`.
- The function of your page. The library must not break a request, a click or a render.
- The ingest server. The library must not flood it.

## Out of Scope

- A hostile script on the same origin. It can read the storage, call the API and replace the functions that the library wraps.
- XSS in your app.
- The security of your ingest server. `tools/reference-collector.mjs` shows origin checks, a token check, a rate limit and size limits.

## Boundaries and Controls

### 1. Your Code to the Library

| Threat | Control |
| --- | --- |
| A value with a cycle, a getter that throws, a BigInt or a large string. | The sanitizer stops cycles, catches each getter, converts BigInt and applies `limits`. A record above `limits.maxRecordBytes` drops its caller attributes. |
| A hook (`redact`, `processors`, `contextProvider`, a plugin) throws. | The library catches it and reports a diagnostic code. A hook that throws in `redact` or in a processor drops the record. It does not send the record unclean. The library guards only `install()` and `uninstall()` of a plugin. The listeners of a plugin run outside the guards. If `onDiagnostic` throws, the library prints no exception text. The optional console fallback prints a fixed warning only. A `redact` value that is not a function keeps the current hook. Without a current hook, the library drops each record and reports `record.dropped_by_redact`. This continues until a `configure()` call sets `redact` to a function or `null`. A `processors` list with an entry that is not a function keeps the current list. Without a current list, the library drops each record until `processors` is a list of functions or `[]`. If the first `configure()` call cannot read its options, the library installs no capture and drops each record until a call sets `redact` to a function or to `null`. It also drops the records that log calls held before that call, and it writes no id to storage. `getHealth()` reports `records.refused` in each of these cases. Thus a typo does not send a raw record. |
| Personal data in a record. | `redact` runs last, after the processors, on each record and span. The sender also runs its `redact` on each record from a frame or a worker. Its processors do not run on such a record. Put a privacy rule in `redact`, not in a processor. With `redact`, the console prints what `redact` returns. A record below `minLevel` or outside the sample also goes through the hooks before the console prints it, and before a breadcrumb keeps it. `onDrop` gets forwarded records only after `redact`. |

A log call before the first `configure()` call that works keeps its record in memory. No hook exists yet. At the start, the library runs the `processors` and the `redact` of the startup call on each held record. The configured levels, sampling, limits and `page.url` rule also apply. The record then goes out. If the startup call has `enabled: false`, the hooks run on the held records before `onDrop` reports them with `disabled`. A log call before the start also adds a breadcrumb with its raw body. The start removes these breadcrumbs. The breadcrumbs of `addBreadcrumb()` stay. The hooks of each record that carries them apply to them.

The refusal after a failed first `configure()` call ends at `shutdown()`. The next `configure()` builds a new runtime with no refusal.

A frame that becomes a sender runs only its own `redact`. The `redact` of the parent does not apply to its records. A frame becomes a sender when it gets no owner. An example is a frame whose bus protocol tag is different from the tag of its parent. Another example is a frame or a worker that starts before its parent runtime starts. This occurs before the first `configure()` call of the parent works, and while that call has `enabled: false`. The child waits 1,500 ms, or 3 attempts of 1,500 ms in a cross-origin frame. Call `configure()` in the parent before child frames load. A same-origin `srcdoc` frame and a same-origin `about:blank` frame get an owner after `registerFrame()`. The `location.origin` of such a frame is `"null"`. The frame gives the parent the value of its `origin` global instead. A `srcdoc` or `about:blank` frame on 0.12 or older gives `"null"`. The parent refuses it, and the frame becomes a sender. Set `redact` in each frame that can hold personal data.

With `payloadMode: "defer"`, the queue holds raw payload references until the idle build. Processors and `redact` run before console output or delivery. A debug bundle excludes the raw queue. A fixed count cap limits retained references. The library drains pending calls before a session or delivery identity change.

After its `redact`, the sender puts back the encoding fields of a forwarded metric point or span. Examples are the bucket counts and the span times. It does this only when `log.type` and `app.namespace` have the values that the library sets for a point or a span. It puts back a group of fields only when each value has the library's shape. It never puts back `metric.name`, `metric.unit` or `metric.attribute_keys`. Each other attribute stays as `redact` left it. An app that uses the names of the library can still pass values through. Examples are a logger with the namespace `uiobs.metrics`, and the attributes `span.link.trace_id` and `span.link.span_id` on a measure. A hostile frame or worker can still send numbers and IDs in the encoding fields.

With `debugBuffer`, a kept record has only the hooks of its log call. A change of `redact` or `processors` empties the buffer. A kept record then cannot skip a new hook. A debug bundle holds these records with their context attributes. Review a bundle before you send it to a support system.

### 2. The Page to the Records

| Threat | Control |
| --- | --- |
| A token in a query string, a fragment or the user info. | The library removes the user info from each URL that it records. Without `capture.fullUrls`, it also removes the query and the fragment. User timing names follow this rule. In a diagnostic record, the `url` and `endpoint` detail fields never keep a query or a fragment. A stack trace keeps its script URLs. |
| A token in a WebSocket URL. | The WebSocket capture removes the user info, the query and the fragment, also with `capture.fullUrls`. Only `capture.urlTransform` can record more. |
| A click records the text or the attributes of an element. | Click capture records an application action name by default, for example `data-observability-action`. It reads no text and no selector unless `capture.interactions` turns them on. It skips regions in `[data-observability-ignore]`. Session replay blocks the same regions. |
| A resource field identifies a user or a device. | `metadata.pageUrl`, `metadata.userAgent` and `metadata.openfin` can remove `page.url`, `browser.user_agent` and the OpenFin fields. |
| Message content and request bodies. | The library never records a request body, a response body or WebSocket message content. |
| `console.error(error.response)` from third-party code. | `capture.console` is off by default. [Auto-Capture Options](configuration.md#auto-capture-options) tells you to set `redact` first. |

Browser reports contain only fixed fields. The capture omits message text and code samples. It removes credentials, queries and fragments from report URLs. Server-Timing descriptions are server data. The ordinary processors and `redact` apply to them before delivery.

### 3. Patched Globals on the Page

The captures wrap `fetch`, `XMLHttpRequest`, `console`, `WebSocket` and `history`.

| Threat | Control |
| --- | --- |
| A fault in a wrapper fails the call of the page. | Each wrapper calls the original. A read or a record runs in a guard. A failed header add sends the request unchanged. |
| A `traceparent` breaks CORS or tells a third party the trace id. | The library adds `traceparent` only to the origins in `capture.propagateTraceHeaderTo`. The list is empty by default. |
| Uninstall removes the wrapper of another script. | The library restores a function only if it still holds the library wrapper. The console and WebSocket captures report `capture.install_failed` if not. A library wrapper under the wrapper of another script then passes each call through. Each pause and resume behind such a wrapper adds one more of these inactive wrappers. |
| A pause leaves the page patched. | `enabled: false` removes each patch, each capture listener and the replay recorder. The library adds no trace header during the pause. `enabled: true` installs them again. |
| A request of the library logs a record that causes a request. | The ingest endpoints are in `capture.ignoreUrls`. The requests of the library and of a custom transport run in a library scope. The network capture skips them. The WebSocket capture skips a socket in `capture.ignoreUrls` and does not count a send in the library scope. |
| A storm of errors, console lines, long frames, reports, resources or lifecycle events. | The error, console, long frame, WebSocket, report, resource and lifecycle captures have separate rate limits for each 10-second window. Records at or above `sampling.alwaysSampleFrom` have a ceiling. |

### 4. Other Documents (the Bus)

| Threat | Control |
| --- | --- |
| A hostile frame sends records or journeys. | By default, a child window must be registered with its exact origin and permissions. The bus checks each record and each control message. It applies configurable size and rate limits. Origin-based discovery is an explicit option. A registration also connects a same-origin `srcdoc` frame or `about:blank` frame. The parent runtime compares the `origin` global of such a frame with the registered origin. On the direct link, the same-origin read of the parent runtime is the only gate, and the parent trusts the origin that the child reports. Without a direct link, a frame tries the message link. The frame finds the origin of its parent in `location.ancestorOrigins`, then in the referrer. Firefox gives a `srcdoc` frame neither of them. The frame then reads the `origin` global of its parent. Only a same-origin parent gives a string. The frame refuses each other value. The value is also correct for a `srcdoc` parent. The frame never posts to `"*"` or to the origin `"null"`. A `srcdoc` frame compares the origin of a sampling answer with its `origin` global. A `srcdoc` parent uses its `origin` global for its own origin in the same way. It sends a new security context to its direct children. Under `bus.sourcePolicy: "trusted-origin"`, it accepts its same-origin children. |
| A closed window keeps a document in memory. | The bus drops a link when its window closes. The app removes a registration with the function that `registerFrame()` or `registerWorker()` returns. |
| A registration outlives its runtime. | `shutdown()` removes each `registerFrame()` and `registerWorker()` registration. It reports no diagnostic. A later `configure()` starts a bus with no registered child. Under the `registered` policy, that bus refuses each child until the app registers it again. |
| A child claims the authority of the owner. | Only the negotiated upstream owner can publish sampling rules or a delivery identity. Its link, its owner id and its transport identity must all match. A child cannot get owner authority with a false message field. |
| One child floods the owner or its siblings. | Each physical source has its own rate budget. A change of a self-reported id does not reset it. The owner answers a hello or a question only to the child that asked. `null` on a bus limit removes that bound, so set it only for children that you trust. The bus limits do not accept `0`. |
| A same-origin frame runs another version. | The frame compares the bus protocol tag of the parent runtime before a direct call. Only the frame makes this check. A frame on 0.12 or older makes no check. It calls a newer parent directly. |
| A parent on 0.9.5 to 0.12 has no tag field. | These versions use the tag `ui-observability/2`. The frame identifies such a parent by its `busCanAccept` function. It uses the direct call. The `redact` of the parent applies. A `srcdoc` frame and an `about:blank` frame also use the direct call. |
| A frame and its parent have different tags. | The frame reports `bus.protocol_mismatch` and tries a message link. The parent ignores an envelope with a different tag. The frame becomes a sender. Its own `redact` applies, not the `redact` of the parent. |
| A child floods the owner with flush requests. | A flush request needs the `records` permission, as a record message does. No link carries a flush request over broadcast, under each policy. A forwarder takes a request from its own children. On the direct link it also takes one from its upstream, which is a same-origin parent. The rate limit of the source applies to each request. While a flush that a request started runs, the other requests wait for one more flush. Two such flushes start at least `BUS_FLUSH_GAP_MS` (1000 ms) apart. A request in the gap joins the next flush. `BUS_MAX_FLUSH_REQUESTS` (100) limits all waiting requests, and `BUS_MAX_FLUSH_REQUESTS_PER_SOURCE` (4) limits the waiting requests of one source. A request past a limit gets no answer, and the bus counts `bus.rejected_message`. A flush that a request starts does not send the open interval of the metrics and the profiler of the owner. |
| A context sends a false flush answer. | The owner answers only on the link of the request, with the id of the request. A forwarder takes an answer only from its upstream owner, for an id that it waits for. On the OpenFin link, the transport identity of the owner must be known and must match. Each context on the OpenFin link can read each answer. An answer holds counts only. The forwarder checks the status and each count, and ignores an answer with a value it does not know. It also ignores `"complete"` with pending records. The answer is information only. A false answer can give a false count, but it cannot change the delivery. |
| A paused context relays records. | A paused sender and a paused forwarder drop the records that a child context sends. `onDrop` reports them with `disabled`, after sampling and `redact`. A paused forwarder does not relay them to its owner. It ignores the records that come from the link of its owner, as an active forwarder does. |
| A frame joins before the app configures. | The bus starts only when the runtime starts, at the first `configure()` call that works with `enabled: true`. A `registerFrame()` or `registerWorker()` call before that waits for the start. |
| A forged journey token. | `adoptJourney()` checks the shape, the start time and the age of the token. It refuses a token without a start time, or with a start time more than 5 minutes ahead. |

### Transport worker

The app supplies a trusted dedicated worker script. The worker receives resolved request headers and records after processors and redaction. It receives no header function or app hook. Use the same SDK version in the page and the worker.

### Session Replay

The session replay sends a copy of the DOM to `replay.endpoint`. It is off by default.

- The recorder masks the text of each element and the value of each `input`, `textarea` and `select`, unless the app changes `replay.maskText` or `replay.maskInputs`. A password input is always masked. The text in an element with `data-observability-unmask` stays.
- The mask has limits. An attribute value stays in clear text, for example `title`, `alt`, `placeholder`, `aria-label` and `data-*`. The `value` of a checkbox, a radio button, a button and an `<option>` stays. A URL in `href` or `src` keeps its query. The CSS text, the content of a `<meta>` element and a comment stay. A masked text keeps the length of each word.
- The SDK removes the query of the page URL from a replay event unless `capture.fullUrls` is set. It masks a text that is directly in a shadow root, which the recorder does not mask in a mutation.
- Page content can add `data-observability-unmask` only if the app puts user HTML into the page with its attributes. A `replay.maskSelectors` entry wins over the attribute.
- The recorder always blocks each element in `[data-observability-ignore]`, in addition to `replay.blockSelectors`. Click capture skips the same regions. The app cannot turn off this block. A custom `capture.interactions.ignoreSelector` does not change it.
- A blocked element becomes a placeholder in the replay. The placeholder keeps the tag, the class and the size of the element. When the app adds the attribute to an element later, the block applies from the next full snapshot.
- A change of `replay.endpoint` or a new `replay.onSegment` function drops the buffer and the segments that wait. A change of only `replay.headers` keeps them. They then go out with the new headers. Isolation does not cover `replay.headers`. Call `stopReplay()` before such a change when the old events must not go out with the new headers.
- A new `replay.recordOptions` object or a new plugin function starts a new recording and drops the buffer. An option of the old plugin then records no more events.
- `redact` and `processors` do not apply to a replay event. `replay.recordOptions` accepts only options that do not turn off a mask.
- An invalid `maskSelectors` or `blockSelectors` entry stops the replay.
- The replay request has only `replay.headers`. The token of the log endpoint does not go to the replay endpoint. `credentials` applies, and its default sends no cookie.
- `enabled: false` stops the recorder and drops the buffer. `enabled: true` starts a new recording.
- `newSession()` and `rotateSecurityContext()` drop the replay buffer and start a new recording. `stopReplay()` stops the recorder and the request in flight. A later `configure()` and a remote capture switch do not start it again.
- An error record starts at most `replay.uploadsPerWindow` uploads in each window. An upload has a fixed length of `replay.afterErrorMs`. Page content that causes errors cannot upload the full session.
- The console plugin and the network plugin of the recorder record what the app gives them. The `transformRequest` tool skips each endpoint of the SDK and removes the query of a recorded URL. The SDK cannot mask a console argument, a header or a body.
- The app decides what is legal to record.

### Profiler

The profiler sends the durations of app code to the ingest endpoint. It is off by default.

- A probe name is a string of the app. It goes into each record as `profile.probe`, and into a breadcrumb for a slow span. Do not put personal data or a user id in a probe name. `processors` and `redact` apply to the `profile.*` attributes.
- A hostile name or a hostile option cannot throw into the app. A name that is not a string gives a probe that does nothing. The library reads an option one time and catches a getter that throws.
- The profiler keeps one core for each library version at a global symbol. Each script of the page can read that symbol and add durations, as it can call each other function of the library. See boundary 3.
- `profiler.maxProbes` and the limit of 1024 names stop a page that makes probe names without end. The memory of the typed arrays is fixed at startup.
- With `securityContext.isolation`, a rotation drops the profiler data and each open span. A span of the previous identity adds no value to the next identity.
- `profiler.framePhases` and `profiler.framePacing` read only browser timing entries. They record no script URL and no element.

### Command Line Tool

`uiobs doctor` runs on your machine, not in the page. It sends test batches only to the URL that you name. It follows no redirect. It sends no credentials and no `Authorization` header by default. It sends a custom header only when you give one with `--header`. A result line prints no header value. A usage report prints only the known words and a URL with no query and no user info. It refuses a URL with a user name or a password. A test record has `service.name: "uiobs-doctor"`. With `--replay`, it sends four test segments to the URL that you name. One segment has 5 MB. Each segment has `service.name: "uiobs-doctor"` and no page content.

The handshake transfers a private message port. Jobs and results use only that port. Each message has a fixed protocol tag and the exact SDK version. The worker validates jobs before it uses their endpoints or headers. The main thread validates status codes and response hints. The worker limits active jobs to 64.

A rotation stops the old channel and terminates the old worker before new routing settings apply. Each job keeps its endpoint and headers. Old results cannot change the state of a new sender. Worker failures use HTTP fallback or the stored retry path. The server still owns deduplication and authorization.

### 5. The Ingest Server to the Library

| Threat | Control |
| --- | --- |
| A server enables sensitive capture. | Only boolean switches in the local `capture.remoteToggles` list apply. The list is empty by default. The server cannot change privacy controls. |
| Hostile sampling rules. | The library reads `X-UiObs-Sampling` only from the answer to its own batch, and only with `sampling.remote`. It checks the version, the TTL, each rate and each level, and the size. `sampling.remoteMaxRate` caps each rate. Its default is 1, which caps nothing. A remote level can only lower a level. |
| A remote switch undoes a pause or a refusal. | A remote capture switch installs no capture during a pause or before the start. Remote rules cannot change `redact` or `processors`, so a refusal stays. |
| A large `Retry-After`. | The library waits `delivery.retryMaxDelayMs` at most. The default is 60 seconds. |
| A 413 answer with a false limit. | The library splits the batch. A single record above the limit is dropped and reported. |
| A false or long `partialSuccess`. | The library uses a rejected count only up to the size of the batch. It reads at most 16 KiB of the body. A diagnostic keeps at most 256 characters of the server message. The library does not send the batch again. |
| A response body that stalls or fails. | The request deadline ends the read. The library then uses the status code alone. It does not send an accepted batch again. |

### 6. The Library to the Ingest Server

| Threat | Control |
| --- | --- |
| A token goes to the wrong tenant after an endpoint change. | The exit flush sends the cached headers only while the `headers` function and each endpoint are the same. An endpoint URL with a user name or a password is refused. A relative endpoint URL resolves against the page, and the report names the origin that receives the records. |
| Old records go out with new credentials after a logout or a tenant change. | With isolation, the default, each batch keeps its delivery context id. `rotateSecurityContext()` cancels the old requests, and the transport refuses a batch of another context. Stored batches of another context stay parked. A rejected rotation fails closed. A rotation code chunk that does not load also closes the delivery. The browser keeps that failed load until a reload. Each later rotation in the page then fails too. The library then sends no record with the old endpoint or headers until a rotation succeeds. Until a reload, change the context with `shutdown({ pending: "discard", clearStorage: "context" })` and then `configure()`. A delivery stack load that ends after the rejection stops its own sender. Rotations run in call order, so a logout that starts during a login is not lost. A rotation with `discard` or `flush` and no running sender, for example during a pause or before consent, opens the store. It removes the stored batches of the old context, and the batches that a carry left under an older id. `onDrop` reports each dropped record with `security_context`. `headers: undefined` keeps the headers, so an unset variable does not remove a token. With isolation on, `configure({ headers: null })` is a refused change. Use a rotation at logout. |
| Cookies go to the ingest server. | `credentials` is `"omit"` by default. Each exit `fetch` obeys `credentials`. The exit flush uses `sendBeacon` only with `credentials: "include"`, because a beacon always uses the credentials mode `include`. |
| Duplicate batches. | Each batch has an id in `X-UiObs-Batch-Id` and `uiobs_batch_id`. The server must deduplicate for 24 hours. |
| Retry floods the server. | One timer, exponential backoff with full jitter, a Web Lock across tabs for each storage namespace and a drop after `retention.maxAttempts`. |

### 7. Records at Rest on the Device

| Threat | Control |
| --- | --- |
| Another user of the device reads the stored records. | IndexedDB and `localStorage` keep failed batches for `retention.maxAgeMs`. Use `storage: { backend: "memory" }` and `identity: "memory"` to write nothing to the device. With these settings, the exit flush does not use the emergency queue. A batch that it cannot send is lost. |
| The library stores data before the app configures it. | Before the first `configure()` call that works, the ids live in memory. The library writes nothing to `localStorage`, `sessionStorage` or IndexedDB. A first call with `enabled: false` keeps this rule until `enabled: true`. Two calls are exceptions, because they open the store to delete. They are `shutdown()` with `clearStorage` and a logout rotation with `discard` or `flush`. Before the first `configure()` call that works, `clearStorage` removes nothing, because no store is known. During a pause, a rotation with `retain` also stores the waiting records under the old context. |
| The next user of a shared device sees the trail of the previous user. | Use awaited `rotateSecurityContext()` at logout to retire queued delivery and clear ambient state. `newSession()` only rotates correlation and breadcrumbs. Isolation can be explicitly disabled. After a rejected rotation, the next rotation that succeeds applies its `pending` rule to the stored records and the emergency queue of the closed context. With `flush`, it removes them as `discard` does. If the rotation code did not load, no later rotation in the page succeeds. Then call `shutdown({ pending: "discard", clearStorage: "context" })` and `configure()`. A plain `shutdown()` keeps the stored batches and the session id of the previous user. A logout rotation also removes the stored batches of the old context when no sender runs, for example during a pause or before consent. A batch that a carry left under an older id goes too. When the device goes to the next user, call `shutdown({ pending: "discard", clearStorage: "namespace" })`. `"context"` keeps the parked batches of other contexts. By default, each page load starts a new context. These include the batches of earlier page loads. They stay for `retention.maxAgeMs`. The call sends nothing. It removes the stored batches, the emergency queue entries, the stored session id, the tab id and the journey. It clears the breadcrumbs, the ambient context, the debug buffer and the active journey of the stopped runtime. A later `shutdown()` with `clearStorage` also works, after the first one ends. After `shutdown()`, a journey call writes nothing to `sessionStorage`. A late request result, delivery stack load, rotation step, capture import or replay upload writes nothing after it. A request in flight can still reach the server. |

## Supply Chain

The package has no runtime dependencies and no install script. Its `bin` entry runs only when you call `uiobs`. `@opentelemetry/api` and `web-vitals` are optional peers. The library loads them only through `otelLoader` and `capture.webVitals.loader`, which your code supplies.

Defaults and intentional policy overrides are documented in [runtime policies](runtime-policies.md). Client-side controls do not authorize tenant access on the ingest server.

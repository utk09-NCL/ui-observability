# Browser Support

The build targets ES2021. The library runs in Chrome 85, Edge 85, Firefox 79 and Safari 14.1, and in each later version. OpenFin runs it as Chromium. OpenFin support is not validated on a real OpenFin runtime.

- A smoke test passed in builds of Chromium 86, Firefox 80 and WebKit 14.2 on 2026-11-17. It loads the library, sends, stores, retries and sends the exit flush.
- No test runs in Chrome 85, Edge or a real Safari 14.1. A WebKit build is not Safari.
- Firefox before 133 ignores the `keepalive` option. There, the exit flush sends a normal request, which the browser can stop when the page closes.

The library tests each optional browser API before it uses it. Without the API, it uses a fallback and reports a diagnostic code where the table says so. A missing API never throws into your code.

| API | Use | Without it |
| --- | --- | --- |
| `fetch` | Sends each batch. | The library cannot send. Use a custom `transport`. |
| `fetch` with `keepalive` | Sends from a hidden page and at exit, unless the exit uses `sendBeacon`. | The browser can stop the request at page close. The library then loses the batch. `onDrop` does not report that loss. |
| `fetch` with `priority` | Sends each batch at `delivery.priority`. | The browser ignores the hint. |
| `navigator.sendBeacon` | At exit to another origin, with `credentials: "include"` and no `headers`. | The library uses a keepalive fetch. |
| `navigator.sendBeacon` | With `credentials: "include"`, also to the page origin from a sandboxed, `srcdoc` or `about:blank` frame. | The library uses a keepalive fetch. |
| `navigator.sendBeacon` | Also to the page origin from a page with a replaced `origin` global. | The library uses a keepalive fetch. |
| `CompressionStream` | Gzips a body above 1 KiB. | The library sends the body without gzip. |
| `indexedDB` | Stores failed batches. | The library uses `localStorage`, then memory. It reports `storage.unavailable`. |
| `navigator.storage.persist()` | `storage.requestPersistent`. | `getHealth()` reports `storagePersistence: "unsupported"`. |
| `localStorage` | Session id, emergency queue, storage fallback. | The session id changes at each load. The emergency queue cannot keep a batch. It reports `storage.unavailable`. |
| `sessionStorage` | Tab id, journey and the marker of `capture.uncleanExit`. | The tab id and the journey stay in memory for this document. |
| `navigator.locks` (Web Locks) | One tab at a time sends the stored batches of one storage namespace. | Each tab drains the stored batches. The server deduplicates the copies by batch id. |
| `BroadcastChannel` | Control messages between the tabs of an origin. | The tabs do not share a journey and do not find a duplicated tab id. |
| `crypto.randomUUID` | Ids. | The library uses `crypto.getRandomValues`, then `Math.random`. |
| `PerformanceObserver` `long-animation-frame` | `capture.longFrames`. | The library observes `longtask`. Without it, the capture is off and reports `capture.install_failed`. |
| `PerformanceObserver` `long-animation-frame` | `profiler.framePhases`. | The capture is off and reports `capture.install_failed` one time. Firefox and Safari have no long animation frames. |
| `requestAnimationFrame` | `profiler.framePacing`. | The frame pacing is off and reports `capture.install_failed` one time. |
| `requestAnimationFrame` and `MessageChannel` | `endAfterPaint()` of a profiler probe. | The span ends at the call, as with `end()`. |
| `performance.now()` | Times each profiler span. | The browser rounds the clock, for example to 0.1 ms or to 1 ms. A span shorter than one clock step reads 0 or one step. |
| `@rrweb/record` package | `replay`. | The replay is off and reports `config.invalid`. Set `replay.loader`. |
| `AbortController` | Stops a replay request at `delivery.requestTimeoutMs` and at `stopReplay()`. | Each current browser has it. |
| Dedicated `Worker` and `MessageChannel` | `transportWorker` with `serveTransportWorker()`. | A startup or channel failure selects the main HTTP path. |
| `requestIdleCallback` and `cancelIdleCallback` | `payloadMode: "defer"`. | A timer builds the pending records. |
| `ReportingObserver` | `capture.reports` deprecations and interventions. | CSP DOM events remain active. The capture reports `capture.install_failed`. |
| `securitypolicyviolation` | `capture.reports` CSP reports. | The browser emits no CSP records. |
| `PerformanceObserver` `resource` | `capture.resourceTiming`. | The capture is off and reports `capture.install_failed`. |
| `Server-Timing` response header | `capture.serverTiming`. Cross-origin responses must expose the header. | Request capture continues without server timing entries. |
| Page visibility, freeze, resume and pageshow events | `capture.lifecycle`. | The capture reports only the states that the browser emits. |
| `PerformanceObserver` `measure` and `mark` | `capture.userTiming`. | The capture is off and reports `capture.install_failed`. |
| `web-vitals` package | `capture.webVitals`. | LCP, CLS, INP, FCP and TTFB are off. The navigation timing continues. Set `capture.webVitals.loader`. |
| `WebSocket` | `capture.webSocket`. | The capture installs nothing. |
| `pagehide`, `visibilitychange`, `freeze` | Exit flush. | A browser without `freeze` uses `pagehide` and `visibilitychange`. |

## Contexts

| Context | Behavior |
| --- | --- |
| Top-level document | Sends its own records and the records of its frames and workers. |
| Same-origin iframe | Forwards its records through a direct call after `registerFrame()`. A `srcdoc` or `about:blank` frame does the same. With a different bus protocol, it sends its own records. A frame inside it forwards through it. Without a direct call, the frame tries `postMessage`. Firefox gives a `srcdoc` frame no `location.ancestorOrigins` and no referrer. The frame then reads the `origin` global of the parent. |
| Cross-origin iframe | Forwards over `postMessage` after the parent registers its window/origin with `registerFrame()`. The child trusts its parent origin. |
| Worker | Forwards its records after `registerWorker(worker)` in the page. Without it, the worker sends its own records. A worker has no document. The session replay is off there, and `endAfterPaint()` ends the span at the call. |
| Sandboxed iframe | Storage throws. The library keeps the ids and the batches in memory. |
| Private browsing | IndexedDB can be off. The library uses `localStorage` or memory. |
| OpenFin | A view forwards its records to the provider over `InterApplicationBus`. It flushes on `close-requested`. |
| Node 22 or later | Console only. The package has no `engines` field. The tests run on Node 22.22.3. See [Core Architecture](architecture.md#core-architecture). |

See [runtime policies](runtime-policies.md) for origin-based discovery overrides, source permissions and security-context coordination.

The app bundles its transport worker with the same SDK version as the page. Browser worker policy and the ingest CORS rules still apply. Worker transport uses the built-in OTLP or ECS serializer. With a custom serializer, the log batches use the main thread. The metric and span batches still use the worker, because they always use OTLP. Test worker startup, fallback, page exit and rotation in a real browser before release.

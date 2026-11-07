# Browser Support

The build targets ES2022. Current versions of Chrome, Edge, Firefox and Safari run the library. OpenFin runs it as Chromium.

The library tests each optional browser API before it uses it. Without the API, it uses a fallback and reports a diagnostic code where the table says so. A missing API never throws into your code.

| API                                                 | Use                                                                      | Without it                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `fetch`                                             | Sends each batch.                                                        | The library cannot send. Use a custom `transport`.                                                              |
| `fetch` with `keepalive`                            | Sends from a hidden page and at exit with `headers`.                     | The request can stop when the page closes. The next load sends the batch from the emergency queue.              |
| `fetch` with `priority`                             | Sends each batch at `delivery.priority`.                                 | The browser ignores the hint.                                                                                   |
| `navigator.sendBeacon`                              | Sends at exit without `headers`.                                         | The library uses a keepalive fetch.                                                                             |
| `CompressionStream`                                 | Gzips a body above 1 KiB.                                                | The library sends the body without gzip.                                                                        |
| `indexedDB`                                         | Stores failed batches.                                                   | The library uses `localStorage`, then memory. It reports `storage.unavailable`.                                 |
| `navigator.storage.persist()`                       | `persistence.requestPersistent`.                                         | `getHealth()` reports `storagePersistence: "unsupported"`.                                                      |
| `localStorage`                                      | Session id, emergency queue, storage fallback.                           | The session id changes at each load. The emergency queue cannot keep a batch. It reports `storage.unavailable`. |
| `sessionStorage`                                    | Tab id, journey and the marker of `capture.uncleanExit`.                 | The tab id and the journey stay in memory for this document.                                                    |
| `navigator.locks` (Web Locks)                       | One tab at a time sends the stored batches of one persistence namespace. | Each tab drains the stored batches. The server deduplicates the copies by batch id.                             |
| `BroadcastChannel`                                  | Control messages between the tabs of an origin.                          | The tabs do not share a journey and do not find a duplicated tab id.                                            |
| `crypto.randomUUID`                                 | Ids.                                                                     | The library uses `crypto.getRandomValues`, then `Math.random`.                                                  |
| `PerformanceObserver` `long-animation-frame`        | `capture.longFrames`.                                                    | The library observes `longtask`. Without it, the capture is off and reports `capture.install_failed`.           |
| Dedicated `Worker` and `MessageChannel`             | `transportWorker` with `serveTransportWorker()`.                         | A startup or channel failure selects the main HTTP path.                                                        |
| `requestIdleCallback` and `cancelIdleCallback`      | `payloadMode: "defer"`.                                                  | A timer builds the pending records.                                                                             |
| `ReportingObserver`                                 | `capture.reports` deprecations and interventions.                        | CSP DOM events remain active. The capture reports `capture.install_failed`.                                     |
| `securitypolicyviolation`                           | `capture.reports` CSP reports.                                           | The browser emits no CSP records.                                                                               |
| `PerformanceObserver` `resource`                    | `capture.resourceTiming`.                                                | The capture is off and reports `capture.install_failed`.                                                        |
| `Server-Timing` response header                     | `capture.serverTiming`. Cross-origin responses must expose the header.   | Request capture continues without server timing entries.                                                        |
| Page visibility, freeze, resume and pageshow events | `capture.lifecycle`.                                                     | The capture reports only the states that the browser emits.                                                     |
| `PerformanceObserver` `measure` and `mark`          | `capture.userTiming`.                                                    | The capture is off and reports `capture.install_failed`.                                                        |
| `web-vitals` package                                | `capture.webVitals`.                                                     | The capture is off. Set `capture.webVitalsLoader`.                                                              |
| `WebSocket`                                         | `capture.webSocket`.                                                     | The capture installs nothing.                                                                                   |
| `pagehide`, `visibilitychange`, `freeze`            | Exit flush.                                                              | A browser without `freeze` uses `pagehide` and `visibilitychange`.                                              |

## Contexts

| Context               | Behavior                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level document    | Sends its own records and the records of its frames and workers.                                                                                      |
| Same-origin iframe    | Forwards its records to its parent through a direct call after the parent registers it with `registerFrame()`. A frame inside it forwards through it. |
| Cross-origin iframe   | Forwards over `postMessage` after the parent registers its window/origin with `registerFrame()`. The child trusts its parent origin.                  |
| Worker                | Forwards its records after `registerWorker(worker)` in the page. Without it, the worker sends its own records.                                        |
| Sandboxed iframe      | Storage throws. The library keeps the ids and the batches in memory.                                                                                  |
| Private browsing      | IndexedDB can be off. The library uses `localStorage` or memory.                                                                                      |
| OpenFin               | A view forwards its records to the provider over `InterApplicationBus`. It flushes on `close-requested`.                                              |
| Node 22.22.3 or later | Console only. See the README.                                                                                                                         |

See [runtime policies](runtime-policies.md) for origin-based discovery overrides, source permissions and security-context coordination.

The app bundles its transport worker with the same SDK version as the page. Browser worker policy and the ingest CORS rules still apply. Worker transport uses the built-in OTLP or ECS serializer. A custom serializer runs on the main thread. Test worker startup, fallback, page exit and rotation in a real browser before release.

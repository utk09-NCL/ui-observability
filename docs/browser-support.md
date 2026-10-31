# Browser Support

The build targets ES2022. Current versions of Chrome, Edge, Firefox and Safari run the library. OpenFin runs it as Chromium.

The library tests each optional browser API before it uses it. Without the API, it uses a fallback and reports a diagnostic code where the table says so. A missing API never throws into your code.

| API                                          | Use                                                  | Without it                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `fetch`                                      | Sends each batch.                                    | The library cannot send. Use a custom `transport`.                                                              |
| `fetch` with `keepalive`                     | Sends from a hidden page and at exit with `headers`. | The request can stop when the page closes. The next load sends the batch from the emergency queue.              |
| `navigator.sendBeacon`                       | Sends at exit without `headers`.                     | The library uses a keepalive fetch.                                                                             |
| `CompressionStream`                          | Gzips a body above 1 KiB.                            | The library sends the body without gzip.                                                                        |
| `indexedDB`                                  | Stores failed batches.                               | The library uses `localStorage`, then memory. It reports `storage.unavailable`.                                 |
| `localStorage`                               | Session id, emergency queue, storage fallback.       | The session id changes at each load. The emergency queue cannot keep a batch. It reports `storage.unavailable`. |
| `sessionStorage`                             | Tab id and journey.                                  | The tab id and the journey stay in memory for this document.                                                    |
| `navigator.locks` (Web Locks)                | One tab at a time sends the stored batches.          | Each tab drains the stored batches. The server deduplicates the copies by batch id.                             |
| `BroadcastChannel`                           | Control messages between the tabs of an origin.      | The tabs do not share a journey and do not find a duplicated tab id.                                            |
| `crypto.randomUUID`                          | Ids.                                                 | The library uses `crypto.getRandomValues`, then `Math.random`.                                                  |
| `PerformanceObserver` `long-animation-frame` | `capture.longFrames`.                                | The library observes `longtask`. Without it, the capture is off and reports `capture.install_failed`.           |
| `web-vitals` package                         | `capture.webVitals`.                                 | The capture is off. Set `capture.webVitalsLoader`.                                                              |
| `WebSocket`                                  | `capture.webSocket`.                                 | The capture installs nothing.                                                                                   |
| `pagehide`, `visibilitychange`, `freeze`     | Exit flush.                                          | A browser without `freeze` uses `pagehide` and `visibilitychange`.                                              |

## Contexts

| Context             | Behavior                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Top-level document  | Sends its own records and the records of its frames and workers.                                               |
| Same-origin iframe  | Forwards its records to the top-level document over the bus.                                                   |
| Cross-origin iframe | Forwards its records over `postMessage` when `bus.trustedOrigins` of the parent has its origin.                |
| Worker              | Forwards its records after `registerWorker(worker)` in the page. Without it, the worker sends its own records. |
| Sandboxed iframe    | Storage throws. The library keeps the ids and the batches in memory.                                           |
| Private browsing    | IndexedDB can be off. The library uses `localStorage` or memory.                                               |
| OpenFin             | A view forwards its records to the provider over `InterApplicationBus`. It flushes on `close-requested`.       |
| Node                | Console only. See the README.                                                                                  |

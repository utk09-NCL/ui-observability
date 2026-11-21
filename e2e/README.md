# Browser integration tests

These tests run the library source in Chromium, Firefox and WebKit. Each test asserts data that the mock ingest server received. The trace test asserts the request headers from `/__echo`. The other tests assert the payload from `/__received`. The startup burst tests also assert the `onDrop` summaries of the page. The exit flush tests also assert `exit`, `contentType` and `hasCookie` of the request. No test asserts console output.

The tests are separate from `pnpm run verify`. Vitest does not run them.

## Run the tests

1. Install the workspace with `pnpm install`.
2. Install the browsers one time with `pnpm exec playwright install chromium firefox webkit`.
3. Run `pnpm run test:e2e`.

Run one browser with `pnpm run test:e2e --project firefox`. Run one file with `pnpm run test:e2e e2e/logging.e2e.ts`.

Playwright starts three servers and stops them after the run.

| Port | Server | Use |
| --- | --- | --- |
| 5181 | `vite --config vite.cross-origin.config.ts` | The page under test. |
| 5182 | `vite --config vite.cross-origin.config.ts` | The same files from a second origin. |
| 8791 | `UIOBS_MOCK_PORT=8791 UIOBS_MOCK_RECORD=1 node tools/mock-ingest-server.mjs` | The ingest server and its test APIs. |

The run fails when a different program uses one of these ports. Playwright does not use a server that is already there.

The tests run in one worker. All browsers use one mock server, and each test resets it.

Each spec calls `stopLibrary()` after each test. This call runs `shutdown()` in each frame. Without it, Firefox sends the exit flush when Playwright closes the context. That request can arrive after the reset of the next test.

`exit-flush.e2e.ts` leaves the page with a navigation. The call then finds no library in the new document. It still stops the library when a test fails before the navigation.

## Playground smoke tests

`pnpm run test:playground` runs one Chromium smoke test for each playground app. The config is `e2e/playground/playwright.config.ts`. A smoke test has the suffix `.smoke.ts`, so `pnpm run test:e2e` does not run it.

1. Build the library with `pnpm run build`.
2. Install Chromium one time with `pnpm exec playwright install chromium`.
3. Run `pnpm run test:playground`.

Playwright starts three servers and stops them after the run.

| Port | Server | Use |
| --- | --- | --- |
| 5186 | `vite --port 5186` in `playground/react-custom-backend` | The app. |
| 8797 | `UIOBS_MOCK_PORT=8797 UIOBS_MOCK_RECORD=1 node tools/mock-ingest-server.mjs` | The ingest server and its test APIs. |
| 8798 | `UIOBS_APP_API_PORT=8798 node tools/mock-app-api.mjs` | The mock app API. |

The ports differ from the dev ports and from the ports above, so a running example does not clash with a test run.

| Spec | Coverage |
| --- | --- |
| `react-custom-backend.smoke.ts` | The page is cross-origin isolated. A user logs in and places an order. The blotter shows it as filled. `/__received` has `ORDER_PLACED` under `/uilogs`, with a token and a journey id, and a `POST` span under `/v1/traces`. |
| `react-custom-backend.smoke.ts` | A change of a runtime setting applies at once. After **Console output** goes off, the console shows no price line. |
| `react-custom-backend.smoke.ts` | A change of a limit waits as staged. **Apply and restart** applies it. The next order logs `ORDER_PLACED`, and `orders.placed` counts both orders. |
| `react-custom-backend.smoke.ts` | A double click on **Log out** sends one `POST /api/logout`. The button is disabled while the logout runs, and a second logout finds no token. |

## Test APIs of the mock ingest server

| Request | Result |
| --- | --- |
| `POST /__reset` | Clears the received requests, the known batch ids, the forced status and the sampling rules. |
| `GET /__received` | Returns the kept requests for `/v1/logs`, `/v1/metrics`, `/v1/traces`, `/v1/replay` and `/uilogs`. |
| `GET /__echo` | Returns the headers of this request as the server received them. |

Each entry of `/__received` has `batchId`, `attempt`, `exit`, `contentType`, `contentEncoding`, `hasCookie`, `duplicate` and `payload`. `payload` is the parsed JSON body. For an NDJSON body, it is the list of the parsed lines. `hasCookie` tells if the request had a `Cookie` header. The server never keeps the value of a cookie. An entry of `/uilogs` also has `hasAuthorization`, which tells if the request had an `Authorization` header.

- The server keeps a request only when `UIOBS_MOCK_RECORD` is `1`. Without it, `/__received` returns empty lists. The Playwright config sets it.
- The server keeps the last 100 entries for each path.
- The server does not keep a request that it rejects.
- A second request with a known batch id gets `204`, and the server keeps it with `duplicate: true`. Thus a test that counts the records fails when the library sends a batch two times.
- A request with no batch id is never a duplicate. The server keeps it with the batch id `(none)`.

`UIOBS_MOCK_PORT` sets the port of the mock server. The default is 8787.

## Fixtures

- `fixtures/page.html` and `fixtures/page.ts` are the one test page. The page puts the library on `window.e2e.uiobs`. It does not call `configure()`. Each test configures the library in `page.evaluate()`.
- The page keeps the `fetch` of the browser in `window.e2e.nativeFetch`. The trace test waits until `window.fetch` is a different function.
- The same page is the child frame of the forwarding tests.
- The page loads the real recorder in `window.e2e.loadRecorder`. A test passes it as `replay.loader`, because `page.evaluate()` cannot import a package by name.
- `fixtures/transport-worker.ts` calls `serveTransportWorker()`. It sends the URL of each `fetch` to the page on a `BroadcastChannel`.
- `fixtures/silent-worker.ts` loads and gives no ready answer.
- `fixtures/worker-channel.ts` has the name of that `BroadcastChannel`. The page and the worker import it.
- `fixtures/ingest.ts` has the ports, the origins, the Node helpers for the test APIs and `stopLibrary()`. The Playwright config imports the ports from it.

## What each spec covers

| Spec | Coverage |
| --- | --- |
| `logging.e2e.ts` | A logger call arrives at `/v1/logs` with its body, level, scope, attributes and resource attributes. The body is gzip-encoded. |
| `rotation-chunk.e2e.ts` | A failed load of the rotation code rejects `rotateSecurityContext()` with a `TypeError` and closes the delivery. A later rotation in the same page rejects. The browser sends no request for the code. `shutdown({ pending: "discard", clearStorage: "context" })` and `configure()` open the delivery. The next context has a new session id, and no stored batch of the old context stays. After a reload, a rotation works. |
| `startup-burst.e2e.ts` | A page logs one error and 2,000 records before the sender loads. The server gets the error. `onDrop` reports 1,501 records as `buffer_full`. |
| `startup-burst.e2e.ts` | With `buffering.maxHeldRecords: 5000`, the server gets each record of the same burst. `onDrop` reports nothing. |
| `exit-flush.e2e.ts` | After a navigation, the exit batch arrives at another origin as a `text/plain` keepalive `fetch`. It has `uiobs_exit=pagehide` and no cookie. |
| `exit-flush.e2e.ts` | With `credentials: "include"`, the exit batch of the same navigation arrives as a beacon. It has the cookie of the page. |
| `forwarding.e2e.ts` | A same-origin child frame forwards a record through the parent. The `redact` hook of the parent removes a field from it. |
| `forwarding.e2e.ts` | A same-origin `srcdoc` frame forwards a record through the parent. The `redact` hook of the parent removes a field. Only the parent frame posts. |
| `forwarding.e2e.ts` | A `srcdoc` frame forwards a record over `postMessage` when the parent refuses the direct call. The `redact` hook of the parent applies. Only the parent frame posts. In Firefox, the frame reads the `origin` global of the parent. |
| `forwarding.e2e.ts` | A cross-origin child forwards a record when `bus.trustedOrigins` has the origin of the parent. Only the parent frame posts. |
| `forwarding.e2e.ts` | A cross-origin child without `bus.trustedOrigins` resolves to `sender` and posts its own record. The parent posts nothing. |
| `replay.e2e.ts` | The real `@rrweb/record` recorder records the page and a few DOM changes. After an error, `/v1/replay` gets segments that start with a full snapshot. Text is masked. The input value is masked in the snapshot and in the input event. An element with `data-observability-unmask` keeps its text. An element with `data-observability-ignore` has no content. The error record has the `replay.id` of the segments. |
| `trace-propagation.e2e.ts` | A `fetch` to an origin in `capture.propagateTraceHeaderTo` has `traceparent`. A `fetch` to a different origin does not. |
| `worker-transport.e2e.ts` | With `transportWorker`, the worker sends the batch. |
| `worker-transport.e2e.ts` | A worker that gives no ready answer causes the fallback to plain HTTP. The server gets the record one time. No `transport.timeout` diagnostic occurs. |

## Coverage that is missing

These items have no browser test.

- Frame permissions other than `records`, for example `journey:read`, `journey:write` and `sampling:read`.
- A parent that does not register the frame, and `bus.sourcePolicy: "trusted-origin"`.
- Trace propagation for `XMLHttpRequest`, and for a `RegExp` target.
- A transport worker that fails after its ready answer, and a worker script that does not load.
- Offline recovery after a `503` with `Retry-After`.
- A reload that sends the batches in IndexedDB.
- The exit flush on a tab close or a browser close, on `freeze`, with `headers`, and to the origin of the page.
- The emergency queue of the exit flush, and its import at the next page load.
- Security-context rotation with `rotateSecurityContext()`, except a failed load of the rotation code.
- Session replay with `stopReplay()`, `newSession()` and a full buffer.
- The `/v1/metrics` and `/v1/traces` endpoints.
- OTLP receiver interoperability. `tools/check-collector.mjs` and `e2e/collector/` own this check.

## OpenFin

No OpenFin runtime is available in this environment. No test in this folder starts an OpenFin container.

The real-runtime smoke check for OpenFin is a validation gap. It is not a pass. No test in this folder verifies the supported OpenFin versions.

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

| Threat                                                                  | Control                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A value with a cycle, a getter that throws, a BigInt or a large string. | The sanitizer stops cycles, catches each getter, converts BigInt and applies `limits`. A record above `limits.maxRecordBytes` drops its caller attributes.                                                                                                                                                                 |
| A hook (`redact`, `processors`, `contextProvider`, a plugin) throws.    | The library catches it and reports a diagnostic code. A hook that throws in `redact` or in a processor drops the record. It does not send the record unclean. The library guards only `install()` and `uninstall()` of a plugin. The listeners of a plugin run outside the guards.                                         |
| Personal data in a record.                                              | `redact` runs last, after the processors, on each record and span. The sender also runs its `redact` on each record from a frame or a worker. With `redact`, the console prints what `redact` returns. A record that `minLevel` or sampling drops prints its message and its error, because the library does not build it. |

### 2. The Page to the Records

| Threat                                                  | Control                                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A token in a query string, a fragment or the user info. | The library removes the user info from each URL that it records. Without `capture.fullUrls`, it also removes the query and the fragment. A stack trace keeps its script URLs. |
| A token in a WebSocket URL.                             | The WebSocket capture removes the user info, the query and the fragment, also with `capture.fullUrls`.                                                                        |
| Message content and request bodies.                     | The library never records a request body, a response body or WebSocket message content.                                                                                       |
| `console.error(error.response)` from third-party code.  | `capture.console` is off by default. The README tells you to set `redact` first.                                                                                              |

### 3. Patched Globals on the Page

The captures wrap `fetch`, `XMLHttpRequest`, `console`, `WebSocket` and `history`.

| Threat                                                           | Control                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fault in a wrapper fails the call of the page.                 | Each wrapper calls the original. A read or a record runs in a guard. A failed header add sends the request unchanged.                                                                                                                                                        |
| A `traceparent` breaks CORS or tells a third party the trace id. | The library adds `traceparent` only to the origins in `capture.propagateTraceHeaderTo`. The list is empty by default.                                                                                                                                                        |
| Uninstall removes the wrapper of another script.                 | The library restores a function only if it still holds the library wrapper. The console and WebSocket captures report `capture.install_failed` if not.                                                                                                                       |
| A request of the library logs a record that causes a request.    | The ingest endpoints are in `capture.ignoreUrls`. The requests of the library and of a custom transport run in a library scope. The network capture skips them. The WebSocket capture skips a socket in `capture.ignoreUrls` and does not count a send in the library scope. |
| A storm of errors, console lines, long frames or reconnects.     | The error, console, long frame and WebSocket captures have a rate limit for each 10-second window. ERROR and FATAL records have a ceiling.                                                                                                                                   |

### 4. Other Documents (the Bus)

| Threat                                      | Control                                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hostile frame sends records or journeys.  | A cross-origin message must come from an origin in `bus.trustedOrigins`. The list is empty by default. A forwarded record must pass a shape check and sampling.      |
| A closed window keeps a document in memory. | The bus drops a link when its window closes.                                                                                                                         |
| A forged journey token.                     | `adoptJourney()` checks the shape, the start time and the age of the token. It refuses a token without a start time, or with a start time more than 5 minutes ahead. |

### 5. The Ingest Server to the Library

| Threat                           | Control                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hostile sampling rules.          | The library reads `X-UiObs-Sampling` only from the answer to its own batch, and only with `sampling.remote`. It checks the version, the TTL, each rate and each level, and the size. `sampling.remoteMaxRate` caps each rate. Its default is 1, which caps nothing. A remote level can only lower a level. |
| A large `Retry-After`.           | The library waits 60 seconds at most.                                                                                                                                                                                                                                                                      |
| A 413 answer with a false limit. | The library splits the batch. A single record above the limit is dropped and reported.                                                                                                                                                                                                                     |

### 6. The Library to the Ingest Server

| Threat                                                     | Control                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A token goes to the wrong tenant after an endpoint change. | The exit flush sends the cached headers only while the `headers` function and each endpoint are the same.         |
| Cookies go to the ingest server.                           | `credentials` is `"omit"` by default.                                                                             |
| Duplicate batches.                                         | Each batch has an id in `X-UiObs-Batch-Id` and `uiobs_batch_id`. The server must deduplicate for 24 hours.        |
| Retry floods the server.                                   | One timer, exponential backoff with full jitter, a Web Lock across tabs and a drop after `retention.maxAttempts`. |

### 7. Records at Rest on the Device

| Threat                                                                | Control                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Another user of the device reads the stored records.                  | IndexedDB and `localStorage` keep failed batches for `retention.maxAgeMs`. Use `storage: "memory"` and `identity: "memory"` to write nothing to the device. With these settings, the exit flush does not use the emergency queue. A batch that it cannot send is lost. |
| The next user of a shared device sees the trail of the previous user. | `newSession()` clears the breadcrumbs. Call it at logout.                                                                                                                                                                                                              |

## Supply Chain

The package has no runtime dependencies. `@opentelemetry/api` and `web-vitals` are optional peers. The library loads them only through `otelLoader` and `capture.webVitalsLoader`, which your code supplies.

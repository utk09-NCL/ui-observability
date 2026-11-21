# React custom backend example

This example shows the library in a React 19 app that sends its logs to its own backend. A team that moves to its own log backend can copy it.

Read the [playground guide](../README.md) first. It explains the mock ingest server and each line that the terminal prints.

## What it shows

- A custom `serializer` that writes the example "uilogs" JSON. It cuts each record to the limits of the server.
- Relative endpoints behind the Vite proxy. The app sends logs to `/uilogs`.
- `metricsEndpoint` and `tracesEndpoint` with the custom serializer. They always send OTLP.
- A `headers` function that reads the token of the user on each request.
- A login and a logout that follow the recipes in [Production recipes](../../docs/production-recipes.md).
- Vitest specs that use one setup file for all specs. See [One Setup for All Specs](../../docs/guides.md#one-setup-for-all-specs).
- An "Observability settings" section. The user changes the config and sees which value costs less.

The business data comes from the mock app API, `tools/mock-app-api.mjs`.

## Run it

Build the library and start the example from the repository root:

```bash
pnpm run build
pnpm run example:react-custom-backend
```

The command starts three servers.

| Server | Port | Use |
| --- | --- | --- |
| Vite dev server of the app | 5185 | The page. It proxies `/api`, `/uilogs` and `/telemetry`. |
| Mock ingest server | 8787 | The example backend. It accepts `/uilogs`, `/v1/metrics` and `/v1/traces`. |
| Mock app API | 8790 | Login, orders and the WebSocket price stream. |

Open `http://localhost:5185`. Log in with any user name. The terminal of the command shows the lines of all three servers, with the numbers `[0]`, `[1]` and `[2]`.

| Proxy path | Goes to |
| --- | --- |
| `/api` | The mock app API, also for the WebSocket `/api/stream`. |
| `/uilogs` | The mock ingest server, `/uilogs`. |
| `/telemetry/v1/metrics` and `/telemetry/v1/traces` | The mock ingest server, without the `/telemetry` prefix. |

`UIOBS_APP_API_PORT` and `UIOBS_MOCK_PORT` move the proxy targets. The browser smoke test uses them.

## What to look for

| Action | Look for |
| --- | --- |
| **Log in** | `[1] [uilogs] ... auth=none` for the records of the anonymous context. Later batches show `auth=bearer`. |
| **Place order** | `[2] [orders] POST /api/orders ... traceparent=00-...` in the terminal of the app API. |
| **Place order** | `[1] ... ORDER_PLACED  journey=<id>` in a `[uilogs]` batch. |
| **Place order** | A `[traces]` batch with a `[client]  POST` span. About 10 seconds later, a `[metrics]` batch with `orders.placed`. |
| Fault switch **Reject, 422** or **Error, 500**, then **Place order** | `ERROR [log] order refused` in a `[uilogs]` batch. The span of the request has the status `ERROR`. |
| Fault switch **Slow, 2 s**, then **Place order** | The button shows "Placing" for 2 seconds. The span shows the same duration. |
| **Log out** | The terminal shows the last batch of the user. The next batch has `auth=none`. |

The price stream logs each tick at DEBUG in the namespace `market.prices`. It is the noisy namespace for the sampling and level settings.

## The uilogs example shape

The shape is an example for this app. It is not a standard. Replace the field names with the ones of your backend.

```json
{
  "service": "react-custom-backend",
  "userAgent": "Mozilla/5.0 ...",
  "records": [
    {
      "ts": "2026-11-21T10:00:00.123Z",
      "level": "INFO",
      "logger": "orders.ticket",
      "message": "ORDER_PLACED",
      "type": "action",
      "sessionId": "...",
      "tabId": "...",
      "journeyId": "...",
      "traceId": "...",
      "attributes": { "orderId": "ORD-1001", "tenant": "tenant-a" }
    }
  ]
}
```

| Field | Source in the `LogRecord` |
| --- | --- |
| `service`, `userAgent` | `resource["service.name"]` and `resource["browser.user_agent"]` of the first record |
| `ts` | `timeUnixNano`, as an ISO time with milliseconds |
| `level` | `severityText` |
| `logger` | `attributes["app.namespace"]` |
| `message` | `body` |
| `type` | `attributes["log.type"]` |
| `sessionId`, `tabId` | `resource["session.id"]` and `resource["tab.id"]` |
| `journeyId` | `attributes["journey.id"]`, only while a journey runs |
| `traceId` | `traceId` |
| `attributes` | The other attributes of the record |

The example server has four limits. The serializer cuts each record to the first three. The library drops a whole batch that the server refuses with `400`. A split cannot fix one record that is too large.

| Limit | Value | What the serializer does |
| --- | --- | --- |
| Characters in `message` | 2,000 | It cuts the message. |
| Keys in `attributes` | 50 | It keeps the first 49 keys and adds `uilogs.attributes_cut` with the number of removed keys. |
| Bytes of `attributes` as JSON | 16,384 | It keeps the entries that fit and adds `uilogs.attributes_cut`. |
| Records in one request | 500 | It cuts nothing. The server answers `413` above 500 records, and the library splits the batch. |

A batch has no fixed size. The exit flush merges the batches that are queued, the batches in flight and the buffer into one batch. After a burst of records, such a batch can hold thousands of records.

A live batch or a stored batch of more than 500 records gets a `413` from the example server.

- The library then splits the batch in two and sends the halves. A split needs storage.
- A batch can need more than one split. Each further split waits for a later drain, about 30 seconds.
- With `storage.backend: "none"`, the halves have no place to wait. The library loses the batch, and `onDrop` reports `not_stored`.
- `src/observability/split.test.ts` shows both cases with a backend that answers `413` above 20 records.

The exit flush never gets a `413`. A body above about 60 KB goes into the emergency queue. The exit flush does not read the answer of its keepalive request.

- In this app, such a batch stays in the emergency queue. Each page load starts a new security context. Isolation keeps the batches of the old context apart. See [Production recipes](../../docs/production-recipes.md#settings-that-are-fixed-after-startup).
- A later exit can evict the batch. `onDrop` then reports `exit_queue_full`.
- To deliver such a batch after a reload, an app passes a stable `securityContext.id` to `configure()`. For the anonymous context, `sessionStorage` can keep the id.
- This app does not do this. A reload shows the login screen, so a batch of a user context cannot resume anyway.

Your backend must answer `413` for a request that is too large. A backend that answers `400` for such a request makes the library drop the whole batch. The example server answers `413` above 500 records. It answers `400` for a record over a record limit.

`src/observability/uilogs-limits.ts` and `UILOGS_LIMITS` in `tools/mock-ingest-server.mjs` hold the same four numbers. The limits stay in two places on purpose, one for each side. Change both together. A spec that you copy must not read this repository's tools.

A body of 1 KiB or more arrives with `Content-Encoding: gzip`, because the default is `compression: "gzip"`. A backend that cannot decode gzip answers `400`, and the library drops the batch. Set `compression: "none"` for such a backend.

To see a `413`, send 501 records. The server answers `413` with a short JSON body. 500 records give `204`.

```bash
node -e 'const r={ts:"2026-11-21T10:00:00Z",level:"INFO",logger:"a",message:"m",type:"log",attributes:{}};console.log(JSON.stringify({service:"x",records:Array.from({length:501},()=>r)}))' \
  | curl -s -w ' [%{http_code}]\n' -X POST http://localhost:8787/uilogs -H 'content-type: application/json' --data-binary @-
```

```text
{"error":"a request holds at most 500 records","maxRecords":500} [413]
```

To see a `400`, send a message of 2,001 characters with `curl`. The server answers with the text of the problem and the index of the record.

```bash
curl -X POST http://localhost:8787/uilogs -H 'content-type: application/json' \
  -d "{\"service\":\"x\",\"records\":[{\"ts\":\"2026-11-21T10:00:00Z\",\"level\":\"INFO\",\"logger\":\"a\",\"type\":\"log\",\"attributes\":{},\"message\":\"$(head -c 2001 /dev/zero | tr '\0' x)\"}]}"
```

```text
{"error":"message is over 2000 characters","index":0}
```

## The relative endpoint report

The three endpoints are relative URLs, as in an app behind a reverse proxy. The library resolves each one against the page and sends the records there. It works.

The library also reports `config.invalid` for each relative endpoint. It reports three times, once for `endpoint`, `metricsEndpoint` and `tracesEndpoint`.

```text
endpoint is relative. The library sends to http://localhost:5185.
```

- The report tells you where the records go. It is not an error.
- The library gives `onDiagnostic` one report of a code in each second. The handler sees the text for `endpoint`.
- The live strip shows the count of each code, and the count includes the throttled reports. It starts at 3. The login rotation checks the URLs again and adds 3. The logout rotation adds 3 more.
- A restart makes a new runtime, and the count starts again at 3. With spans off, it starts at 2.

With `diagnostics.records` on, the `config.invalid` report of a login or logout rotation also becomes a record. The library writes that record after the rotation, so it goes to the new context. The library throttles the report to one in each second. Thus the record appears only when the rotation comes more than a second after the previous report.

To remove the report, give an absolute URL. `new URL("/uilogs", location.href).href` builds it from the relative path. Use the same call for the other two endpoints.

## Why the app sends COOP and COEP headers

`vite.config.ts` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for the dev server and the preview server.

- The page is then cross-origin isolated. `performance.now()` has a step of 5 microseconds and not 100.
- The cost meter needs this fine step. A log call takes a few microseconds, and a coarse clock cannot time it.
- The library needs neither header. A production app that copies the folders leaves them out.

The meter shows `crossOriginIsolated` and the measured clock step next to each result.

## Observability settings

On a screen of 1,200 pixels or more, the section is a column on the right. It scrolls on its own. The ticket stays in view while you change a setting. On a narrow screen, it comes below the blotter.

A login, a logout, a restart and each change of a runtime setting run one at a time, through one queue. While one runs, the buttons and the setting controls are disabled. A rotation takes up to 3 seconds, and a `configure()` call during it changes nothing.

The section has five parts.

| Part | What it does |
| --- | --- |
| Live strip | Reads `getHealth()` once a second. It shows pending and in-flight records, stored batches, drops by reason and the diagnostic counters. It has no byte count. `getHealth()` has none. |
| Settings table | One row for each setting. It shows the current value, the faster value, what the faster value costs, the evidence label and when the change applies. |
| Cost meter | Times log calls under the settings in force. It keeps a table of results. Use it to compare the values before and after a change. |
| Recent records | The last 50 records that the processors saw, newest first. The tap keeps the price ticks and the meter records in a separate list. They cannot push an `ORDER_PLACED` out. **Hide market.prices** is on by default. A text field filters by namespace. |
| Buttons | **Use all faster values**, **Reset to defaults** and **Apply and restart**. |

The evidence label tells how sure the claim is.

| Label | Meaning |
| --- | --- |
| measured | A benchmark gives the number. No row has this label yet. |
| measure here | The cost meter shows the difference on your device. Console output, lowest level, payload mode and the three limits have it. |
| expected | The code suggests it. Nobody measured it. |

A setting that applies at runtime goes to `configure()` at once. A setting that is fixed after startup waits as "Staged". **Apply and restart** runs `await shutdown()` and then `configure()` with the new settings. The choices stay in `localStorage`. The page works without storage.

Compression has no faster value. gzip sends fewer bytes and spends encode work. `none` sends more bytes and spends no encode work.

### Cost meter

The meter uses the block method of `bench/workloads.js`, with far fewer blocks. It is a rough tool to compare two settings on your device. It is not a percentile benchmark.

1. It runs a warm-up.
2. It times blocks of N calls. The time of a block divided by N gives the nanoseconds for one call.
3. It shows the p50 and the max of the blocks, and the p99 only for 100 blocks or more. A run has 3 to 400 blocks. The table usually prints "max of N blocks" in the p99 column. The table has a column for the number of blocks.
4. It also times 300 single calls and shows their p99 and max.

A result is "clock-limited" when a block spans fewer than 100 clock steps. A run makes about 5,000 calls. The calls are real records in the namespace `observability.meter`, and they reach the backend.

With `payloadMode: "defer"`, most calls only keep a reference. A queue of 1,000 calls builds inside one call. The p50 then drops, and the max shows the stall.

### What the example found

- **Restart.** After `await shutdown()` and `configure()`, a logger from `getLogger()` and a metric handle keep working. `src/observability/restart.test.ts` and the smoke test check it. The new runtime knows only the new config. `restartObservability()` passes the old `securityContext.id` to it. It also sets the tenant again with `setContext()`.
- **Processors.** A processor sees each record that the library builds. That includes a record that `minLevel` drops when the console prints it. It also includes a record that sampling drops when a breadcrumb keeps its text. The count is "records built", not "records sent". `src/observability-settings/tap.test.ts` shows each case.

## Tests

```bash
pnpm --filter @example/react-custom-backend run test
```

- `vitest.setup.ts` configures the library with the memory transport before each spec. It runs `await shutdown()`, `memory.clear()` and `memory.respondWith(200)` after each spec. A spec needs no mock of the library.
- `uilogs-serializer.test.ts` checks the shape, each cut and the content type.
- `place-order.test.ts` checks `ORDER_PLACED` and the error record for `422` and `500`. It uses a fake API client.
- `hints.test.ts` configures each hint on its own. A runtime hint gives no `config.invalid`. A restart hint is refused on a running library, and a new runtime takes it. It guards the key names.
- `config.test.ts` checks that the anonymous routing has no headers function.
- `split.test.ts` checks that a backend that answers `413` for a large request gets every record, after the library splits the batch.
- `restart.test.ts` and `operation-queue.test.ts` check the restart and the queue.
- `session.test.ts` checks a login whose rotation fails. The app revokes the session, clears the token and restarts the library. It throws the error of the rotation.

Each spec of these folders needs `vitest.setup.ts` and `test/observability.ts`.

The browser smoke test starts its own servers on the ports 5186, 8797 and 8798. It needs Chromium and a built library.

```bash
pnpm exec playwright install chromium
pnpm run test:playground
```

## What to copy

| Copy | Use | Replace |
| --- | --- | --- |
| `src/observability/` | The `configure()` config, the serializer, the headers function and the login, logout and restart calls. See its [README](src/observability/README.md). | The endpoints, the serializer fields and limits, and `getToken`. |
| `src/observability-settings/` | The settings section, the hint catalog, the live strip and the cost meter. See its [README](src/observability-settings/README.md). | `app-routes.ts` and `DEFAULT_SETTINGS`. |
| `src/main.tsx` | The `configure()` call at module scope, before `createRoot()`. | The settings source. |
| `src/orders/place-order.ts` | One journey, one measure and one action for each order. The journey covers the request. It is ambient. A record from other code during the request carries its id. The fill is correlated by `orderId`. | The API client and the log names. |
| `vite.config.ts` | The proxy table. | The targets. Leave out the isolation headers. |
| `vitest.setup.ts` and `test/observability.ts` | One setup for all specs. | `serviceName`. |

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| The login screen shows "The mock app API is not reachable". | Start the example with `pnpm run example:react-custom-backend`. It starts the API. |
| The terminal shows no `[uilogs]` line. | Look for a `400` or a failed proxy request in the **Network** tab. Check that the ingest server runs on port 8787. |
| The meter result says "clock-limited". | The page is not cross-origin isolated, or a call is too fast for the clock. Open the page from the dev server of this example. |
| The page starts with the settings of an earlier session. | **Reset to defaults** restores them. The key is `react-custom-backend.settings` in `localStorage`. |

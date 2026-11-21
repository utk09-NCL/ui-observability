# React example

This example shows the library in a React 19 app. It shows a logger hook, a journey hook, an error boundary, metric handles and session replay.

Read the [playground guide](../README.md) first. It explains the mock ingest server and each line that the terminal prints.

## Run it

Start the mock ingest server in one terminal:

```bash
pnpm run dev:ingest
```

Build the library and start the example in a second terminal:

```bash
pnpm run build
pnpm run example:react
```

| Page | URL |
| --- | --- |
| Example app | `http://localhost:5180` |
| Session replay spike | `http://localhost:5180/replay-spike.html` |
| Replay viewer | `http://localhost:5180/replay-viewer.html` |

## What to look for

Open the devtools console. Log records go to `/v1/logs`. Metric points go to `/v1/metrics`, because the example sets `metricsEndpoint`. A metric point arrives about 10 seconds after its first value.

| Action | Look for in the terminal |
| --- | --- |
| Load the page | A `[metrics]` batch with `[gauge]` points for `navigation.*` and `web_vitals.*`. |
| **submit** | `[action] ORDER_SUBMIT` with a `journey=` id. Later, `[sum] orders.submitted 1 count venue=LSE`. |
| **price 20 quotes** | One point, `[histogram] pricing.latency count=20`. The library sends one point, not 20 records. |
| **fetch a missing URL** | `WARN [system] GET http://localhost:8787/missing returned 404`. Later, a `[histogram] http.client.request.duration` point. |
| **toggle the ticket** two times | The ticket mounts again, and `useJourney` starts a new journey. Later records show a new `journey=` id. |
| **break a render** | `ERROR [log] render failed`. The page shows the fallback text. The console shows the `react.component_stack` payload. |

## What to copy

- `src/main.tsx`. Call `configure()` one time at module scope, before `createRoot()`. Do not call it in a component, because StrictMode runs each effect two times in development.
- `src/observability.tsx`. Copy this file into your app. It has `LoggerProvider`, `useLogger`, `useJourney` and `ObservabilityErrorBoundary`. It imports only the public API.
- `src/app.tsx`. Create the metric handles `counter()` and `histogram()` at module scope. A handle stays valid across `configure()` and `shutdown()`.

Keep these rules from the example:

- Put `ObservabilityErrorBoundary` around each subtree that can fail to render. React catches a render error in the boundary. The error never reaches `window.onerror`, and `capture.errors` cannot see it.
- `useJourney` does not end the journey when the component unmounts. A journey belongs to a workflow, not to a component. `endOnUnmount: true` changes this. Read its JSDoc first.
- Install `web-vitals` and set `capture.webVitals: { loader: () => import("web-vitals") }`. Without the loader, the library reports `config.invalid`. LCP, CLS and INP stay off, and the navigation timing continues.

## Session replay

The replay pages show a replay workflow with no replay service. They use `createMemoryTransport()` for the log records and `replay.onSegment` for the segments. The terminal of the mock server shows no line.

### Spike page

Open `http://localhost:5180/replay-spike.html`. Click **Run the spike**. The tab title changes from `running` to `done` after about 30 seconds.

The page does these steps:

1. It draws a blotter of 5,000 rows.
2. It times an update of 500 rows and a sort of 5,000 rows. It does this with replay off, on, and off again.
3. It turns replay on with three record plugins. They are sequential id, console and network.
4. It breaks a render. The error starts the upload of the replay buffer.
5. It saves the segments in IndexedDB.

Read these fields of the **JSON** block:

| Field | Expected value |
| --- | --- |
| `upload.segments` | Three or more segments. One segment has the full snapshot of the page, about 4.7 MB. |
| `upload.errorRecordHasReplayId` | `true`. The error record carries `replay.id`. |
| `masking` | `true` only for `unmaskedHeadingInClear`. The recorder masked the cells, the password, the hidden input and the shadow text. |
| `plugins.tokenOfTheUrlInClear` | `false`. The network plugin got the URL without its query. |
| `plugins.sequentialIdsInOrder` | `true`. No event is missing. |

Add `?autorun=1` to run the spike at load.

### Viewer page

Open `http://localhost:5180/replay-viewer.html`. The table lists each recording in IndexedDB. Click **Play** to play a recording with `rrweb-player`. Add `?autoplay=1` to play the first recording at load.

- The **Application** tab shows the IndexedDB database `uiobs-replay-spike`. It has the stores `recordings` and `segments`.
- The store keeps at most 20 recordings and 50 MB. It removes a recording after 7 days.
- Click **Delete** or **Delete each recording** to remove recordings.
- The replay plugins print the recorded warnings and errors in the devtools console of the viewer.

IndexedDB stands in for a replay service in this example. The library never writes a segment to IndexedDB. In your app, set `replay.endpoint`. See [Session replay](../../docs/api.md#session-replay) and the [threat model](../../docs/threat-model.md#session-replay).

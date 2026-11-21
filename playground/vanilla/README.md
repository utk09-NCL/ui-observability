# Vanilla playground

The vanilla playground is the manual test page of the library. It uses no framework and has a control for each feature. It imports the library from `src/`. A change in `src/` shows after a page reload, with no build.

Read the [playground guide](../README.md) first. It explains the mock ingest server and each line that the terminal prints.

## Run it

```bash
pnpm install
pnpm run dev
```

`pnpm run dev` starts three processes. Each terminal line starts with the number of its process.

| Number | Process | Address |
| --- | --- | --- |
| `[0]` | Vite server of the playground | `http://localhost:5173/playground/vanilla/index.html` |
| `[1]` | Mock ingest server | `http://localhost:8787` |
| `[2]` | Vite server for the cross-origin child frame | `http://localhost:5174` |

Vite opens the main page in your browser. To stop that, run `BROWSER=none pnpm run dev`. Watch the lines that start with `[1]`.

## Pages

| Page | Path | Use |
| --- | --- | --- |
| Main page | `/playground/vanilla/index.html` | Each capture, journeys, durability, the profiler and session replay |
| Main page, worker delivery | `/playground/vanilla/index.html?worker=1` | The same page. A dedicated worker encodes and sends each batch. |
| Profiler blotter | `/playground/vanilla/blotter.html` | A blotter of 5,000 rows that profiler probes time |
| Profiler benchmark | `/playground/vanilla/profiler.html` | The cost of one `begin()` and `end()` pair of a probe, in nanoseconds |
| Child frame | `/playground/vanilla/child.html` | The main page loads it two times, from port 5173 and from port 5174 |

## At startup

Open the devtools console. Then load the main page.

- After about two seconds, the terminal prints `[metric]` records for the navigation timing (`navigation.*`) and the web vitals (`web_vitals.*`).
- The devtools console prints the same records with the namespace `uiobs.capture`.
- The **Diagnostics** panel shows `bus.role_resolved`. The main page sends its own records.
- Each child frame shows `role: forwarder`. A child gives its records to the main page, and the main page sends them.
- The **Application** tab shows `ui-observability.session` in `localStorage`. It shows `ui-observability.tab` and `ui-observability.alive` in `sessionStorage`. IndexedDB has the database `UiObservability`.

[Browser Storage Keys](../../docs/configuration.md#browser-storage-keys) explains each key.

## Main page

A record reaches the terminal about two seconds after the click. Each click also gives a `ui.interaction` span in a `[traces]` batch. A click that changes nothing on the page also gives `[event] ui.dead_click`.

### Manual

| Control | Look for in the terminal |
| --- | --- |
| **info** | `INFO [playground] [log] hello from the playground` |
| **logAction** | `[action] ORDER_SUBMIT`. Sampling never drops an action. |
| **gauge** | `[metric] grid.render`. The click sets the gauge and flushes, so the point does not wait for the metric interval. |
| **startMeasure** | `[metric] ui.measure.duration` and two `ui.measure.phase.duration` records. A `[traces]` batch has the span `checkout` with the child spans `validate` and `submit`. |
| **logger.error** | `ERROR [playground] [log] something went wrong` |
| **Defer payload builds**, then **log a payload, then change it** | `[log] Payload mode sample`. [Deferred payloads](../../docs/configuration.md#deferred-payloads) explains the difference between the two modes. |

### Journeys

| Control | Look for |
| --- | --- |
| **startJourney** | The **Diagnostics** panel shows the journey id. Each later record shows that id in `journey=`. |
| **endJourney** | Each later record shows `journey=-`. |
| **open a second window carrying the journey token** | A new tab opens with the URL parameter `__uiobs_journey`. The records of the new tab show the same journey. |

[Context & Correlation](../../docs/api.md#context--correlation) lists the journey functions.

### Auto-capture

| Control | Look for in the terminal |
| --- | --- |
| **throw an uncaught error** | `ERROR [playground] [system] uncaught from a timeout` |
| **unhandled rejection** | `ERROR [playground] [system] nobody caught me` |
| **fetch a 404** | `WARN [system] GET http://localhost:8787/does-not-exist returned 404`. The `[traces]` batch has a `[client] GET` span marked `ERROR`. |
| **log a circular object** | `INFO [log] circular payload`. The log call does not throw. |
| **block the page for 300 ms** | `[metric] ui.long_frame.duration`. Chrome can report the frame some seconds later. Firefox and Safari report no long frames. |
| **console.error from app code** | `ERROR [system] grid failed to render` |
| **performance.measure** | `[metric] ui.user_timing.duration`. The library sums the measures and sends one point after 10 seconds. |
| **a button that does nothing** | One click gives `[event] ui.dead_click`. Three fast clicks give `[event] ui.rage_click`. |
| **Server timing**, then **fetch server timing entries** | The fetch span and record of `/__timing` get the `Server-Timing` entries. The terminal does not print them. |
| **Browser reports**, **Resource timing**, **Lifecycle events** | Each box turns one capture on or off with `configure()`. The **Diagnostics** panel shows `config.reconfigured`. |
| **Permit remote capture switches**, then **send capture rules for 10 seconds** | The server turns on `serverTiming` and `lifecycle` for 10 seconds. The page permits only these two switches. |

[Auto-Capture Options](../../docs/configuration.md#auto-capture-options) and [Remote capture switches](../../docs/configuration.md#remote-capture-switches) describe each capture.

### Profiler

1. Tick **Profiler**.
2. Click **Run 10,000 sorts**.
3. Look for `[metric] ui.profile.duration` in the terminal.

The record summarizes the probe `grid.sort`. Expand it in the devtools console to read `profile.p50`, `profile.p90` and `profile.p99`. With the box clear, the probe records nothing. See [Profiler](../../docs/api.md#profiler).

### Session replay

1. Tick **Session replay**. The library loads `@rrweb/record` with a dynamic import.
2. Click **logger.error**.
3. Look for one `[replay]` line for each segment. The first segment has a full snapshot of the page. More segments can follow for 5 seconds after the error.

The recorder masks each text on the page except the paragraph with `data-observability-unmask`. See [Session replay](../../docs/api.md#session-replay).

### Durability

| Control | Look for |
| --- | --- |
| **250 logs in a burst** | Three `[batch]` lines with 100, 100 and 50 records. Chrome hides the `DEBUG` lines in the console until you select **Verbose**. |
| **toggle forced 503 on the server** | `[control] forcedStatus=503`. Then `[forced 503] batch=<id> attempt=<n>` for each send. **Diagnostics** shows `transport.http_error`. |
| **what is waiting** | **Diagnostics** shows the number of batches in storage and the failed sends in a row. During a forced 503, both numbers go up. |
| **toggle forced 503 on the server** again | `[control] forcedStatus=200`. The stored batches arrive with their first batch ids. |
| **toggle server sampling rules (10% of playground)** | The server sends rules that keep 10 percent of the `playground` records for one minute. |

The sampling rules arrive with the next accepted batch. Click **info** one time. Then click **250 logs in a burst**. The **Diagnostics** panel shows how many records sampling dropped.

To see the exit flush, click **info** and close the tab in less than two seconds. The terminal prints `[exit pagehide] batch=<id>`.

[Delivery guarantees](../../docs/delivery-guarantees.md) explains the retries, the storage and the exit flush.

## Child frames

The main page registers each child frame with `registerFrame()` before the frame loads.

- The same-origin child loads from port 5173. It attaches to the runtime of its parent.
- The cross-origin child loads from port 5174. It sends its records to the parent with `postMessage`.

Click **log from the child** in a frame. The terminal shows `INFO [playground-child] [action] CHILD_CLICK`. The record has the `tab=` value of the main page. Each child keeps its own `service.name`.

See [Registered bus sources](../../docs/runtime-policies.md#registered-bus-sources).

## Worker transport

Click **Use worker transport**, or open `index.html?worker=1`. The page and the terminal lines stay the same. A dedicated worker from `transport-worker.ts` now encodes and sends each batch. See [Worker transport](../../docs/guides.md#worker-transport).

## Profiler pages

These two pages use `createMemoryTransport()`. They send nothing. The terminal shows no line.

**Blotter.** Open `/playground/vanilla/blotter.html`. Click **Run each action**. The tab title changes from `running` to `done`. The page fills the tables **Probes**, **Frame phases** and **Breadcrumbs**, and the **JSON** block. Firefox and Safari fill no **Frame phases** row.

**Benchmark.** Open `/playground/vanilla/profiler.html`. Keep the tab visible, and stop other programs that use the CPU. Click **Run benchmark**. The table shows p50, p99 and max in nanoseconds for each mode. The page shows no average.

Each page accepts `?autorun=1`. The page text lists the other URL parameters.

## Files

| File | Content |
| --- | --- |
| `main.ts` | The main page. One `configure()` call turns on each capture. |
| `child.ts` | The child frame. It calls `configure()` and the bus resolves its role. |
| `transport-worker.ts` | The worker for `?worker=1`. It calls `serveTransportWorker()`. |
| `blotter.ts` | The profiler blotter page |
| `profiler.ts` | The profiler benchmark page |

# React FX workspace example

This example shows the library in a React 19 workspace. The layout comes from dockview 8.9.1, the MIT package `dockview-react`. A team can copy the folders that fit its app.

Read the [playground guide](../README.md) first. It explains the mock ingest server and each line that the terminal prints.

## What it shows

- A login screen. After login, the workspace opens the saved layout of that user and tenant.
- Tabs, split groups, drag and drop, floating groups, maximize and popout windows.
- Six panels. Each panel uses one part of the library.
- A login, a tenant switch, a logout, a shared-device logout and a consent withdrawal that follow the recipes in [Production recipes](../../docs/production-recipes.md).
- An "Observability settings" panel. The user changes the config and sees which value costs less.
- A worker that logs through `registerWorker()`.
- Vitest specs that use one setup file for all specs. See [One Setup for All Specs](../../docs/guides.md#one-setup-for-all-specs).

The business data comes from the mock app API, `tools/mock-app-api.mjs`.

## Run it

Build the library and start the example from the repository root:

```bash
pnpm run build
pnpm run example:react
```

The command starts three servers.

| Server | Port | Use |
| --- | --- | --- |
| Vite dev server of the app | 5180 | The page. It proxies `/api` and `/telemetry`. |
| Mock ingest server | 8787 | The log backend. It accepts `/v1/logs`, `/v1/metrics` and `/v1/traces`. |
| Mock app API | 8790 | Login, orders, positions and the WebSocket price stream. |

Open `http://localhost:5180`. Log in with any user name. The terminal of the command shows the lines of all three servers, with the numbers `[0]`, `[1]` and `[2]`.

| Proxy path | Goes to |
| --- | --- |
| `/api` | The mock app API, also for the WebSocket `/api/stream`. |
| `/telemetry/v1/logs`, `/telemetry/v1/metrics` and `/telemetry/v1/traces` | The mock ingest server, without the `/telemetry` prefix. |

`UIOBS_APP_API_PORT` and `UIOBS_MOCK_PORT` move the proxy targets. The browser smoke test uses them.

The page `http://localhost:5180/popout.html` is the page of the popout windows. Do not open it yourself.

## The panels

| Panel | What you do | What the library does |
| --- | --- | --- |
| Prices | Watch the live tiles. | `capture.webSocket` records the socket. The price handler logs each tick at DEBUG in the noisy namespace `market.prices`. A gauge, `market.tick_rate`, sends the ticks per second. |
| Order ticket | Place an order. Use the fault switch to make the API refuse it. | One journey, one `startMeasure()` span and one fetch with a `traceparent` header for each order. `httpMetrics` sends the request durations. A refused order gives an ERROR record. |
| Blotter | Filter and cancel orders. Click **Freeze 300 ms**. Click **Export** three times. | Profiler probes time the filter pass and the paint after a filter change. `longFrames` records the freeze. `rageClicks` records the three clicks. |
| Positions | Read the P&L. | A dedicated worker computes it. The page calls `registerWorker()`, so the worker logs through the page. |
| Activity log | Read the records that the library built. | A processor tap keeps the last records. A change in the settings panel shows here at once. |
| Observability settings | Change the config. | See [Observability settings](#observability-settings). |

The fault switch is in the order ticket. **Reject, 422** and **Error, 500** make the API refuse the next orders. **Slow, 2 s** delays them.

## The shell

- **Layout.** The workspace saves the layout with `toJSON()` after each change. Its key is `react-workspace.layout:<user>:<tenant>` in `localStorage`. A new user, or a new tenant of a user, opens the default layout.
- **A damaged layout.** The workspace reads the saved layout with checks. It falls back to the default layout for bad JSON, a wrong shape, an old format version and a layout that dockview refuses. It writes a WARN record with the reason. `src/workspace/layout-store.test.ts` shows each case.
- **Add panel** opens a panel, or shows it when it is open. **Reset layout** clears dockview and builds the default layout again.
- **Group buttons.** Each group has **Maximize**, **Float** and **Pop out**. A floating group and a popout group have **Dock**. The tab menu has the same actions.
- **Popout windows.** dockview opens `/popout.html` in a new window and moves the DOM of the group into it. The file is `public/popout.html`, so the dev server and the build both serve it. The panel code keeps running in the opener window. The browser must allow popups for the site. A reload of the page closes the popout window. The group then returns to the grid, so no panel is lost. This came from one run in Chrome.
- **Theme.** The theme switch changes the dockview theme and the colors of the page. Dark is the default. The choice stays in `localStorage`. A popout window that is open keeps the theme of its start.
- **Empty layout.** The watermark has a button for each panel and one for the default layout.

### The user menu

| Item | What the app does | Recipe |
| --- | --- | --- |
| Switch tenant | Logs in again for the new tenant. Rotates the security context with `pending: "discard"`. Revokes the old token. The workspace opens the layout of the new tenant. | [Tenant rotation](../../docs/production-recipes.md#tenant-rotation) |
| Privacy choices | Opens a dialog. The telemetry switch calls `configure({ enabled: false })`, `stopReplay()` and a rotation with an empty `routing`. The choice stays in `localStorage`, so the next page load starts paused. The replay switch is a stub. It stores the choice and records nothing. | [Consent withdrawal](../../docs/production-recipes.md#consent-withdrawal) |
| Log out | Rotates to the anonymous context, then revokes the token. | [Logout](../../docs/production-recipes.md#logout) |
| Log out on a shared device | Calls `shutdown({ pending: "discard", clearStorage: "context" })`, revokes the token and starts a new anonymous runtime. It also removes the saved layouts of the user in every tenant. | [Logout on a shared device](../../docs/production-recipes.md#logout-on-a-shared-device) |

## What to look for

| Action | Look for |
| --- | --- |
| **Log in** | In the terminal of the ingest server, records of `[react-workspace]`. Later, records of `[react-workspace-positions]`. |
| **Place order** | `[2] [orders] POST /api/orders ... traceparent=00-...` in the terminal of the app API. |
| **Place order** | `ORDER_PLACED  journey=<id>` in a log batch. A `[traces]` batch with a `[client]  POST` span. About 10 seconds later, a `[metrics]` batch with the counter `orders.placed`. |
| Fault switch **Reject, 422**, then **Place order** | `ERROR [log] order refused` in a log batch. The span of the request has the status `ERROR`. |
| **Place order**, then wait for the fill | `positions received` from `[react-workspace-positions]`. The worker sends no request. The page sends its record. |
| Click **Freeze 300 ms** | A `ui.long_frame.duration` point in the next metrics batch. |
| Change a filter in the blotter | `ui.profile.duration` points for the probes `blotter.filter` and `blotter.filter.paint`. |
| Click **Export** three times in one second | `ui.rage_click` in a log batch. |
| **Privacy choices**, clear the telemetry switch | Nothing arrives at the ingest server. Set the switch again, and records arrive with the tenant. |
| **Log out on a shared device** | The saved layouts of the user leave `localStorage`. The next login opens the default layout. |

## Observability settings

The panel is the one of the [react-custom-backend example](../react-custom-backend/README.md#observability-settings), with more rows.

- A live strip shows the delivery state of the library, and the diagnostic counters.
- The table has one row for each setting. It shows the current value, the faster value, what the faster value costs, the evidence label and when the change applies.
- A setting that applies at runtime goes to `configure()` at once. A setting that is fixed after startup waits as "Staged". **Apply and restart** runs `await shutdown()` and then `configure()`.
- The cost meter times log calls under the settings in force. This app sends no COOP and no COEP header, so the clock has a coarse step and the blocks are longer. See [Why the app sends no COOP and COEP headers](#why-the-app-sends-no-coop-and-coep-headers).

New rows in this app:

| Setting | Config key |
| --- | --- |
| Rage click events | `capture.interactions.rageClicks` |
| Dead click events | `capture.interactions.deadClicks` |
| Long frame capture | `capture.longFrames` |
| Profiler probes | `profiler.enabled` |
| Frame phases | `profiler.framePhases` |
| Frame pacing | `profiler.framePacing` |

The default settings favor more data. Each row then has a cheaper value to show. The price ticks make 16 DEBUG records each second. They go to the ingest server until you change **Lowest level sent** or the keep rate of `market.prices`.

With **Console output** on, **Lowest level sent** does not stop the DEBUG records in the Activity log. The console prints them, so the library builds them. Turn **Console output** off and set the level to WARN. The ticks then leave the Activity log. `e2e/playground/react.smoke.ts` checks this.

## What the example found

These notes come from a run in Chrome. They are not a benchmark.

- **dockview and StrictMode.** `dockview-react` 8.9.1 keeps its instance when StrictMode runs the cleanup of the first mount. `onReady` runs one time for each instance. A listener that you add in `onReady` and remove in a parent effect is gone after the first mount. The layout then never saves. `src/workspace/workspace.tsx` keeps the instance in state and adds the listeners in an effect.
- **Clicks in a popout window.** The library listens for clicks on the window of the opener. Three clicks in 300 ms on **Export** in the main window gave one `ui.rage_click` event and three new `ui.interaction` spans. Three clicks on the same button in a popout window gave no event. Treat clicks in a popout window as not captured.
- **Dead clicks.** The check watches the whole document for a change within one second. Live tiles, the quotes of the ticket and the Activity log all change it. The click itself adds records to the Activity log. With the panels Prices, Order ticket, Activity log and Observability settings closed, one click on **Export** gave `ui.dead_click`. In the default layout it never does.
- **`bus.rejected_message` at start.** The live strip shows `bus.rejected_message 1` a few seconds after login in the dev server, and the count stays. Hypothesis: StrictMode starts the worker of the Positions panel two times, and the library rejects a message of the first worker. Nobody checked a build.
- **A forwarded record skips the processors of the page.** The Activity log shows no record of the worker. The ingest server gets them, in the batches of the page.

## Why the app sends no COOP and COEP headers

The react-custom-backend example sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. This app does not.

- The next stage adds a cross-origin iframe on port 5174. Under `require-corp`, that iframe must send its own isolation headers.
- This app opens popout windows. The library needs neither header.
- The cost meter still works. The clock step is 100 µs, and a block is longer, about 20 ms. A result is marked clock-limited only when a block spans fewer than 100 steps. The step and the block length come from one run in Chrome.

## What to copy

| Copy | Use | Replace |
| --- | --- | --- |
| `src/observability/` | The `configure()` config, the headers function, the login, tenant, logout and consent calls, and the error boundary with the provider and hooks. See its [README](src/observability/README.md). | The endpoints, `SERVICE_NAME` and `getToken`. |
| `src/observability-settings/` | The settings section, the hint catalog, the live strip, the cost meter and the recent records. See its [README](src/observability-settings/README.md). | `app-routes.ts` and `DEFAULT_SETTINGS`. |
| `src/main.tsx` | The `configure()` call at module scope, before `createRoot()`. | The settings source. |
| `src/workspace/layout-store.ts` | The saved layout of each user and tenant, with the fallback for a damaged layout. | The storage key. |
| `src/panels/positions.worker.ts` and `positions-panel.tsx` | A worker that logs, and the page that registers it. | The messages and the computation. |
| `vite.config.ts` and `public/popout.html` | The proxy table, the worker format and the popout page. | The targets. |
| `vitest.setup.ts` and `test/observability.ts` | One setup for all specs. | `serviceName`. |

## Tests

```bash
pnpm --filter @example/react run test
```

- `vitest.setup.ts` configures the library with the memory transport before each spec. It runs `await shutdown()`, `memory.clear()` and `memory.respondWith(200)` after each spec.
- `layout-store.test.ts` checks the saved layouts and the fallback for each damaged layout.
- `session.test.ts` checks the order of the steps of a login, a tenant switch and a shared-device logout. It also checks each failure.
- `user-context.test.ts` runs the real library. It checks the pause and the resume of a consent change, the tenant on the records and the discard of a shared-device logout.
- `paused-start.test.ts` checks a login on a page that starts paused after a withdrawal of consent.
- `config.test.ts`, `hints.test.ts`, `settings-store.test.ts` and `restart.test.ts` check the config, the hint catalog and the settings store.

The browser smoke test starts its own servers on the ports 5187, 8797 and 8798. It needs Chromium and a built library.

```bash
pnpm exec playwright install chromium
pnpm run test:playground
```

## Session replay pages

The replay spike and the replay viewer from the earlier version of this example are still here. The next stage replaces them with a panel.

| Page | URL |
| --- | --- |
| Session replay spike | `http://localhost:5180/replay-spike.html` |
| Replay viewer | `http://localhost:5180/replay-viewer.html` |

The spike page runs a replay workflow with no replay service. It uses `createMemoryTransport()` for the log records and `replay.onSegment` for the segments. The viewer plays the recordings from IndexedDB with `rrweb-player`. IndexedDB stands in for a replay service in this example. In your app, set `replay.endpoint`. See [Session replay](../../docs/api.md#session-replay) and the [threat model](../../docs/threat-model.md#session-replay).

Open the spike page and click **Run the spike**. The tab title changes from `running` to `done` after about 30 seconds. Add `?autorun=1` to run the spike at load. On the viewer page, click **Play** to play a recording. Add `?autoplay=1` to play the first recording at load.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| The login screen shows "The mock app API is not reachable". | Start the example with `pnpm run example:react`. It starts the API. |
| The terminal shows no record of `[react-workspace]`. | Look for a failed proxy request in the **Network** tab. Check that the ingest server runs on port 8787. |
| **Pop out** opens no window. | The browser blocked the popup. Allow popups for `http://localhost:5180`. The page shows a notice. |
| A popout window has the wrong colors after a theme change. | The window keeps the theme of its start. Close it and pop the group out again. |
| The workspace opens a layout that you do not expect. | Click **Reset layout**. Or remove the key `react-workspace.layout:<user>:<tenant>` from `localStorage`. |
| The page starts paused. | You cleared the telemetry switch in **Privacy choices**. The key is `react-workspace.consent`. Set the switch again. |
| The page starts with the settings of an earlier session. | **Reset to defaults** restores them. The key is `react-workspace.settings` in `localStorage`. |

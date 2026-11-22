# React FX workspace example

This example shows the library in a React 19 workspace. The layout comes from dockview 8.9.1, the MIT package `dockview-react`. A team can copy the folders that fit its app.

Read the [playground guide](../README.md) first. It explains the mock ingest server and each line that the terminal prints.

## What it shows

- A login screen. After login, the workspace opens the saved layout of that user and tenant.
- Tabs, split groups, drag and drop, floating groups, maximize and popout windows.
- Eleven panels. Each panel uses one part of the library. Six panels are in the default layout, and **Add panel** opens the other five.
- A login, a tenant switch, a logout, a shared-device logout and a consent withdrawal that follow the recipes in [Production recipes](../../docs/production-recipes.md).
- An "Observability settings" panel. The user changes the config and sees which value costs less.
- A worker that logs through `registerWorker()`. Three frames that use the bus: a same-origin frame, a cross-origin frame and an unregistered cross-origin frame.
- A session replay that records only after the user agrees, and a Support panel that plays it.
- A window that shows one panel. It starts its own runtime and adopts the journey of the workspace.
- A token refresh on a timer.
- Vitest specs that use one setup file for all specs. See [One Setup for All Specs](../../docs/guides.md#one-setup-for-all-specs).

The business data comes from the mock app API, `tools/mock-app-api.mjs`.

## Run it

Build the library and start the example from the repository root:

```bash
pnpm run build
pnpm run example:react
```

The command starts four servers.

| Server | Port | Use |
| --- | --- | --- |
| Vite dev server of the app | 5180 | The page. It proxies `/api` and `/telemetry`. |
| Mock ingest server | 8787 | The log backend. It accepts `/v1/logs`, `/v1/metrics`, `/v1/traces` and `/v1/replay`. It keeps the replay segments, and it lists them. |
| Mock app API | 8790 | Login, token refresh, orders, positions and the WebSocket price stream. |
| Cross-origin server | 5174 | The page of the partner widget. It is the server of `pnpm run dev:cross-origin`. |

`pnpm run dev` also uses port 5174. The two commands can not run together.

The two mock servers listen on `127.0.0.1` only. They answer a request only when its `Host` header names `localhost` or `127.0.0.1`. Any other name gets `403`. A web page on another name that points to this machine can then not read the replay routes. Use `localhost` or `127.0.0.1` in an address. A client that uses `[::1]` can not connect. `vite --host` with a LAN address gets `403` too, because the proxy sends the LAN name as the `Host` header.

Open `http://localhost:5180`. Log in with any user name. The terminal of the command shows the lines of all four servers, with the numbers `[0]` to `[3]`.

| Proxy path | Goes to |
| --- | --- |
| `/api` | The mock app API, also for the WebSocket `/api/stream`. |
| `/telemetry/v1/logs`, `/telemetry/v1/metrics`, `/telemetry/v1/traces`, `/telemetry/v1/replay` and `/telemetry/v1/replay/recordings` | The mock ingest server, without the `/telemetry` prefix. |

`UIOBS_APP_API_PORT` and `UIOBS_MOCK_PORT` move the proxy targets. `VITE_PARTNER_ORIGIN` moves the origin of the partner widget. The browser smoke test uses all three.

The app has five more pages. Do not open them yourself. Each one belongs to a feature.

| Page | Use |
| --- | --- |
| `/popout.html` | The page of the dockview popout windows. |
| `/research.html` | The frame of the Research panel. |
| `http://localhost:5174/playground/vanilla/untrusted.html` | The Untrusted widget, on another origin. The app does not register it. |
| `/panel.html` | The window of one panel, from **Open panel in new window**. |
| `http://localhost:5174/playground/vanilla/partner.html` | The partner widget, on another origin. The vanilla playground may load the library source, so the page lives in `playground/vanilla`. |

## The panels

| Panel | What you do | What the library does |
| --- | --- | --- |
| Prices | Watch the live tiles. | `capture.webSocket` records the socket. The price handler logs each tick at DEBUG in the noisy namespace `market.prices`. A gauge, `market.tick_rate`, sends the ticks per second. |
| Order ticket | Place an order. Use the fault switch to make the API refuse it. | One journey, one `startMeasure()` span and one fetch with a `traceparent` header for each order. `httpMetrics` sends the request durations. A refused order gives an ERROR record. |
| Blotter | Filter and cancel orders. Click **Freeze 300 ms**. Click **Export** three times. | Profiler probes time the filter pass and the paint after a filter change. `longFrames` records the freeze. `rageClicks` records the three clicks. |
| Positions | Read the P&L. | A dedicated worker computes it. The page calls `registerWorker()` with `journey:read`, so the worker logs through the page and its records carry the journey. The worker has no endpoint, so it never sends around a withdrawal of consent. |
| Activity log | Read the records that the library built. | A processor tap keeps the last records. A change in the settings panel shows here at once. |
| Observability settings | Change the config. | See [Observability settings](#observability-settings). |
| Chart | Read the move of each pair. | A canvas has no DOM nodes. The replay shows it only with `replay.recordCanvas`, which is off. A profiler probe times each draw. |
| Research | Click **Log an action**, then **Reload frame**, then click again. | A same-origin frame. `registerFrame()` runs before the frame loads. The frame forwards its records over the bus, in the namespace `research.frame`. The panel uses the dockview renderer `always`, so a move does not reload the frame. A group that holds this panel has no **Pop out** button. |
| Partner widget | Click **log from the partner** in the frame. | A frame from port 5174. `registerFrame()` binds its exact origin. The widget lists the origin of the workspace in `bus.trustedOrigins`. |
| Untrusted widget | Click **Reload frame**. | A frame from port 5174. The app does not register it. The bus rejects its hello, and the counters `bus.rejected_message` and `bus.untrusted_origin` go up. The frame then sends for itself. It has no endpoint, so it sends nothing. |
| Support | Play a replay. Read the health. Collect the debug bundle. Read the lost records. | `collectDebugBundle()`, `getHealth()` and the `onDrop` hook. The replay list and the player are in `replay-player/`. |

The fault switch is in the order ticket. **Reject, 422** and **Error, 500** make the API refuse the next orders. **Slow, 2 s** delays them.

## The shell

- **Layout.** The workspace saves the layout with `toJSON()` after each change. Its key is `react-workspace.layout:<user>:<tenant>` in `localStorage`. A new user, or a new tenant of a user, opens the default layout.
- **A damaged layout.** The workspace reads the saved layout with checks. It falls back to the default layout for bad JSON, a wrong shape, an old format version and a layout that dockview refuses. It writes a WARN record with the reason. `src/workspace/layout-store.test.ts` shows each case.
- **Add panel** opens a panel, or shows it when it is open. **Reset layout** clears dockview and builds the default layout again.
- **Group buttons.** Each group has **Open panel in new window**, **Maximize**, **Float** and **Pop out**. A group that holds a frame panel has no **Pop out** button. A floating group and a popout group have **Dock**. The tab menu has the same actions, except for a frame panel. The tab of a frame panel has no **Open in New Window** item. That item is the popout item of dockview. The workspace also blocks the drop of a frame tab into a popout window.
- **Popout windows.** dockview opens `/popout.html` in a new window and moves the DOM of the group into it. The file is `public/popout.html`, so the dev server and the build both serve it. The panel code keeps running in the opener window. `src/workspace/popout-observer.ts` gives each popout window to `observeWindow()`, so the library captures clicks there. The browser must allow popups for the site. A frame in a popout window loads again, and its parent has no runtime. So no frame panel goes to a popout window. **Add panel** puts a frame panel at the edge of the grid when a popout window is the active group. A saved layout opens with no frame panel in a popout window. The restore removes it from the saved group, and it drops a group that has no other panel. A reload of the page closes the popout window. The group then returns to the grid, so no panel is lost. This came from one run in Chrome.
- **Theme.** The theme switch changes the dockview theme and the colors of the page. Dark is the default. The choice stays in `localStorage`. A popout window that is open keeps the theme of its start.
- **Empty layout.** The watermark has a button for each panel and one for the default layout.

### The user menu

| Item | What the app does | Recipe |
| --- | --- | --- |
| Switch tenant | Logs in again for the new tenant. Rotates the security context with `pending: "discard"`. Revokes the old token. The workspace opens the layout of the new tenant. When the login for the new tenant fails, the app logs the user out. | [Tenant rotation](../../docs/production-recipes.md#tenant-rotation) |
| Privacy choices | Opens a dialog. The telemetry switch calls `configure({ enabled: false })`, `stopReplay()` and a rotation with an empty `routing`. The replay switch calls `startReplay()` or `stopReplay()`. Both choices stay in `localStorage`, so the next page load starts with them. A panel window follows the change at once, through a `storage` event. | [Consent withdrawal](../../docs/production-recipes.md#consent-withdrawal) |
| Refresh token now | Asks the API for a new token. The page also does it on a timer. The library needs no call. | [Token refresh](../../docs/production-recipes.md#token-refresh) |
| Log out | Rotates to the anonymous context, then revokes the token. It closes the windows of single panels. | [Logout](../../docs/production-recipes.md#logout) |
| Log out on a shared device | Calls `shutdown({ pending: "discard", clearStorage: "namespace" })`, revokes the token and starts a new anonymous runtime. It removes the saved layouts of the user in every tenant, and the privacy choices of the device. | [Logout on a shared device](../../docs/production-recipes.md#logout-on-a-shared-device) |

The shared-device logout differs from the recipe in one value. The recipe has `clearStorage: "context"`. This app has `"namespace"`. Each page load and each panel window starts its own security context. A scope of one context would leave the stored batches of the other contexts on the device. `src/observability/shared-device.test.ts` checks the value.

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
| Click **Export** one time while the prices tick, with the **Order ticket** panel closed | `ui.dead_click` in a log batch. The marked live regions do not count as an answer. |
| Click **Pop out group** on the Blotter, then click **Export** three times in the new window | `ui.rage_click` in a log batch, as for the main window. |
| **Privacy choices**, clear the telemetry switch | Nothing arrives at the ingest server, also from an open panel window. Set the switch again, and records arrive with the tenant. |
| **Log out on a shared device** | The saved layouts of the user leave `localStorage`. The next login opens the default layout. |
| Add **Research**, click **Log an action** in the frame | `[react-workspace-research] [action] RESEARCH_VIEWED` in a log batch of the page. |
| Add **Partner widget**, click **log from the partner** | `[react-workspace-partner] [action] PARTNER_CLICK` in a log batch of the page. |
| Add **Untrusted widget**, click **Reload frame** | The counters of the bus go up. The role in the frame changes to `sender` after a few seconds. |
| **Privacy choices**, set the replay switch. Fault switch **Reject, 422**, **Place order** | `[replay] replay=... sequence=0 events=...` in the terminal of the ingest server. The **Support** panel lists the recording after **Refresh the list**. |
| **Open panel in new window** on the Blotter | A new window with the journey id in its header. Its records and the records of the workspace have the same `journey=<id>`. |

## The frames and the bus

The workspace shows three iframes. Each one uses the bus in another way. Each frame calls `configure()` and logs under its own namespace.

| Frame | Origin | Registered | What happens |
| --- | --- | --- | --- |
| Research | The origin of the workspace | Yes, with `["records", "journey:read"]` | The frame attaches over the direct link and forwards its records. The records carry the journey of the workspace. The frame has no endpoint, so it never sends for itself. |
| Partner widget | Port 5174 | Yes, at the exact origin, with `["records", "journey:read"]` | The frame attaches over the message link. The workspace trusts the registered origin. The widget lists the workspace in its own `bus.trustedOrigins`, and it posts its hello only to those origins. |
| Untrusted widget | Port 5174 | No | The frame can not read the workspace. It lists the workspace in `bus.trustedOrigins`, so it posts its hello. The bus rejects the hello. The counters `bus.rejected_message` and `bus.untrusted_origin` go up with each load. The frame then sends for itself. It has no endpoint, so it sends nothing. |

Each frame element is in the document with no `src`. `registerFrame()` runs, then `flush()` waits for the start of the runtime, and then the frame gets its `src`. A frame that loads earlier finds no owner. `src/panels/frame-panel.tsx` does this in one effect with a cleanup, so StrictMode can mount, unmount and mount again.

- **Permissions.** A frame or a worker asks for the journey when its runtime starts. A registration without `journey:read` makes the bus refuse that request. The bus counts `bus.journey_denied`, and it does not count `bus.rejected_message`. With `journey:read`, the counter does not move for a registered source. In Chrome, the Positions worker has `journey:read`, and `bus.journey_denied` stayed at 0.
- **The renderer.** dockview removes the DOM of a hidden panel and puts it back when the panel shows again. The browser reloads an iframe that it takes out of the document. The three frame panels use the renderer `always`, so a tab change or a move in the grid does not reload the frame. A move into a popout window still reloads it, because the popout window is a new browsing context. The frame then has a parent with no runtime, and it leaves the bus. A group with a frame panel has no **Pop out** button. The workspace also blocks the drop of a frame tab into a popout window. In Chrome, the drop of the Research tab into a popout window did not happen. The drop of the Order ticket tab did.
- **A reload of the frame.** The registration binds the window of the frame and not one document. After **Reload frame**, the link comes back, and the records arrive again. `e2e/playground/react.smoke.ts` checks it.
- **A restart.** `shutdown()` removes each registration of a frame and a worker. After **Apply and restart**, the app raises a runtime generation in `src/observability/runtime-generation.ts`. The Positions panel and each frame panel register again when the number changes. `e2e/playground/react.smoke.ts` checks that the worker and the Research frame send records after a restart.
- **The sandbox.** The partner iframe and the Untrusted iframe have `sandbox="allow-scripts allow-same-origin"`. `allow-same-origin` keeps the origin of the widget. Without it, the frame has an opaque origin, and the bus can not forward for it. The setting is safe only because the widgets are on port 5174 and the workspace is on another origin. A frame of the same origin with both flags can remove its own sandbox. With `allow-scripts` alone, the Untrusted widget did not start in Chrome. Its module script has the origin `null`, and the dev server sends no CORS header for that origin.

## Session replay

The config has `replay.enabled` and `replay.requireConsent`. The recorder stays off until the user agrees in **Privacy choices** and `startReplay()` runs.

1. The user sets the replay switch. The app calls `startReplay()`.
2. The user places an order while the fault switch is on **Reject, 422**. The order gives an ERROR record.
3. The library uploads the last minute of the page, and the next 5 seconds, to `replay.endpoint`.
4. The **Support** panel asks the mock ingest server for the list of recordings. **Play** loads one recording and plays it with `rrweb-player`.

The recorder masks the text of each element and the value of each input. The player shows `********` for them. See [Session replay](../../docs/api.md#session-replay) for the other rules.

A new runtime starts with the recorder off. `resumeReplay()` in `src/observability/user-context.ts` calls `startReplay()` again for a user who agreed. It runs at the page start, after a restart and after the start that follows a shared-device logout. A shared-device logout also removes the choice, so the next user does not record.

The replay service is the mock ingest server. It keeps at most 20 recordings, 100 segments for each recording and 64 MiB in total. The store counts bytes of the body. The oldest recording leaves first. A segment that would take one recording past 64 MiB gets `400` and a reason. `GET /v1/replay/recordings` lists them. `GET /v1/replay/recordings/<id>` gives one recording with its segments in order. The folder [`src/replay-player/`](src/replay-player/README.md) reads these two routes. A team that copies it replaces one function.

The **Chart** panel shows why `replay.recordCanvas` is a row of its own. A canvas has no DOM nodes. With the row off, the recorder does not read its pixels.

## The window of one panel

**Open panel in new window** opens `/panel.html` with the panel in the query and the journey token in the fragment. A browser sends no fragment to a server, so no server log holds the token. The window is a new document. It is not an iframe, so the bus does not link it to the workspace.

1. The opener starts a journey named `panel-window` when none runs, and reads `getJourneyToken()`.
2. The window starts its own runtime with `configure()`.
3. The window asks the opener for the user and the tenant with one `postMessage`. The opener answers only to a window that it opened, from its own origin, to its own origin. The answer has no token.
4. The window logs in for itself, so it has its own token and its own refresh timer.
5. The window calls `adoptJourney()` with the token of the address. The login rotates the security context, and a rotation ends the active journey, so the adoption comes after the login.
6. The window sets `window.opener` to `null`. A page that the window loads later can then not reach the workspace. A reload of the window ends it too, and the window then asks you to open it again from the workspace.
7. The window follows each change of the privacy choices. `watchConsent()` in `src/observability/consent-sync.ts` listens for the `storage` event of the consent key. It applies the choice that the workspace stored, in both directions. It stores nothing, so a late task can not put an older choice over a newer one. A removed key is no grant, and the window ignores it. A second workspace tab does not follow a change from another tab. Only the windows of single panels do.
8. At `pagehide`, the window revokes its own token. It sends `POST /api/logout` with `keepalive` and its own bearer header. The listener starts before the login, because the login sets the token first and then rotates for up to 3 seconds. A page that the browser restores from its back/forward cache holds a revoked token. The window then ends. It clears the token, stops the listeners for `pagehide` and for the consent key, and shuts the library down. It also refuses a login that is still to come, and it shows "Open it again from the workspace". No browser run covers this restore.

The records of the window and of the workspace then have the same `journey.id`. The opener ends the journey that it started when the window closes. A logout, a tenant switch and a page unload close the windows. A new journey in one window, for example an order, ends the link.

## Token refresh

The page refreshes the token at 80 percent of its life, and again at 80 percent of the life of the new token. The "Token refresh" recipe says that the library needs no call. The `headers` function reads the current token on each request, so the next batch carries the new token. `src/session/token-refresh.ts` is the timer. `refreshSession()` in `src/session/session.ts` runs in the queue of the login, the logout and the rotation. It returns at once when no token is set. A logout that comes during the request waits in the queue. It then revokes the new token.

The mock API has `POST /api/refresh`. It gives a new token for the same session and ends the old token. `UIOBS_APP_API_TOKEN_TTL_MS` shortens the life of a token, for a demo.

## Observability settings

The panel is the one of the [react-custom-backend example](../react-custom-backend/README.md#observability-settings), with more rows.

- A live strip shows the delivery state of the library, and the diagnostic counters.
- The table has one row for each setting. It shows the current value, the faster value, what the faster value costs, the evidence label and when the change applies.
- A setting that applies at runtime goes to `configure()` at once. A setting that is fixed after startup waits as "Staged". **Apply and restart** runs `await shutdown()` and then `configure()`. It also raises the runtime generation, so the worker and the frames register again.
- The cost meter times log calls under the settings in force. This app sends no COOP and no COEP header, so the clock has a coarse step and the blocks are longer. See [Why the app sends no COOP and COEP headers](#why-the-app-sends-no-coop-and-coep-headers).

New rows in this app:

| Setting | Config key | Evidence |
| --- | --- | --- |
| Rage click events | `capture.interactions.rageClicks` | expected |
| Dead click events | `capture.interactions.deadClicks` | expected |
| Long frame capture | `capture.longFrames` | expected |
| Web vitals | `capture.webVitals` | expected |
| Profiler probes | `profiler.enabled` | expected |
| Frame phases | `profiler.framePhases` | expected |
| Frame pacing | `profiler.framePacing` | expected |
| Session replay | `replay.enabled` | measured. The recorder adds 75 µs at p50 to a round of 20 new DOM rows. See [Performance](../../docs/performance.md). |
| Record the canvas | `replay.recordCanvas` | expected |

The default settings favor more data. Each row then has a cheaper value to show. The price ticks make 16 DEBUG records each second. They go to the ingest server until you change **Lowest level sent** or the keep rate of `market.prices`.

With **Console output** on, **Lowest level sent** does not stop the DEBUG records in the Activity log. The console prints them, so the library builds them. Turn **Console output** off and set the level to WARN. The ticks then leave the Activity log. `e2e/playground/react.smoke.ts` checks this.

## What the example found

These notes come from a run in Chrome, unless a note says otherwise. They are not a benchmark.

- **dockview and StrictMode.** `dockview-react` 8.9.1 keeps its instance when StrictMode runs the cleanup of the first mount. `onReady` runs one time for each instance. A listener that you add in `onReady` and remove in a parent effect is gone after the first mount. The layout then never saves. `src/workspace/workspace.tsx` keeps the instance in state and adds the listeners in an effect.
- **Clicks in a popout window.** The library listens on the window of the page, and a popout window is another window. Three clicks in 300 ms on **Export** in the main window gave one `ui.rage_click` event. The same three clicks in a popout window gave no event. The app now gives each popout window to `observeWindow()` in `src/workspace/popout-observer.ts`. The three clicks then gave one `ui.rage_click` event in a popout window that opened by the group button, by the tab menu, and by a saved layout. In the dockview 8.9.1 source, only the group button, the tab menu and the restore of a saved layout open a popout window. A drop moves a group into a window that is already open. No browser run checked a drop.
- **Dead clicks.** The check watches the document for a change within one second. A change inside an element with `data-observability-live` is not an answer to the click. The app marks the price tiles, the tick rate, the quote of the ticket, the positions values, the status and price cells of the blotter, the chart, the Activity log list and the live strip. Each control is outside the marked elements. With the **Order ticket** panel closed, one click on **Export** gave `ui.dead_click` in the main window and in a popout window. With the panel open, one click in a popout window gave none. The form re-renders at each price tick, and 2 seconds gave 480 attribute changes on its inputs, only `name` and `type`. The library counts each of them as an answer. Hypothesis: React writes the two attributes again at each render.
- **A forwarded record skips the processors of the page.** The Activity log shows no record of the worker or of a frame. The ingest server gets them, in the batches of the page. Only `redact` runs on a forwarded record. The example has no workaround.
- **`bus.journey_denied` and `journey:read`.** A registered worker without `journey:read` used to add 1 to `bus.rejected_message` at each start. The library now counts the refused journey request as `bus.journey_denied`, and it does not count it as `bus.rejected_message`. The Positions worker has `journey:read`, so both counters stay at 0 for it. The unregistered Untrusted widget still adds 1 to `bus.rejected_message` and 1 to `bus.untrusted_origin` for its hello.
- **A pause and a grant in one page do not attach the worker again.** A page that starts paused starts no bus. The Positions worker then finds no owner, and it has no endpoint, so it sends nothing. After the user sets the telemetry switch again, the records of the page arrive, and the records of the worker did not, in one run. Reload the page to attach the worker and the frames. Hypothesis: a worker that found no owner stays without one.
- **An unregistered cross-origin frame becomes a sender.** The widget lists the workspace in `bus.trustedOrigins`, so it posts its hello. The bus rejects the hello. In one run, each load added 2 to `bus.rejected_message` and 2 to `bus.untrusted_origin`. The workspace can not read the frame, so the panel shows the counters of its own bus. The widget reports the role `sender` after about 4.5 seconds.
- **`shutdown()` removes the registrations.** The first version of **Apply and restart** left the Positions worker and the Research and Partner frames without an owner. The records of the worker and of the frames stopped. The generation counter fixed it.
- **A popout window can get a frame panel in two more ways.** **Add panel** puts a new panel in the active group, and a popout group is the active group while its window has focus. A saved layout can also hold a frame panel in a popout group, and dockview opens each saved popout window again. In Chrome, with Prices in a popout window, **Add panel** and **Research** put the frame in the main window. A saved popout group with Prices and Research opened a popout window with Prices only.
- **A window with an opener gets its own tab id.** `window.open` copies the `sessionStorage` of the opener, so a new window used to start with the tab id of the opener. The library now gives the window a new tab id at its start. In one run, the panel window and its opener sent records with different tab ids, and the session ids differed too.

## Why the app sends no COOP and COEP headers

The react-custom-backend example sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. This app does not.

- This app embeds a cross-origin iframe from port 5174. Under `require-corp`, that iframe must send its own isolation headers.
- This app opens popout windows and a window for a panel. The library needs neither header.
- The cost meter still works. The clock step is 100 µs, and a block is longer, about 20 ms. A result is marked clock-limited only when a block spans fewer than 100 steps. The step and the block length come from one run in Chrome.

## Trust boundaries

A list for a review. Each item is a place where this app trusts another document, a window or a server.

| Where | What it trusts | How |
| --- | --- | --- |
| `registerFrame()` for Research | The window of `/research.html`, at the origin of the workspace | Exact origin, `["records", "journey:read"]`. The call comes before the frame loads. |
| `registerFrame()` for the Partner widget | The window of the partner page, at `VITE_PARTNER_ORIGIN` | Exact origin, `["records", "journey:read"]`. The frame has `sandbox="allow-scripts allow-same-origin"`. |
| No registration for the Untrusted widget | Nothing | The widget is on port 5174, so it can not read the workspace. The bus rejects its hello and counts it. |
| `registerWorker()` for the Positions worker | The dedicated worker of the panel | `["records", "journey:read"]`. |
| `bus.trustedOrigins` in `playground/vanilla/partner.ts` | `http://localhost:5180` and `http://localhost:5187` | The widget posts its hello only to these origins, and it accepts the welcome only from them. |
| `configure()` in the Positions worker, in the Research frame and in the partner widget | Nothing | No endpoint, so a child that finds no owner sends nothing. A child can not read the consent of the user. |
| `postMessage` from the opener to a panel window | The window that the opener opened | The target origin is the origin of the page, never `"*"`. The opener checks `event.origin` and `event.source` before it answers. The answer has the user and the tenant, and no token. |
| `postMessage` from a panel window to its opener | The opener | The target origin is the origin of the page. The window accepts one answer, from the opener window and from its own origin. |
| The address of a panel window | The panel id | `parsePanelRequest()` accepts only an id of the panel list, and not the settings panel. The journey token is in the fragment. |
| The `storage` event of the consent key | Another document of the same origin | `watchConsent()` applies a change of `telemetry` and `replay`, in both directions. A page of another origin can not write the key. |
| `POST /api/logout` at `pagehide` of a panel window | The bearer token of the window | The window revokes only its own token. The request has `keepalive`, so the browser sends it while the page closes. |
| The `Host` header of the mock servers | The name in the request | The servers answer `localhost` and `127.0.0.1` only, and they listen on `127.0.0.1`. |
| `GET /v1/replay/recordings` and `/v1/replay/recordings/<id>` of the mock ingest server | The id in the address | The route accepts only ids of 8 to 64 letters, digits and hyphens. It answers only the allowed origins with CORS headers. |
| `POST /api/refresh` of the mock app API | The bearer token | The route needs a known token. It ends the old token. |

## Before you copy this to production

The mock servers and the widgets of this example are for a demo. Check each point before a copy goes to a real service.

- The replay read routes need authentication, a support role and a tenant filter. `getJson()` in `replay-api.ts` must then send a credential. CORS is not an access control.
- Send telemetry with a token that can only write to the ingest service. Do not use the API token that places orders. `src/observability/config.ts` sends the API bearer token today.
- `playground/vanilla/partner.ts` trusts the smoke origin 5187. A production widget trusts only the production workspace origin.
- `sandbox="allow-scripts allow-same-origin"` on the partner frame is safe only while the partner origin differs from the workspace origin.
- The backend must not trust the namespace or the attributes of a record from a frame.
- Serve the replay player with a CSP or from its own origin. A crafted recording can make the browser load URLs.
- The library listens in a popout window only after the app gives it to `observeWindow()`. The window must have the origin of the page.

## What to copy

| Copy | Use | Replace |
| --- | --- | --- |
| `src/observability/` | The `configure()` config, the headers function, the login, tenant, logout, consent and replay calls, and the error boundary with the provider and hooks. It also has the consent sync of several windows and the runtime generation. See its [README](src/observability/README.md). | The endpoints, `SERVICE_NAME` and `getToken`. |
| `src/observability-settings/` | The settings section, the hint catalog, the live strip, the cost meter and the recent records. See its [README](src/observability-settings/README.md). | `app-routes.ts` and `DEFAULT_SETTINGS`. |
| `src/replay-player/` | The player and the replay list requests. See its [README](src/replay-player/README.md). | `REPLAY_SERVICE_URL` and `getJson()`. |
| `src/main.tsx` | The `configure()` call at module scope, before `createRoot()`, and `resumeReplay()`. | The settings source. |
| `src/workspace/layout-store.ts` | The saved layout of each user and tenant, with the fallback for a damaged layout. | The storage key. |
| `src/panels/frame-panel.tsx` | An iframe that the app registers before it loads. | The registration. |
| `src/workspace/panel-windows.ts` and `src/panel-window/` | The window of one panel, with the journey handoff. | The session handshake. |
| `src/workspace/popout-observer.ts` | The hookup that gives each dockview popout window to `observeWindow()`. | The dock type, if you use another window manager. |
| `src/session/token-refresh.ts` | The refresh timer. | Nothing. |
| `src/panels/positions.worker.ts` and `positions-panel.tsx` | A worker that logs, and the page that registers it. | The messages and the computation. |
| `vite.config.ts` and `public/popout.html` | The proxy table, the worker format, the pages and the popout page. | The targets. |
| `vitest.setup.ts` and `test/observability.ts` | One setup for all specs. | `serviceName`. |

## Tests

```bash
pnpm --filter @example/react run test
```

- `vitest.setup.ts` configures the library with the memory transport before each spec. It runs `await shutdown()`, `memory.clear()` and `memory.respondWith(200)` after each spec.
- `layout-store.test.ts` checks the saved layouts, the fallback for each damaged layout and the removal of frame panels from saved popout groups.
- `session.test.ts` checks the order of the steps of a login, a tenant switch, a shared-device logout and a refresh. It also checks each failure.
- `token-refresh.test.ts` checks the timer with fake timers: the wait, the new wait, a failure and a stop.
- `user-context.test.ts` runs the real library. It checks the pause and the resume of a consent change, the tenant on the records and the discard of a shared-device logout.
- `replay-consent.test.ts` checks who calls `startReplay()` and `stopReplay()`, and when.
- `paused-start.test.ts` checks a login on a page that starts paused after a withdrawal of consent.
- `panel-windows.test.ts` and `panel-window/protocol.test.ts` check the address of a window, the journey, and the check of each message.
- `replay-api.test.ts` checks the parsing of the replay list and of one recording.
- `config.test.ts`, `hints.test.ts` and `settings-store.test.ts` check the config, the hint catalog and the settings store.
- `restart.test.ts` calls `restartObservability()`. It checks the tenant and the `Authorization` header of the next batch, an anonymous restart and the runtime generation.
- `runtime-generation.test.ts` checks the counter that the panels read.
- `consent-sync.test.ts` checks how a window follows a change of the consent key.
- `shared-device.test.ts` checks the options that the shared-device logout gives to `shutdown()`.
- `frame-panels.test.ts` checks which groups get a **Pop out** button and which drops the workspace blocks.
- `popout-observer.test.ts` checks that each popout window goes to `observeWindow()` once, and that its stop function runs when dockview lets go of the window and at the cleanup.
- `default-layout.test.ts` checks that **Add panel** puts a frame panel in the grid when a popout window is active.
- `panel-window/window-run.test.ts` and `panel-window/page-lifecycle.test.ts` check the start and the end of a panel window, and its listeners for `pagehide` and the restore from the cache.
- `api/client.test.ts` checks the logout at `pagehide`, and that `listOrders()` asks again for each call.

The browser smoke test starts its own servers on the ports 5187, 5188, 8797 and 8798. `pnpm run test:playground` also starts port 5186 for the smoke test of the react-custom-backend example. `e2e/playground/mock-servers.smoke.ts` checks the `Host` rule and the byte limit of the replay store. The tests need Chromium and a built library.

```bash
pnpm exec playwright install chromium
pnpm run test:playground
```

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| The login screen shows "The mock app API is not reachable". | Start the example with `pnpm run example:react`. It starts the API. |
| The terminal shows no record of `[react-workspace]`. | Look for a failed proxy request in the **Network** tab. Check that the ingest server runs on port 8787. |
| `pnpm run example:react` stops with "Port 5174 is already in use". | `pnpm run dev` or another command holds the port. Stop it. |
| The Partner widget panel shows an error page. | The cross-origin server is not on port 5174. Run `pnpm run example:react`, or `pnpm run dev:cross-origin`. |
| The Support list is empty. | Set the replay switch in **Privacy choices**. Then make an ERROR record, for example with the fault switch on **Reject, 422**. Click **Refresh the list** after a few seconds. |
| **Pop out** or **Open panel in new window** opens no window. | The browser blocked the popup. Allow popups for `http://localhost:5180`. |
| A group with a frame panel has no **Pop out** button. | This is on purpose. A frame in a popout window leaves the bus. |
| A request to a mock server gets `403` and the text "The Host header is not a loopback name". | Use `localhost` or `127.0.0.1` as the name in the address. `vite --host` with a LAN address gets this answer too. |
| A panel window says "Open this window with the button of a panel in the workspace". | The page has no opener. A reload of a panel window gives the same text, because the window drops its link to the workspace. Open the window from the workspace. |
| A popout window has the wrong colors after a theme change. | The window keeps the theme of its start. Close it and pop the group out again. |
| The workspace opens a layout that you do not expect. | Click **Reset layout**. Or remove the key `react-workspace.layout:<user>:<tenant>` from `localStorage`. |
| The page starts paused. | You cleared the telemetry switch in **Privacy choices**. The key is `react-workspace.consent`. Set the switch again, then reload the page, so the worker and the frames attach to the bus. |
| The page starts with the settings of an earlier session. | **Reset to defaults** restores them. The key is `react-workspace.settings` in `localStorage`. |

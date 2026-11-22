# observability-settings

This folder holds the "Observability settings" section. It imports only React and the public API of the library. Copy it into your app and replace the lines in the table.

| File | What it does | Replace |
| --- | --- | --- |
| `app-routes.ts` | The values that name your app, `TRACE_TARGETS` and `TRACES_PATH`, and `onOrigin()`. | Both values. |
| `settings.ts` | The `Settings` type and `DEFAULT_SETTINGS`. | The defaults. They favor more data. Each row then has a cheaper value to show. |
| `hints.ts` | The hint catalog. It also maps each setting to its config key. | The texts, when your app differs. |
| `settings-store.ts` | The draft and the applied settings. It reads and writes `localStorage` and calls `configure()` in the queue. | Nothing. |
| `operation-queue.ts` | One queue for each call that changes the library, and the busy state. Login, logout, restart and a run of the cost meter use it too. | Nothing. |
| `tap.ts` | A processor that counts records and keeps the last 50 of each kind. A handler that keeps the last 20 diagnostics. A hook that keeps the last 20 loss reports, for `onDrop`. | The list of noisy namespaces. |
| `meter.ts` | The cost meter. | Nothing. |
| `transport.worker.ts` | The transport worker. It calls `serveTransportWorker()`. | Nothing. |
| `*.tsx` | The section, the settings table, the live strip, the cost meter and the recent records. | The class names. |

The section needs the processor and the diagnostic handler in the config. `buildConfig()` in `../observability/config.ts` sets both, and `onDrop`. Copy those lines too.

This folder imports nothing from outside, except the library and React. The specs of this folder need `vitest.setup.ts` and `test/observability.ts` of the app. `hints.test.ts` also needs the `happyDOM.url` setting of `vite.config.ts`, because the span endpoint is an absolute URL on the origin of the page.

## Use it

```tsx
<ObservabilitySettings onRestart={restartObservability} />
```

The section holds the live strip, the settings table and the cost meter. `RecentRecords` is a separate component. This app shows it in the Activity log panel. Add `<RecentRecords />` to the section if you want one panel.

`onRestart` stops the library and starts it again with the given settings. The panel calls it for a setting that is fixed after startup. It runs in the queue. Do not call anything else that changes the library while it runs.

## The hint catalog

Each hint has the config path, the faster value, what the faster value costs, when it applies and an evidence label.

- `applies: "runtime"` goes to `configure()` at once.
- `applies: "restart"` waits for **Apply and restart**. `limits`, `batching`, `storage`, `transportWorker` and `tracesEndpoint` are in this group. With isolation on, `configure()` also refuses a change of a routing setting.
- The group "Replay" has `replay.enabled` and `replay.recordCanvas`. The replay config that is fixed for the app, the loader, the endpoint, the headers and `requireConsent`, is in `buildConfig()`. `configFor()` and `buildConfig()` merge the `replay` section.
- `capture.webVitals` needs a loader, because the library never imports `web-vitals` by name. `hints.ts` has it as one stable function.
- The click rows, `rageClicks` and `deadClicks`, and the profiler rows, `framePhases` and `framePacing`, write into one config section each. `interactionsConfig()` and `profilerConfig()` in `hints.ts` build it from all the settings of the section.
- `evidence: "measure here"` means that the cost meter shows the difference. `evidence: "expected"` means that nobody measured it.
- A hint without a faster value, such as compression, trades two costs. It does not call one value faster.

`hints.test.ts` configures each value of each hint. A wrong key name fails the spec.

## The processor tap

A processor sees each record that the library builds. The library also builds a record for the console and for a breadcrumb. The count is therefore larger than the count of sent records. The strip calls it "records built".

The tap keeps the last 50 records of the noisy namespaces `market.prices` and `observability.meter`, and the last 50 of all other records. A stream of price ticks therefore cannot push an order record out of the list.

`RecentRecords` polls the tap twice a second. It keeps a new list in its state only when the shown records changed. A hidden price tick then writes nothing to the DOM. The list also has the attribute `data-observability-live`, and so has the live strip. The dead-click check of the library does not count a change inside such an element as the answer of the page to a click. The filter and the switch are outside the list.

## The cost meter and the clock

The meter shows `crossOriginIsolated` and the measured clock step next to each result. An app that sends no COOP and no COEP header has a clock step of 100 µs in Chrome. The meter then times longer blocks of calls. The result is still marked clock-limited when a block spans fewer than 100 steps.

# observability

This folder holds the library hookup of the app. Copy it into your app and replace the lines in the table.

| File | What it does | Replace |
| --- | --- | --- |
| `config.ts` | `buildConfig()` builds the whole config. `routing()` builds the routing settings for the anonymous context or the user context. The config has the replay settings, `replay.requireConsent` and the `onDrop` hook. | `SERVICE_NAME`, `LOGS_PATH`, `METRICS_PATH`, `REPLAY_PATH`, `loadRecorder` and `redact()`. |
| `auth-headers.ts` | The `headers` function. It reads the token on each request. | The import of `getToken`. |
| `consent.ts` | The privacy choices, telemetry and replay, in `localStorage`. | The storage key. |
| `user-context.ts` | `beginUserContext()`, `switchTenantContext()`, `endUserContext()`, `stopForSharedDevice()`, `startAnonymous()`, `restartObservability()`, `setTelemetryConsent()`, `setReplayConsent()`, `applyTelemetryConsent()`, `applyReplayConsent()` and `resumeReplay()`. The `set` functions store the choice and apply it. The `apply` functions only apply it. | Nothing. |
| `consent-sync.ts` | `watchConsent()` listens for the `storage` event of the consent key. It applies a change of the telemetry and the replay choices in a window that did not make the change. It stores nothing. | The storage key. |
| `runtime-generation.ts` | A number that rises when a new runtime starts, and `useRuntimeGeneration()`. An effect that registers a frame or a worker lists it, so it registers again after a restart. | Nothing. |
| `react.tsx` | `LoggerProvider`, `useLogger()`, `useJourney()` and `ObservabilityErrorBoundary`. | Nothing. |

## What the folder imports from outside

Each import that leaves the folder is in this table. If you copy only this folder, replace each of them.

| File | Import | What it gives |
| --- | --- | --- |
| `config.ts` | `../observability-settings/hints` | `configFor()`, `SPANS_HINT` and `TRANSPORT_WORKER_HINT`. The hints pull in `app-routes.ts`, `settings.ts` and `transport.worker.ts` of that folder. |
| `config.ts` | `../observability-settings/app-routes` | `onOrigin()`, which builds an absolute URL on the origin of the page. |
| `config.ts` | `../observability-settings/settings` | The `Settings` type. |
| `config.ts` | `../observability-settings/tap` | `tapProcessor`, `tapDiagnostic` and `tapDrop`, for the settings section and the Support panel. |
| `user-context.ts` | `../observability-settings/settings` | The `Settings` type. |
| `consent-sync.ts` | `./user-context` | `applyTelemetryConsent()` and `applyReplayConsent()`. |
| `auth-headers.ts` | `../session/token` | `getToken()`. Replace it with your token source. |

The caller runs each function of `user-context.ts` through `runExclusive()` of `../observability-settings/operation-queue`. In this app, `../session/session.ts`, `applyStaged()` and the privacy dialog do it.

The specs of this folder need `vitest.setup.ts` and `test/observability.ts` of the app, and the `happyDOM.url` setting of `vite.config.ts`. `config.test.ts` also imports the settings folder and `session/token`.

## Rules

- Call `configure()` one time at module scope, before `createRoot()`, with the anonymous config. See `src/main.tsx`.
- Keep `authHeaders` as one function. `configure()` counts a function as the same setting only when it is the same reference.
- The anonymous routing has no `headers`. The user routing has `authHeaders`. An anonymous batch then cannot carry a token.
- Log in with `beginUserContext()`. The rotation sends the anonymous records with the anonymous routing, and the user routing starts with the new context.
- Switch tenant with `switchTenantContext()`. It uses `pending: "discard"`. A flush would send the records of the old tenant with the headers function, and that function already reads the token of the new tenant.
- Log out with `endUserContext()` before you revoke the token. The flush of the user's records needs the token.
- Log out on a shared device with `stopForSharedDevice()`, then revoke the token, then `startAnonymous()`.
- A rotation replaces each routing setting. `routing()` gives the whole set each time. No setting goes back to its default.
- A rotation that rejects closes the delivery of the old context. `switchTenantContext()` and `beginUserContext()` then forget the tenant, so a restart starts the anonymous config.
- Run login, tenant switch, logout, restart and consent change one at a time. A restart in the middle of a rotation makes the rotation reject.
- `restartObservability()` is the way to change a setting that is fixed after startup. It reads the `securityContext.id` after `shutdown()` and gives it to the new runtime. It sets the tenant again.
- `setTelemetryConsent(false)` pauses the library and leaves it with no endpoint. It stores the choice. `buildConfig()` reads the choice, so the next page load starts paused.
- The recorder stays off until `startReplay()` runs, because the config has `replay.requireConsent`. A new runtime starts with the recorder off, so each start calls `resumeReplay()`. That is the page start, a restart and the start after a shared-device logout.
- `stopForSharedDevice()` also removes the privacy choices, so the next user of the device does not inherit a choice to record.
- `replay.loader`, `replay.headers` and the other functions of the config are one reference each. A new function starts a new recording and drops the buffer.
- Set `redact` before you turn on `capture.console`. A console call can carry request headers, and `redact()` here removes `console.args`.
- Use absolute endpoint URLs. The library reports `config.invalid` for a relative endpoint. `onOrigin()` resolves a path against the page, and the Vite proxy still sends the call to the log backend.
- In `react.tsx`, `useJourney()` does not end the journey when the component unmounts. A journey belongs to a workflow, not to a component. Read the JSDoc of `endOnUnmount` before you set it.
- `ObservabilityErrorBoundary` is necessary. React sends a render error to the nearest boundary and not to `window.onerror`. This app wraps each panel in one.

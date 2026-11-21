# observability

This folder holds the library hookup of the app. Copy it into your app and replace the lines in the table.

| File | What it does | Replace |
| --- | --- | --- |
| `config.ts` | `buildConfig()` builds the whole config. `routing()` builds the routing settings for the anonymous context or the user context. | `SERVICE_NAME`, `LOGS_PATH`, `METRICS_PATH` and `redact()`. |
| `auth-headers.ts` | The `headers` function. It reads the token on each request. | The import of `getToken`. |
| `consent.ts` | The privacy choices in `localStorage`. | The storage key. |
| `user-context.ts` | `beginUserContext()`, `switchTenantContext()`, `endUserContext()`, `stopForSharedDevice()`, `startAnonymous()`, `restartObservability()` and `setTelemetryConsent()`. | Nothing. |
| `react.tsx` | `LoggerProvider`, `useLogger()`, `useJourney()` and `ObservabilityErrorBoundary`. | Nothing. |

## What the folder imports from outside

Each import that leaves the folder is in this table. If you copy only this folder, replace each of them.

| File | Import | What it gives |
| --- | --- | --- |
| `config.ts` | `../observability-settings/hints` | `configFor()`, `SPANS_HINT` and `TRANSPORT_WORKER_HINT`. The hints pull in `app-routes.ts`, `settings.ts` and `transport.worker.ts` of that folder. |
| `config.ts` | `../observability-settings/app-routes` | `onOrigin()`, which builds an absolute URL on the origin of the page. |
| `config.ts` | `../observability-settings/settings` | The `Settings` type. |
| `config.ts` | `../observability-settings/tap` | `tapProcessor` and `tapDiagnostic`, for the settings section. |
| `user-context.ts` | `../observability-settings/settings` | The `Settings` type. |
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
- Set `redact` before you turn on `capture.console`. A console call can carry request headers, and `redact()` here removes `console.args`.
- Use absolute endpoint URLs. The library reports `config.invalid` for a relative endpoint. `onOrigin()` resolves a path against the page, and the Vite proxy still sends the call to the log backend.
- In `react.tsx`, `useJourney()` does not end the journey when the component unmounts. A journey belongs to a workflow, not to a component. Read the JSDoc of `endOnUnmount` before you set it.
- `ObservabilityErrorBoundary` is necessary. React sends a render error to the nearest boundary and not to `window.onerror`. This app wraps each panel in one.

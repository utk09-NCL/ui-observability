# observability

This folder holds the library hookup of the app. Copy it into your app and replace the lines in the table.

| File | What it does | Replace |
| --- | --- | --- |
| `config.ts` | `buildConfig()` builds the whole config. `routing()` builds the routing settings for the anonymous context or the user context. | `SERVICE_NAME`, `LOGS_ENDPOINT`, `METRICS_ENDPOINT` and `redact()`. |
| `uilogs-serializer.ts` | A `LogSerializer` that writes the example uilogs JSON and cuts each record to the limits of the server. | The field names. They must match your backend. |
| `uilogs-limits.ts` | The four limits of the example server. | The numbers of your server. |
| `auth-headers.ts` | The `headers` function. It reads the token on each request. | The import of `getToken`. |
| `user-context.ts` | `beginUserContext()`, `endUserContext()` and `restartObservability()`. | Nothing. |
| `react.tsx` | `ObservabilityErrorBoundary`. | Nothing. |

## What the folder imports from outside

Each import that leaves the folder is in this table. If you copy only this folder, replace each of them.

| File | Import | What it gives |
| --- | --- | --- |
| `config.ts` | `../observability-settings/hints` | `configFor()`, `SPANS_HINT` and `TRANSPORT_WORKER_HINT`. The hints pull in `app-routes.ts`, `settings.ts` and `transport.worker.ts` of that folder. |
| `config.ts` | `../observability-settings/settings` | The `Settings` type. |
| `config.ts` | `../observability-settings/tap` | `tapProcessor` and `tapDiagnostic`, for the settings section. |
| `user-context.ts` | `../observability-settings/settings` | The `Settings` type. |
| `auth-headers.ts` | `../session/token` | `getToken()`. Replace it with your token source. |

The caller runs `beginUserContext()`, `endUserContext()` and `restartObservability()` through `runExclusive()` of `../observability-settings/operation-queue`. In this app, `../session/session.ts` and `applyStaged()` do it.

The specs of this folder need `vitest.setup.ts` and `test/observability.ts` of the app. `config.test.ts` also imports the settings folder and `session/token`.

## Rules

- Call `configure()` one time at module scope, before `createRoot()`, with the anonymous config. See `src/main.tsx`.
- Keep `authHeaders` as one function. `configure()` counts a function as the same setting only when it is the same reference.
- The anonymous routing has no `headers`. The user routing has `authHeaders`. An anonymous batch then cannot carry a token.
- Log in with `beginUserContext()`. The rotation sends the anonymous records with the anonymous routing, and the user routing starts with the new context.
- Log out with `endUserContext()` before you revoke the token. The flush of the user's records needs the token. The rotation then returns to the anonymous routing.
- A rotation replaces each routing setting. `routing()` gives the whole set each time. No setting goes back to its default.
- Run login, logout and restart one at a time. A restart in the middle of a rotation makes the rotation reject.
- `restartObservability()` is the way to change a setting that is fixed after startup. It reads the `securityContext.id` after `shutdown()` and gives it to the new runtime. It sets the tenant again.
- Set `redact` before you turn on `capture.console`. A console call can carry request headers, and `redact()` here removes `console.args`.
- A batch has no fixed size. The exit flush merges the queued batches, the batches in flight and the buffer into one batch. After a burst, it can hold thousands of records.
- Your backend must answer `413` for a live or stored batch that is too large. The library then splits the batch in two and sends the halves. A backend that answers `400` makes the library drop the whole batch.
- A split needs storage. With `storage.backend: "none"`, the library loses the batch, and `onDrop` reports `not_stored`. Each further split waits for a later drain, about 30 seconds.
- The exit flush never gets a `413`. A body above about 60 KB goes into the emergency queue. In this app it stays there, because each page load starts a new security context.
- To deliver such a batch after a reload, pass a stable `securityContext.id` to `configure()`. This app does not, because a reload shows the login screen.

## The relative endpoint report

`config.ts` uses relative endpoints. The library reports `config.invalid` for each one and works as usual. The [app README](../../README.md#the-relative-endpoint-report) tells how to read the report and how to remove it.

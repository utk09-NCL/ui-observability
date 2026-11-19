# Production recipes

This document gives the lifecycle recipes for a production application. Each recipe uses only the exported functions and the config keys of this package.

See [runtime policies](runtime-policies.md) for each default and each range. See [delivery guarantees](delivery-guarantees.md) for each loss and its `onDrop` reason.

## Initialization order

1. Call `configure()` one time in the shell, before the first log call.
2. Give the full config in that call. Include `securityContext.id` when the application must resume stored batches after a reload.
3. Call `getLogger()` in each module. A microfrontend usually calls only `getLogger()`.
4. Call `startReplay()` after the user agrees, when `replay.requireConsent` is `true`.
5. Use `rotateSecurityContext()` for each later change of identity or routing settings.

A log call before `configure()` starts a runtime with default settings. The call does not throw. That runtime already has the default `correlation` and `identity` settings, and the first `configure()` cannot change them.

`shutdown()` followed by `configure()` builds a new runtime from the new config only. This is the method to change a setting that is fixed after startup.

### Settings that are fixed after startup

A later `configure()` call reports `config.invalid` for these settings and keeps the current values. The other settings in the same call apply.

| Setting                            | Fixed from                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `identity`                         | The start of the runtime.                                                                                                      |
| `correlation` (each key)           | The start of the runtime.                                                                                                      |
| `limits` (each key)                | The first `configure()` call of the application.                                                                               |
| `journey.maxAgeMs`                 | The first `configure()` call of the application.                                                                               |
| `profiler.maxProbes`               | The first `configure()` call of the application.                                                                               |
| `storage` (each key)               | The start of the runtime. After an early log call, the first `configure()` can set it until a delivery stack builds the store. |
| `bus.mode`, `bus.openFinRole`      | The start of the runtime.                                                                                                      |
| `batching`, `retention` (each key) | The load of the delivery stack.                                                                                                |
| `transport`, `transportWorker`     | The load of the delivery stack. `configure()` cannot add or remove one.                                                        |
| `endpoint` (removal only)          | The load of the delivery stack. `configure()` cannot remove it.                                                                |

Three more rules refuse a change at runtime.

- `securityContext.isolation` is `true` by default. Then `configure()` refuses a change to `endpoint`, `metricsEndpoint`, `tracesEndpoint`, `headers`, `credentials`, `transport`, `transportOnExit`, `transportWorker` and `securityContext.id`. Use `rotateSecurityContext()` for these changes.
- With `lockConfiguration: true`, `configure()` accepts only identical settings. A change reports `config.locked`. Rotation stays available.
- During a rotation, `configure()` reports `config.locked` and changes nothing.

A function counts as identical only when it is the same reference. Keep the `headers` function and each transport function in a stable variable.

## What each stop function does

Each function stops a different part. Select the function from this table, not from its name.

| Call                                      | What stops                                                                                                                                                                                                                       | Data in memory                                                                                                                                                                                                            | Data in storage                                                                                                                                                     | How to start again                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `configure({ enabled: false })`           | The library builds no new record. This includes log, action, metric and span records. Logger calls print nothing to the console. The delivery stack, the installed captures and the session replay recorder continue to operate. | Records that are in the buffers stay. The library continues to send them. Context attributes and breadcrumbs stay.                                                                                                        | No change. The retry engine continues to send the stored batches.                                                                                                   | `configure({ enabled: true })`. A locked configuration refuses both calls.                                                                     |
| `stopReplay()`                            | The session replay recorder and the replay request in flight. Logging and delivery continue.                                                                                                                                     | The library drops the replay buffer and each replay segment that is not sent. Log records stay.                                                                                                                           | No change.                                                                                                                                                          | `startReplay()`. A later `configure()` does not start the recorder.                                                                            |
| `shutdown()`                              | Each subsystem. The library runs a normal flush, then the exit flush. It then cancels each open request, removes each capture and stops the bus. Later calls do nothing.                                                         | The final flush sends the pending records or stores them. Records that wait for the load of the delivery stack are lost with `load_failed`. `getHealth()` and `getStats()` can read the stopped runtime.                  | Stored batches stay. The stored batch of a cancelled request also stays.                                                                                            | `configure()` with the full config. The new runtime does not get the old config or the old context attributes.                                 |
| `clearPersistedLogs(scope?)`              | Nothing.                                                                                                                                                                                                                         | No change. A pending record or a request in flight can write to storage again after the call.                                                                                                                             | The call removes the stored batches and the emergency queue of the active context. With `"namespace"`, it removes them for each context in the `storage.namespace`. | No action is necessary.                                                                                                                        |
| `rotateSecurityContext(update, options?)` | The sender of the old context, its retries and its open requests. The active trace and the active journey end. During the rotation, the library drops logger calls, metric values and forwarded records.                         | The `pending` rule decides for the old records. The library clears the context attributes, the breadcrumbs, the debug buffer and the replay buffer. It applies `update.context` and starts a new session and a new trace. | `discard` and `flush` remove the stored batches and the emergency queue of the old context. `retain` keeps them under the old ID. `carry` moves them to the new ID. | Delivery starts automatically with `update.routing`. With `routing: {}`, the runtime is console-only until a later rotation gives an endpoint. |

Notes for the table.

- `shutdown()` tries to send the pending records. Do not use it to stop delivery after the user withdraws consent.
- `clearPersistedLogs()` does not stop an identity. Use an awaited rotation to stop an identity.
- `newSession()` changes only the correlation in this tab. It does not isolate queues or credentials.
- No function recalls a request that the server accepted.

## Login

The application has an anonymous context before login. A rotation starts the context of the user.

1. Make an opaque context ID for the login. Do not put a secret or personal data in the ID.
2. Call `rotateSecurityContext()` with the ID, the routing settings and the context attributes of the user.
3. Select the `pending` rule for the records from before login. `discard` is the default.
4. Wait for the promise before the application logs for the user.
5. Create new scoped loggers when their attributes name the previous user.

```ts
import { rotateSecurityContext } from "@utk09/ui-observability";

await rotateSecurityContext(
  {
    id: opaqueLoginContextId,
    routing: {
      endpoint: "https://ingest.example/v1/logs",
      headers: authHeaders,
    },
    context: { tenant: "tenant-a" },
  },
  { pending: "flush" },
);
```

`flush` tries to send the old records with the old settings. `timeoutMs` limits the wait. Its default is 5000, and its range is 0 to 600000. `routing` replaces each routing setting. A field that you omit resets to its default.

After a reload with a user who is logged in, give the same `securityContext.id` in the first `configure()` call. A generated ID does not resume the stored batches of a previous page.

## Logout

1. Call `rotateSecurityContext()` before the application revokes the token. A `flush` needs the old headers.
2. Give the routing settings of the anonymous context. Omit `id`, and the runtime makes a new ID.
3. Wait for the promise.
4. Revoke the token and clear the application state.
5. Update each `contextProvider` closure and each scoped logger that has attributes of the user.

```ts
import { rotateSecurityContext } from "@utk09/ui-observability";

await rotateSecurityContext(
  { routing: { endpoint: "https://ingest.example/v1/logs" } },
  { pending: "flush", timeoutMs: 3000 },
);
await revokeToken();
```

The rotation clears the context attributes, the breadcrumbs and the replay buffer. The next user of a shared device does not get the trail of the previous user. Use `pending: "discard"` when the old records must not go out.

With isolation on, which is the default, `configure({ headers: null })` is a refused change. Use the rotation for logout. `headers: undefined` keeps the token in each `configure()` call. With isolation off, `configure({ headers: null })` clears the headers.

If the rotation rejects, the library stops the delivery of the old context. It sends no record with the old token. It keeps the unsent records of the old context in storage under the old ID. It drops each new record and reports it to `onDrop` with `security_context`. `getHealth()` shows the issue `security.rotation_failed`. Revoke the token anyway. Then call `rotateSecurityContext()` again with valid routing settings, for example `{ routing: {} }` for console-only mode. That rotation applies its `pending` rule to the records of the old user. With `flush`, the library removes them, because it does not send them with the old token.

A logout rotation can start while a login rotation runs. It then waits, and it runs after the login rotation.

A rotation rejects in a forwarder, and the delivery of the forwarder stays open. Do the rotation in the upstream owner. Other tabs keep their active context, and the host must coordinate them.

## Tenant rotation

1. Make a new opaque context ID for the new tenant. Never use one ID for two tenants.
2. Give the endpoint, the headers and the credentials of the new tenant together in `routing`.
3. Select `discard` to remove the records of the old tenant. Select `retain` to keep them under the old ID.
4. Wait for the promise. A rotation that starts during another rotation runs after it.

```ts
import { rotateSecurityContext } from "@utk09/ui-observability";

await rotateSecurityContext(
  {
    id: opaqueContextIdTenantB,
    routing: {
      endpoint: "https://tenant-b.example/v1/logs",
      headers: tenantBHeaders,
      credentials: "omit",
    },
    context: { tenant: "tenant-b" },
  },
  { pending: "discard" },
);
```

Invalid routing settings reject the promise. Each rejection closes the delivery of the old context. The old sender then stops. Its stored batches stay under the old ID. A warning does not reject the promise, for example `transport` with `transportWorker`. A key that is not a routing setting reports `config.invalid`, and the rotation ignores it. With `retain`, the library sends the old records only when the old ID is active again.

After a rejection, the library sends nothing more to the old tenant. The unsent records of the old tenant stay stored under the old ID. Each new record is dropped and reported to `onDrop` with `security_context`, until a rotation succeeds. Correct the routing settings and call `rotateSecurityContext()` again. The `pending` rule of that call applies to the records of the old tenant, so `discard` removes them also with isolation off. Do not use `configure()` to change the tenant. It does not open the delivery again.

## Token refresh

A token refresh is not a change of identity. Do not call `configure()` or `rotateSecurityContext()` for it.

1. Give `headers` as a function in the first `configure()` call.
2. Let the function read the current token from a variable of the application.
3. Update the variable when the token changes. Keep the same function reference.

```ts
import { configure } from "@utk09/ui-observability";

let token = initialToken;
const authHeaders = () => ({ Authorization: `Bearer ${token}` });

configure({
  serviceName: "orders",
  endpoint: "https://ingest.example/v1/logs",
  headers: authHeaders,
});

function onTokenRefresh(next: string): void {
  token = next;
}
```

The function can return a promise. After a 401 or a 403 answer, the library calls the function again and sends the batch one more time. A second 401 or 403 drops the batch.

With isolation on, a new `headers` function in `configure()` is a refused change. The session replay uses `replay.headers`, not `headers`.

## Consent withdrawal

1. Unlock the configuration when the application locked it.
2. Call `configure({ enabled: false })`. The library then builds no new record.
3. Call `stopReplay()`. The library drops the replay data that is not sent.
4. Call `rotateSecurityContext()` with an empty `routing` and `pending: "discard"`. This removes the pending and stored records of the active context.
5. Call `clearPersistedLogs("namespace")` when the parked batches of other contexts must also go.

```ts
import {
  clearPersistedLogs,
  configure,
  rotateSecurityContext,
  setConfigurationLocked,
  stopReplay,
} from "@utk09/ui-observability";

// Unlock and lock only when the application uses lockConfiguration.
setConfigurationLocked(false);
configure({ enabled: false });
setConfigurationLocked(true);

stopReplay();
await rotateSecurityContext({ routing: {} }, { pending: "discard" });
await clearPersistedLogs("namespace");
```

An empty `routing` resets the endpoint to `null`. The runtime is then console-only and sends nothing. The library cannot recall a request or a beacon that the server accepted.

`clearPersistedLogs("namespace")` applies to the configured `storage.namespace` only. It removes the stored batches of each context in that namespace, including parked batches.

A rotation rejects in a forwarder. Do step 4 in the upstream owner.

When the user agrees again, do these steps.

1. Call `configure({ enabled: true })`. Unlock the configuration first when it is locked.
2. Call `rotateSecurityContext()` with the endpoint and the headers.
3. Call `startReplay()`.

## Action telemetry is not an audit trail

`logAction()` writes one record with `log.type` `action`. `minLevel` does not drop an action record. With the default `sampling.alwaysSampleTypes`, sampling does not drop it. Its delivery is best effort.

- The client controls the record. Code on the page can omit a call, change a payload or set `enabled: false`.
- The record can be lost. See [delivery guarantees](delivery-guarantees.md) for each loss.
- The server can get one batch more than one time.

Do not use action telemetry as the authoritative record of a business transaction. Keep that record on the server that processes the transaction.

## Release and source-map correlation

The library writes these resource attributes on each record.

| Attribute                | Source               |
| ------------------------ | -------------------- |
| `service.name`           | `serviceName`        |
| `service.version`        | `serviceVersion`     |
| `deployment.environment` | `environment`        |
| `telemetry.sdk.version`  | The package version. |

Set `serviceVersion` to the identifier of the build, for example the version or the commit of the release. The backend can then select the records of one release.

An error record has `error.stack_trace` with the stack that the browser gives. In a minified build, the stack has minified names and positions.

Backend symbolication is out of scope. The library does not upload a source map, does not write a source-map identifier and does not change a stack. The team that owns the backend must keep the source maps of each `service.version` and apply them there.

## Open items

These facts are not verified against the code.

- The lifetime of the cached result of a `headers` function between two sends.
- The behavior of `shutdown()` followed by `configure()` with no `securityContext.id` for the batches that the old runtime stored. [Runtime policies](runtime-policies.md) states the rule only for a page reload.
- The effect of the first `configure()` on `profiler.maxProbes` after an early log call started a default runtime.

# Console-only example

This example shows the library in an app with no ingest server. The library sends nothing. It prints each record to the devtools console. The app installs no optional peer.

Read the [playground guide](../README.md) for the devtools tips.

## Run it

```bash
pnpm run build
pnpm run example:console-only
```

Open `http://localhost:5195`. This example needs no mock ingest server.

## What to look for

| Place                        | Look for                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Devtools console             | One line for each button, for example `[board.hop][INFO] info from console-only {button: 'info'}`.           |
| Devtools console             | **INFO from a nested namespace** prints the namespace `board.hop.panel`. It comes from `log.child("panel")`. |
| Devtools console             | The **DEBUG** button prints nothing until you select **Verbose** in the levels menu.                         |
| The page                     | The section **Storage keys that start with "ui-observability."** shows `(none)` after each click.            |
| Devtools **Application** tab | No `ui-observability.*` key, and no IndexedDB database `UiObservability`.                                    |
| Devtools **Network** tab     | No request to an ingest server.                                                                              |

Vite prints the console warnings and errors of the browser in its terminal, with `[vite] (client)`. These lines are not records of the library.

## What to copy

Copy `src/logger.ts`. Import it before each other module that logs.

| Option                         | Effect                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `endpoint: null`               | The library loads no transport, no storage and no exit flush.             |
| `identity: "memory"`           | The library keeps the session, tab and journey ids in memory.             |
| `storage: { backend: "none" }` | The library keeps no undelivered batch.                                   |
| `bus: { mode: "off" }`         | The library starts no bus.                                                |
| `consoleOutput`                | `DEBUG` and above in development. `WARN` and above in a production build. |

See [Console Only (No Network)](../../docs/guides.md#console-only-no-network) and [Console Output](../../docs/guides.md#console-output).

## Peer check

`vite.config.ts` has a plugin that fails when code imports `web-vitals` or `@opentelemetry/api` by name. The repository root installs both peers. The plugin stands in for an app that does not install them. `pnpm run check:dev` loads this example to prove that the library imports no optional peer by name.

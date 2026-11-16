# Microfrontend example

This example shows the library in a page that Module Federation composes. One shell loads two remotes into one document. The three parts share one runtime and one sender.

Read the [playground guide](../README.md) first. It explains the mock ingest server and each line that the terminal prints.

| Folder            | Package               | Port | Framework        | Role                                  |
| ----------------- | --------------------- | ---- | ---------------- | ------------------------------------- |
| `host/`           | `@example/mf-host`    | 5191 | Plain TypeScript | The shell. It calls `configure()`.    |
| `remote-blotter/` | `@example/mf-blotter` | 5192 | Plain TypeScript | A remote. It uses `getLogger()` only. |
| `remote-ticket/`  | `@example/mf-ticket`  | 5193 | React            | A remote. It uses `getLogger()` only. |

## Run it

Start the mock ingest server in one terminal:

```bash
pnpm run dev:ingest
```

Build the library and start the three dev servers in a second terminal:

```bash
pnpm run build
pnpm run example:microfrontend
```

Open `http://localhost:5191`.

## What to look for

Open the devtools console.

| Action                           | Look for                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Load the page                    | The terminal shows `shell booted` and `ticket remote mounted`. Both records have the same `journey=` id.               |
| Load the page                    | The console shows the namespaces `shell`, `blotter.grid` and `ticket.form`. The namespace tells you which part logged. |
| Load the page                    | The console shows `blotter remote mounted`. The terminal does not show it in most loads.                               |
| **load positions**               | `[action] POSITIONS_LOAD` in the terminal. Sampling never drops an action.                                             |
| **submit from the React remote** | `[action] ORDER_SUBMIT` in the terminal.                                                                               |

Each record in the terminal shows `[example-shell]`. The remotes do not call `configure()`, so the shell's `serviceName` applies to all parts.

The shell sets `sampling.rates` to keep 5 percent of the `blotter.grid` records. Sampling keeps or drops all records of one journey together. The console prints a record that sampling drops. The terminal does not get it.

## Run a remote alone

Open `http://localhost:5192` or `http://localhost:5193` while the dev servers run. The remote then starts its own runtime from `src/standalone.ts` or `src/standalone.tsx`. Its records show `[example-blotter-standalone]` or `[example-ticket-standalone]`.

## What to copy

- `host/src/main.ts`. The shell calls `configure()` one time and starts the journey before the first record.
- `remote-blotter/src/mount.ts`. A remote calls `getLogger()` with its own namespace. `scopedContext` adds the module name and version to its records.
- `remote-ticket/src/mount.tsx`. A React remote follows the same rule.

Keep these rules from the example:

- Call `configure()` only in the shell. A call in a remote changes `service.name` on each record of the document.
- Put the standalone `configure()` call in a separate entry file. Do not guard it in `mount`. A remote can load before the shell calls `configure()`.
- Load each remote in its own `try` block. A remote that fails to load then leaves only its own panel empty, and the shell logs the error.
- `shared: { "@utk09/ui-observability": { singleton: true } }` saves bytes. The runtime lives on a global symbol. Two copies of one library version still find one runtime.

See [Core Architecture](../../README.md#core-architecture) and [Configuration ownership and logger cache](../../docs/runtime-policies.md#configuration-ownership-and-logger-cache).

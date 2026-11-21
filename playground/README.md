# Playground

The playground has five example applications. Each example shows the library in one type of project. Use this guide to select an example, start it and find its output.

## Select an example

| Example | Project type | Command | Open |
| --- | --- | --- | --- |
| [vanilla](vanilla/README.md) | Plain TypeScript with no framework. Each feature has a control. | `pnpm run dev` | `http://localhost:5173/playground/vanilla/index.html` |
| [react](react/README.md) | React 19 with hooks, an error boundary, metrics and session replay. | `pnpm run example:react` | `http://localhost:5180` |
| [angular](angular/README.md) | Angular 22 with a provider, an `ErrorHandler` and the router. | `pnpm run example:angular` | `http://localhost:4200` |
| [microfrontend](microfrontend/README.md) | Module Federation. One shell and two remotes share one runtime. | `pnpm run example:microfrontend` | `http://localhost:5191` |
| [console-only](console-only/README.md) | No network. The library prints each record to the devtools console. | `pnpm run example:console-only` | `http://localhost:5195` |

Start with the vanilla playground to see each feature. Then open the example for your framework. The section [Copy a setup into your app](#copy-a-setup-into-your-app) names the file to copy.

## Before you start

1. Use Node 22.22.3 or later. The `packageManager` field of the root `package.json` sets the pnpm version.
2. Install the workspace from the repository root.
3. Build the library. Each example except vanilla imports the build in `dist/`.

```bash
pnpm install
pnpm run build
```

Run each command of this guide from the repository root.

The vanilla playground imports the library from `src/` and needs no build. The other examples need `pnpm run build` again after a change in `src/`. `pnpm run build:watch` builds the library at each change.

## Start the mock ingest server

Each example that sends records sends them to `tools/mock-ingest-server.mjs` on port 8787. `pnpm run dev` starts this server with the vanilla playground. For each other example, start the server in a second terminal:

```bash
pnpm run dev:ingest
```

The server accepts requests only from the origins of the examples and of the browser tests. `ALLOWED_ORIGINS` in `tools/mock-ingest-server.mjs` lists them. A request from another origin fails the CORS preflight.

Each example posts to port 8787. `UIOBS_MOCK_PORT` moves the server to a different port. It does not change the port of the examples. Set it only for a client that posts to that port.

| Path | Use |
| --- | --- |
| `/v1/logs` | Log, action, event, error and metric records. Each example sends here. |
| `/v1/metrics` | Metric points in the OTLP metrics format. Only the React example sets `metricsEndpoint`. |
| `/v1/traces` | Spans in the OTLP traces format. Only the vanilla playground sets `tracesEndpoint`. |
| `/v1/replay` | Session replay segments. Only the vanilla playground sets `replay.endpoint`. |
| `/__control` | Sets the status that the server returns for each batch. The vanilla playground has a button for it. |
| `/__sampling` | Sets the sampling rules that the server returns. The vanilla playground has a button for it. |
| `/__timing` | Returns a `Server-Timing` header. The vanilla playground has a button for it. |
| `/__reset` | Clears the received requests, the known batch ids, the forced status and the sampling rules. The browser tests use it. |
| `/__received` | Returns the requests that the server kept for each path. The server keeps them only with `UIOBS_MOCK_RECORD=1`. The browser tests read it. |
| `/__echo` | Returns the request headers that the server received. The trace propagation test reads it. |

## Where to look

| Place | What it shows | How to open it |
| --- | --- | --- |
| Terminal | Each batch and each record that reached the mock server | Read the terminal that runs `pnpm run dev` or `pnpm run dev:ingest`. |
| Devtools console | One line for each record, with its namespace, level and payload | Press F12, or Cmd+Option+I on macOS. Select **Console**. |
| Devtools **Network** tab | Each request to port 8787, with its status and its headers | Type `8787` in the filter box. |
| Devtools **Application** tab | The keys in `localStorage` and `sessionStorage`, and IndexedDB | Open the **Storage** group in the side bar. |
| The page | Diagnostics, tables and JSON results of some examples | The README of each example names them. |

- Each console line has the form `[namespace][LEVEL] message payload`. See [Console Output](../docs/guides.md#console-output).
- Chrome hides `console.debug` output by default. The library prints a `DEBUG` record with `console.debug`. Select **Verbose** in the levels menu of the console.
- A record from an automatic capture has the namespace `uiobs.capture`.
- The terminal does not show the namespace. Use the devtools console to find the namespace of a record.
- A request body above 1 KiB is compressed with gzip. The **Network** tab cannot show it as text. Read the terminal.
- Vite prints the console errors and warnings of the browser in its own terminal. These lines contain `[vite] (client)`. They are not records of the library.
- A command that starts more than one process puts a number in front of each line, for example `[1]`.
- **Clear site data** in the **Application** tab removes the stored ids and batches. The next load starts with a new session.

## Read the terminal

The mock server prints one header line for each request. It then prints one line for each item of the request.

```text
[batch] batch=d8941415-ed22-4ea4-a655-6c66933ffd63 records=4
2026-11-16T17:30:10.479Z  INFO   [playground]  [log]  hello from the playground  journey=-  tab=a9c26f17  trace=c9d04dee
```

A record line has these fields, from left to right:

1. The time of the record.
2. The level.
3. `service.name`, from the `serviceName` option.
4. `log.type`. The value is `log`, `system`, `action`, `event` or `metric`. A capture writes `system` for an error and `event` for a click.
5. The message. A metric record shows the metric name.
6. `journey.id`. The value is `-` when no journey is active.
7. The first 8 characters of `tab.id`.
8. The first 8 characters of the trace id.

The [Attribute reference](../docs/attributes.md) describes each attribute.

| Line | Meaning |
| --- | --- |
| `[batch] batch=<id> records=<n>` | One request to `/v1/logs`. The next lines are its records. With `serializer: "ecs"`, each line is one document of the NDJSON body. |
| `[metrics] batch=<id> points=<n>` | One request to `/v1/metrics`. Each next line is one point with its type, value, unit and attributes. |
| `[traces] batch=<id> spans=<n>` | One request to `/v1/traces`. `[client]` is an HTTP request. `[internal]` is another span. `parent=-` is a root span. |
| `[replay] replay=<id> sequence=<n> events=<n> bytes=<n> session=<id>` | One segment of a session replay. |
| `[exit pagehide] batch=<id>` | The exit flush sent this batch while the page closed. See [Page Exit](../docs/delivery-guarantees.md#page-exit). |
| `[forced 503] batch=<id> attempt=<n>` | The server refused the batch on purpose. `attempt` counts the earlier sends of this batch. |
| `[duplicate] batch=<id> ignored` | The server received a batch id a second time and ignored the batch. A request with no batch id is never a duplicate. See [Duplicates](../docs/delivery-guarantees.md#duplicates). |
| `[control] ...` | A control request changed the state of the server. |

## Change the server behavior

Make the server return 503 for each batch, with a `Retry-After` of 3 seconds:

```bash
curl -X POST "http://localhost:8787/__control?status=503&retryAfter=3"
```

Make the server accept each batch again:

```bash
curl -X POST "http://localhost:8787/__control?status=200"
```

The vanilla playground has buttons for these requests and for the sampling rules.

## Copy a setup into your app

| Your project | Read | Copy |
| --- | --- | --- |
| Plain TypeScript or JavaScript | [vanilla](vanilla/README.md) | The `configure()` call in `vanilla/main.ts` |
| React | [react](react/README.md) | `react/src/observability.tsx`, and the `configure()` call in `react/src/main.tsx` |
| Angular | [angular](angular/README.md) | `angular/src/observability.ts`, and `provideObservability()` in `angular/src/main.ts` |
| Module Federation, or more bundles on one page | [microfrontend](microfrontend/README.md) | `host/src/main.ts` for the shell, and `remote-blotter/src/mount.ts` for a remote |
| No ingest server, or local development only | [console-only](console-only/README.md) | `console-only/src/logger.ts` |
| Iframes | [vanilla](vanilla/README.md#child-frames) | The `registerFrame()` loop in `vanilla/main.ts`, and `vanilla/child.ts` |
| Delivery from a worker | [vanilla](vanilla/README.md#worker-transport) | `transportWorker` in `vanilla/main.ts`, and `vanilla/transport-worker.ts` |
| Session replay | [react](react/README.md#session-replay) | `react/src/replay-spike.tsx` |
| Profiler | [vanilla](vanilla/README.md#profiler-pages) | `vanilla/blotter.ts` |

Each example imports the library by its package name, `@utk09/ui-observability`. The vanilla playground is the one exception. It imports `../../src/index`. Your app imports the package name.

## Use a real ingest server

The mock server keeps no record. Use it only on your computer.

- `tools/reference-collector.mjs` implements each rule of [Ingest Server Requirements](../docs/ingest-server.md). Its default port is 4320. Set `ALLOWED_ORIGINS` to the origin of the example. Then change the `endpoint` of the example to the collector URL.
- The command line tool tests an ingest server. Run `pnpm run build` first. Then run `node bin/uiobs.mjs doctor http://localhost:8787/v1/logs --origin http://localhost:5173`. See [Check an ingest server](../docs/ingest-server.md#check-an-ingest-server).

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| The terminal shows no record. | Start the mock server. In the **Network** tab, look for a failed preflight. The origin of the page must be in `ALLOWED_ORIGINS`. |
| The example cannot resolve `@utk09/ui-observability`. | Run `pnpm run build`. |
| The example shows old library behavior. | Run `pnpm run build`. Restart the example with `--force`, for example `pnpm --filter @example/react run dev --force`. This clears the Vite cache. |
| The example does not start because a port is in use. | Stop the other process. The mock server accepts only the fixed port of each example. |
| Another program answers on port 8787. | Run `lsof -nP -iTCP:8787 -sTCP:LISTEN` to find the process. Stop it. |
| A metric point arrives late. | The library sums metric values and sends one point for each interval. The default interval is 10 seconds. |
| The console shows a record that the terminal does not. | Sampling dropped the record. The console prints a record that sampling drops. See [Console Only](../docs/guides.md#console-only-no-network). |

## Reference documents

- [Root README](../README.md). Installation, the quick start and the links to the reference documents.
- [Attribute reference](../docs/attributes.md). Each attribute that the library writes.
- [Delivery guarantees](../docs/delivery-guarantees.md). Retries, duplicates, losses and the exit flush.
- [Runtime policies](../docs/runtime-policies.md). Defaults, the bus sources and the configuration owner.
- [Threat model](../docs/threat-model.md). Trust boundaries and privacy controls.
- [Browser support](../docs/browser-support.md). Browser APIs and their fallbacks.

# @utk09/ui-observability

Structured logging and UI observability for browsers, embedded webviews and OpenFin containers. The library imports no framework. OpenFin support is not validated on a real OpenFin runtime.

The library batches records and sends them over HTTP as OTLP/JSON. It stores a batch that fails to send, and sends it again later. When the page closes, the library sends the records that are left. Iframes, workers and OpenFin windows share one sender through the bus. A log call never throws.

> **Status: stable from 1.0.0.** A minor release or a patch release does not make a breaking change. The [release contract](docs/release-and-support.md) states what a breaking change is. To upgrade from 0.12.x, read the [migration guide](docs/migration-v1.md).

---

## Installation

Use one command for your package manager. Each command saves an exact version.

```bash
# npm
npm install --save-exact @utk09/ui-observability

# pnpm
pnpm add --save-exact @utk09/ui-observability

# Yarn
yarn add --exact @utk09/ui-observability
```

The package has an ES module entry and a CommonJS entry. Each entry has its own type declarations.
The types work with `moduleResolution` set to `NodeNext` or `Bundler`. They also work with `skipLibCheck: false`.
Use one module format in one application. The two entries are separate copies with separate state and separate types.

### Peer Dependencies

Each peer is optional. The library has no runtime dependency.

Install `@rrweb/record` (`^2`) for the session replay, and set `replay.loader`. See [Session replay](docs/api.md#session-replay).

Install `web-vitals` (`^4 || ^5 || ^6`) for `capture.webVitals`, and set `capture.webVitals.loader`. The object turns the capture on. Without the loader, the library reports `config.invalid`. LCP, CLS and INP then stay off, and the navigation timing continues.

Install `@opentelemetry/api` (`^1`) to put records on the traces of your spans. Set `otelLoader` to load it. Without `otelLoader`, OTel is off. The library then makes its own `trace_id`.

The library never imports a peer by name. A missing peer cannot break your bundler or your dev server.

```ts
configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  serviceName: "equities-blotter",
  otelLoader: () => import("@opentelemetry/api"),
  capture: {
    webVitals: { loader: () => import("web-vitals") },
  },
});
```

---

## Quick Start

Call `configure()` one time at startup, before the first log call.

```ts
import { configure, getLogger } from "@utk09/ui-observability";

configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  serviceName: "equities-blotter",
  serviceVersion: "2.4.1",
  environment: "production",
});

const log = getLogger("blotter.grid");

log.info("grid ready");
log.logAction("ORDER_SUBMIT", { orderId: "ORD-1001", qty: 100 });
log.error("pricing call failed", caughtError);
```

- Nothing starts before the first `configure()` call that works. Before it, a log call does not throw. The record waits in memory. The library sends nothing and writes nothing to storage.
- An app that never calls `configure()` sends nothing. The console output is off by default, so it prints nothing.
- Call `configure()` from one context in each document. In a composed page, the shell calls `configure()`. Each microfrontend uses its own namespace. A second call changes `service.name` on the records of every other context.
- You can call `getLogger()` at module top level, before `configure()`. The logger finds the runtime on its first write.
- A repeated `configure()` call with the same values and the same function references changes no setting. A later call updates an unlocked runtime in place. Some settings are fixed after startup. Use `rotateSecurityContext()` to change the delivery identity or the routing settings.
- `enabled: false` pauses the library. It does not stop it. `shutdown()` stops it. After `shutdown()`, logging does nothing until the next `configure()`.
- [Initialization order](docs/production-recipes.md#initialization-order) gives each rule of the startup. [Settings that are fixed after startup](docs/production-recipes.md#settings-that-are-fixed-after-startup) gives the rule for each key.

---

## Recipes

### Console only

Set `endpoint: null`. The library sends nothing. It prints records to the console only.

```ts
configure({
  endpoint: null,
  serviceName: "skardela",
  identity: "memory",
  storage: { backend: "none" },
  bus: { mode: "off" },
  consoleOutput: import.meta.env.DEV ? "DEBUG" : "WARN",
});
```

[Console Only](docs/guides.md#console-only-no-network) gives the rules of this mode. [Console Output](docs/guides.md#console-output) gives the line format and the colors.

### Custom transport

Set `transport` to send batches through a channel of your app, for example an API client with token refresh, a WebSocket, Electron IPC or an OpenFin channel. With `transport`, `endpoint` is optional.

```ts
configure({
  serviceName: "equities-blotter",
  transport: async (request) => {
    const response = await apiClient.post("/telemetry", request.body, {
      headers: { "Content-Type": request.contentType, "X-UiObs-Batch-Id": request.batchId },
    });
    const retryAfterSeconds = Number(response.headers["retry-after"]);
    return { status: response.status, retryAfterMs: retryAfterSeconds * 1000 };
  },
  // Optional. It runs while the page closes, so it must not wait for a promise.
  transportOnExit: (request) => navigator.sendBeacon("/telemetry", request.body),
  // Network capture must not log the requests of your transport.
  capture: { ignoreUrls: ["/telemetry"] },
});
```

[Custom Transport](docs/guides.md#custom-transport) gives the status codes, the retry rules and the exit send. [Worker transport](docs/guides.md#worker-transport) sends the batches from a dedicated worker.

### Frames and workers

A child frame or a worker forwards its records to the page over the bus. The page batches, stores and sends them, and its `redact` runs on them. Register each child in the page before the child starts. Each child calls `configure()` too. A cross-origin child also needs the origin of the page in `bus.trustedOrigins`. A child that starts before the page runtime gets no owner. After a timeout, it sends its own records with its own `redact`.

```ts
import { flush, registerFrame, registerWorker } from "@utk09/ui-observability";

// In the page, after configure(). The frame is in the document and has no src yet.
const frame = document.body.appendChild(document.createElement("iframe"));
registerFrame(frame, { origin: "https://ticket.example" });

const worker = new Worker(new URL("./pricing.worker.ts", import.meta.url), { type: "module" });
registerWorker(worker);

// The registrations start with the runtime. A frame that loads before that finds no owner.
await flush();
frame.src = "https://ticket.example/";
```

```ts
// In the frame on https://ticket.example. A same-origin frame or a worker needs no trustedOrigins.
configure({
  endpoint: "https://telemetry.example.com/v1/logs",
  serviceName: "ticket",
  bus: { trustedOrigins: ["https://app.example"] },
});
```

[Registered bus sources](docs/runtime-policies.md#registered-bus-sources) gives the permissions of a child. [Guides](docs/guides.md) also has [Testing](docs/guides.md#testing) and [Remote Sampling](docs/guides.md#remote-sampling). [Production recipes](docs/production-recipes.md) has login, logout, tenant rotation, token refresh and consent withdrawal.

---

## Documentation

| Document                                                   | Content                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [API Reference](docs/api.md)                               | Each exported function, the delivery health, the flush result and the shutdown options.          |
| [Configuration Options](docs/configuration.md)             | Each config key and its default, auto-capture, spans and the browser storage keys.               |
| [Guides](docs/guides.md)                                   | Console output, custom transport, worker transport, testing and remote sampling.                 |
| [Production recipes](docs/production-recipes.md)           | Login, logout, tenant rotation, token refresh, consent withdrawal and the initialization order.  |
| [Ingest Server Requirements](docs/ingest-server.md)        | The ingest contract and the `uiobs doctor` check of an ingest server.                            |
| [Migration to 1.0.0](docs/migration-v1.md)                 | Each change from 0.12.x, with the new code.                                                      |
| [Release and support](docs/release-and-support.md)         | The stable API contract, the supported environments and the release evidence.                    |
| [Runtime policies and migration](docs/runtime-policies.md) | Each default, each range, security-context rotation and the upgrade steps.                       |
| [Delivery guarantees](docs/delivery-guarantees.md)         | Duplicates, order, each loss and its `onDrop` reason, retention, the exit flush and rotation.    |
| [Attribute reference](docs/attributes.md)                  | Each attribute that the library writes, and its type.                                            |
| [Browser support](docs/browser-support.md)                 | The minimum browser versions, the browser APIs that the library uses, and the fallback for each. |
| [Architecture](docs/architecture.md)                       | The core architecture, the layers of the library and the path of a record.                       |
| [Threat model](docs/threat-model.md)                       | The trust boundaries, the threats and the controls.                                              |
| [Performance](docs/performance.md)                         | The release benchmark, its baselines and its budgets.                                            |
| [Development](docs/development.md)                         | The workspace, the checks and the example applications.                                          |
| [Browser tests](e2e/README.md)                             | The Playwright tests and the coverage that is still missing.                                     |
| [Collector check](e2e/collector/README.md)                 | The check against a pinned OpenTelemetry Collector.                                              |
| [Playground guide](playground/README.md)                   | The five example applications and how to start each one.                                         |
| [Security policy](SECURITY.md)                             | How to report a vulnerability.                                                                   |
| [llms.txt](llms.txt)                                       | A summary of the library for a large language model. The package includes it.                    |

---

## Development

Use Node 22.22.3 or later and pnpm 12.21.0.

```bash
pnpm install
pnpm run dev    # Playground, mock ingest server and iframe host
pnpm run verify # Format check, typecheck, build, lint, peer, size, dev-server and consumer checks, tests
```

[Development](docs/development.md) gives the workspace rules, the release checks and the example applications.

---

## Changelog

[CHANGELOG.md](CHANGELOG.md) holds the released versions and their breaking changes.

---

## License

Apache-2.0. See [LICENSE](LICENSE).

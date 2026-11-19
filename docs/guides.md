# Guides

This document gives the longer recipes. The [README](../README.md#recipes) gives the short form of the common recipes.

## Console Only (No Network)

The README recipe [Console only](../README.md#console-only) gives the config. These rules apply to it.

- `endpoint: null` loads no transport, no storage and no exit flush. It reports no diagnostic.
- `identity: "memory"` writes no key to `localStorage` or `sessionStorage`.
- `consoleOutput` and `minLevel` are independent. `consoleOutput` sets what the library prints. `minLevel` sets what the library sends.
- The console output does not depend on the bus or the endpoint.
- With a `redact` hook, the console shows only what `redact` returns. A record that a processor or `redact` drops prints no line. With `redact` or `processors`, a record below `minLevel` or outside the sample also goes through them before the console prints it. Without hooks, such a record shows its message, payload and error as given.

## Console Output

Each console line has the form `[namespace][LEVEL] message payload`:

```text
[app.puzzle-page][INFO] The puzzle page loaded {puzzleId: 'colour-binary-0006', difficulty: 'easy'}
```

The namespace and the level each have a color. To change the colors, use the object form of `consoleOutput`:

```ts
configure({
  consoleOutput: {
    level: "DEBUG",
    styles: {
      namespace: "color:#888",
      INFO: "color:#0a7;font-weight:bold",
      WARN: "color:#c80;font-weight:bold",
    },
  },
});
```

- Each style is a CSS string. A browser applies it with `%c`. Node prints the text without the style.
- A style can set the text color and the background together. This example shows the level as a badge:

  ```ts
  configure({
    consoleOutput: {
      styles: {
        INFO: "color:#fff;background:#1e6fd9;padding:0 4px;border-radius:3px",
        ERROR: "color:#fff;background:#d32f2f;padding:0 4px;border-radius:3px",
      },
    },
  });
  ```

- The style keys are `namespace`, `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` and `FATAL`. A key that you do not set keeps its style.
- The default namespace color is gray. The default levels are gray for `TRACE` and `DEBUG`, blue for `INFO`, orange for `WARN`, and red for `ERROR` and `FATAL`.
- A later `configure({ consoleOutput: "WARN" })` changes the level. The styles stay.
- A later `configure({ consoleOutput: { styles } })` changes the styles. The level stays. A console that is off stays off.

## Custom Transport

The README recipe [Custom transport](../README.md#custom-transport) gives the config. These rules apply to it.

- The library keeps batching, retry, storage, splitting and the exit flush.
- The status code that you return has the meaning of the ingest contract. `2xx` accepts the batch. `413` splits it. `429` and `503` throttle. `408` and `5xx` retry. Each other code drops the batch.
- A rejected promise counts as a network error. The library sends the batch again later. A call that does not settle in 15 seconds counts as a timeout.
- The library does not compress `request.body`. Compress it in your transport if necessary.
- `request.records` holds the built records after `redact`. Do not change them, because the retry engine can send them again.
- `request.kind` is `"metrics"` for a batch of metric records when `metricsEndpoint` is set. `request.body` is then an OTLP `ExportMetricsServiceRequest`. Send it to your metrics endpoint.
- `request.kind` is `"traces"` for a batch of span records. `request.body` is then an OTLP `ExportTraceServiceRequest`. Send it to your traces endpoint. Each other batch has the kind `"logs"`.
- Without `transportOnExit`, the last batch goes to the emergency queue when the page closes. The next page load sends it.
- With `storage: { backend: "none" }`, the next page load cannot keep that batch. Set `transportOnExit`, or the library loses the last batch.
- The library ignores a `retryAfterMs` or a `maxBytes` that is not a finite number. It uses 0 for a negative value.
- `request.signal` aborts at `shutdown()` and at a rotation. Check it to cancel your work. A stored batch of that request stays in storage.
- Return the `Date` header of a `2xx` answer in `date`. The library then computes `uiobs.clock_offset_ms`.
- After the delivery stack loads, you cannot add or remove `transport`. You can replace it with another function.
- Network capture skips a request that your transport starts before its first `await`. Put your telemetry URL in `capture.ignoreUrls` too. A request after an `await` is outside that scope.
- Without that URL in `capture.ignoreUrls`, each send records a value of the `http.client.request.duration` histogram. That value causes the next send, and the sends do not stop. Network capture reports `capture.transport_request` one time when it sees a request during a transport call.

## Worker transport

The app creates a dedicated module worker. Configure its factory at startup.

```ts
configure({
  endpoint: "https://ingest.example/v1/logs",
  serviceName: "orders",
  transportWorker: () =>
    new Worker(new URL("./transport.worker.ts", import.meta.url), { type: "module" }),
});
```

In `transport.worker.ts`:

```ts
import { serveTransportWorker } from "@utk09/ui-observability";

serveTransportWorker();
```

The worker encodes OTLP or ECS, compresses the payload and sends HTTP requests. Record construction, privacy hooks, queue accounting, retry and storage stay on the main thread. The `headers` function also stays there. The worker receives only its resolved headers and built records after the privacy hooks.

- Return a fresh worker from each factory call. The library owns that worker until shutdown or rotation.
- Bundle and serve the worker script with the app. Its worker policy and CORS rules must permit the script and the ingest endpoint.
- Use the same exact library version in the worker and the page. A private transferred port carries a fixed protocol tag and that version.
- `serveTransportWorker()` installs its connection listener at once. It loads the worker delivery code after the connection. Its return value stops the service. Its optional `onDiagnostic` handler runs in the worker.
- One request deadline covers header resolution, transfer, encoding, compression and delivery. The main thread handles status codes, sampling rules and clock offset.
- A startup failure or a channel failure during a send switches that sender to HTTP. A worker that does not connect before the request deadline is a startup failure. A new factory or a rotation permits another worker. A timeout or network failure follows the normal retry policy.
- Hidden-page sends use the main HTTP keepalive path. The exit flush also stays on the main thread. It uses the same cached headers.
- `transport` takes precedence over `transportWorker`. A custom serializer runs on the main thread. Functions do not cross the worker channel.
- With isolation on, change the factory through `rotateSecurityContext()`. After the stack loads, `configure()` cannot add or remove `transportWorker`.
- The helper does not join the context bus. Node remains console-only.

The vanilla playground has links for the worker and main-thread paths. Verify both paths in a real browser before release.

## Testing

Use `createMemoryTransport()` to check what your code logs. It needs no network and no `fetch` mock.

Run the test in a DOM environment. In Node, the library is console-only, so the memory transport gets no batch. In Vitest, install `happy-dom` or `jsdom` and set the test environment.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "happy-dom" },
});
```

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  configure,
  createMemoryTransport,
  flush,
  getLogger,
  shutdown,
} from "@utk09/ui-observability";

const memory = createMemoryTransport();

beforeEach(() => {
  configure({
    serviceName: "orders",
    transport: memory.transport,
    storage: { backend: "none" },
    bus: { mode: "off" },
    identity: "memory",
  });
});

afterEach(async () => {
  memory.clear();
  memory.respondWith(200);
  await shutdown();
});

it("logs the order submit", async () => {
  getLogger("orders.ticket").logAction("ORDER_SUBMIT", { orderId: "ORD-1" });
  const result = await flush();

  expect(result).toMatchObject({ status: "complete", dropped: 0, stored: 0 });
  expect(memory.records()).toContainEqual(expect.objectContaining({ body: "ORDER_SUBMIT" }));
});
```

- `records()` returns the records of each accepted batch. `batches()` returns each request, accepted or refused.
- `respondWith(status, retryAfterMs?)` sets the answer for each later batch. Use it to test a `413`, `429` or `500` answer. The default answer is `200`.
- `clear()` removes the requests and keeps the answer of `respondWith()`. Call `respondWith(200)` in `afterEach` when a test changes the answer.
- `flush()` waits for startup. A record that you log directly after `configure()` is in the flushed batch.
- `flush()` waits 5000 ms at most. `status: "complete"` means only that no record waits. A dropped record and a stored record also count as complete. To confirm delivery, check `accepted`, `dropped` and `stored` in the result, or check `memory.records()`.
- After `shutdown()`, each call does nothing until the next `configure()`.
- Set `storage: { backend: "none" }` in tests. Without it, `shutdown()` stores the unsent records, and the next test can receive them.

## Remote Sampling

With `sampling: { remote: true }`, the ingest server can change the sampling during an incident. You do not deploy the app again.

```http
X-UiObs-Sampling: {"v":1,"ttlMs":600000,"defaultRate":0.1,"rates":{"blotter.grid":1},"minLevel":"DEBUG"}
```

- The library reads the header only on a `2xx` answer to a batch that it sent. A custom transport returns the rules in `TransportResponse.sampling`, as text or as an object.
- `v` must be `1`. `ttlMs` is mandatory, from more than 0 to 3,600,000 (1 hour). After the TTL, the rules from `configure()` apply again.
- `rates` apply over the `configure()` rates. The other `configure()` rates stay. `defaultRate` applies only if the header has it.
- `minLevel` can only lower the level that the library sends. It does not change the console level.
- `minLevels` sets a level for each namespace prefix, for example `{"trading.ticks":"DEBUG"}`. A remote prefix wins over the remote `minLevel`. A remote level applies only when it is lower than the `configure()` level of the namespace. At most 100 prefixes.
- `sampling.remoteMaxRate` caps each remote rate. It also caps the records that a remote `minLevel` adds. Set it below 1 to limit the traffic that a compromised server can cause.
- The library rejects all the rules if one field is not valid, for example a rate outside 0 to 1, more than 100 `rates` or a header longer than 4096 characters. It reports `config.invalid`.
- The library keeps the rules in memory only. A reload uses the `configure()` rules until the next accepted batch.
- A child frame, a worker or an OpenFin view asks its owner for the rules at start and each 30 seconds. Set `sampling.remote: true` in each context.
- A frame accepts rules from a parent only if the parent origin is the page origin or is in `bus.trustedOrigins`. A page that embeds your app cannot lower `minLevel`.
- Under the default `bus.sourcePolicy: "registered"`, a parent sends rules only to a frame or a worker that it registered with the `sampling:read` permission.
- Each OpenFin view of one app can read the bus messages of the others. Load only trusted content into a view that has the `fin` API.

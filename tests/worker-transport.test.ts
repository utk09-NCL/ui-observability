import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSPORT_WORKER_TYPE } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import type { ObservabilityConfig } from "../src/models/config";
import type { StatusTransport } from "../src/transport/status-transport";
import { workerMessage } from "../src/transport/worker-protocol";
import { createWorkerTransport } from "../src/transport/worker-transport";
import { FakeChannel, FakeWorker, stubWorkerChannel, workerJob } from "./worker-fakes";

let transports: StatusTransport[];

beforeEach(() => {
  transports = [];
  stubWorkerChannel();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
});

afterEach(() => {
  for (const transport of transports) {
    transport.stop();
  }
  vi.useRealTimers();
});

function scriptedWorker(result: unknown): FakeWorker {
  const worker = new FakeWorker();
  worker.connect = (_data, port) => {
    port.addEventListener("message", (event) => {
      if (event.data.t === TRANSPORT_WORKER_TYPE.send) {
        port.postMessage(
          workerMessage(TRANSPORT_WORKER_TYPE.result, {
            id: event.data.id,
            result: typeof result === "function" ? result() : result,
          }),
        );
      }
    });
    port.postMessage(workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: true }));
  };
  return worker;
}

function setup(over: ObservabilityConfig = {}) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const diagnostics = new Diagnostics(vi.fn(), 0);
  const config = resolveConfig(
    {
      endpoint: "https://ingest.example/logs",
      serviceName: "svc",
      compression: "none",
      transportWorker: factory,
      ...over,
    },
    diagnostics,
  );
  const onSampling = vi.fn();
  const onLoss = vi.fn();
  const onClock = vi.fn();
  const adapter = createWorkerTransport(config, diagnostics, onSampling, onLoss, onClock);
  transports.push(adapter.transport);
  return { ...adapter, config, workers, factory, diagnostics, onSampling, onLoss, onClock };
}

describe("Worker transport", () => {
  it("sends through the worker and shares dynamic headers with the exit flush", async () => {
    const headers = vi.fn(() => ({ authorization: "Bearer current" }));
    const { transport, factory, exitHeaders } = setup({ headers });
    expect(exitHeaders()).toBeUndefined();
    expect(transport.lastSendAt()).toBeNull();
    const batch = workerJob().batch;
    await transport.send(batch);
    await transport.send(batch);
    expect(factory).toHaveBeenCalledOnce();
    expect(headers).toHaveBeenCalledTimes(2);
    expect(exitHeaders()).toEqual({ authorization: "Bearer current" });
    const sent = FakeChannel.created[0].port1.sent as any[];
    const sentHeaders = new Headers(sent[0].job.headers);
    expect(sentHeaders.get("authorization")).toBe("Bearer current");
    expect(sentHeaders.get("X-UiObs-Batch-Id")).toBe("batch");
    expect(sentHeaders.get("X-UiObs-Attempt")).toBe("0");
    expect(sent[0].job.headers).not.toHaveProperty("then");
    expect(transport.lastSendAt()).not.toBeNull();
    expect(transport.throttledForMs(batch)).toBe(0);
  });

  it("passes accepted sampling rules and Date headers to the main callbacks", async () => {
    const date = "Sun, 01 Nov 2026 10:00:05 GMT";
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T10:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(null, { headers: { Date: date, "X-UiObs-Sampling": "rules" } }),
        ),
      ),
    );
    const { transport, onSampling, onClock } = setup({ sampling: { remote: true } });
    await transport.send(workerJob().batch);
    expect(onSampling).toHaveBeenCalledExactlyOnceWith("rules");
    expect(onClock).toHaveBeenCalledExactlyOnceWith(5500);
  });

  it.each([401, 403])("refreshes main-thread headers after %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    const headers = vi
      .fn()
      .mockReturnValueOnce({ authorization: "expired" })
      .mockReturnValueOnce({ authorization: "new" });
    const { transport, exitHeaders } = setup({ headers });
    await transport.send(workerJob().batch);
    expect(headers).toHaveBeenCalledTimes(2);
    expect(exitHeaders()).toEqual({ authorization: "new" });
  });

  it.each([
    [400, "permanent"],
    [401, "permanent"],
    [403, "permanent"],
    [408, "transient"],
    [413, "too_large"],
    [429, "throttled"],
    [500, "transient"],
    [503, "throttled"],
  ])("classifies status %i as %s", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(status === 413 ? '{"maxBytes":100}' : null, {
            status,
            headers: { "Retry-After": "2" },
          }),
        ),
      ),
    );
    const { transport } = setup();
    await expect(transport.send(workerJob().batch)).rejects.toMatchObject({ kind, status });
    if (kind === "throttled") {
      expect(transport.throttledForMs(workerJob().batch)).toBeGreaterThan(0);
    }
  });

  it("drops a worker serialization failure with its original records and batch id", async () => {
    const worker = scriptedWorker({ failure: "serialize" });
    const { transport, onLoss } = setup({ transportWorker: () => worker as unknown as Worker });
    const batch = workerJob().batch;
    await transport.send(batch);
    expect(onLoss).toHaveBeenCalledExactlyOnceWith("unserializable", batch.records, [batch.id]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["network", "transient"],
    ["timeout", "timeout"],
  ])("classifies the worker failure %s", async (failure, kind) => {
    const worker = scriptedWorker({ failure });
    const { transport } = setup({ transportWorker: () => worker as unknown as Worker });
    await expect(transport.send(workerJob().batch)).rejects.toMatchObject({ kind });
  });

  it("reports a compression failure that still sends a plain batch", async () => {
    const worker = scriptedWorker({ status: 204, compressionFailed: true });
    const { transport, diagnostics } = setup({
      transportWorker: () => worker as unknown as Worker,
    });
    await transport.send(workerJob().batch);
    expect(diagnostics.snapshot()["transport.http_error"]).toBe(1);
  });

  it.each(["factory", "protocol", "malformed"])(
    "uses HTTP after a worker %s failure",
    async (kind) => {
      const worker = scriptedWorker(
        kind === "protocol" ? { failure: "protocol" } : { status: "bad" },
      );
      const factory = vi.fn(() => {
        if (kind === "factory") {
          throw new Error("factory");
        }
        return worker as unknown as Worker;
      });
      const { transport } = setup({ transportWorker: factory });
      await transport.send(workerJob().batch);
      await transport.send(workerJob().batch);
      expect(factory).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps custom serializers and hidden-page keepalive sends on the main thread", async () => {
    const serialize = vi.fn(() => ({ body: "custom", contentType: "text/plain" }));
    const { transport, factory, config } = setup({ serializer: { name: "custom", serialize } });
    await transport.send(workerJob().batch);
    expect(serialize).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
    config.serializer = "otlp";
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const keepalive = vi.fn();
    await transport.send(workerJob().batch, keepalive);
    expect(keepalive).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
    expect(transport.lastSendAt()).not.toBeNull();
  });

  it("works without a document global", async () => {
    vi.stubGlobal("document", undefined);
    const { transport } = setup();
    await transport.send(workerJob().batch);
  });

  it("sends nothing for an empty batch, a missing endpoint or a foreign context", async () => {
    const { transport, factory, config } = setup();
    await transport.send({ ...workerJob().batch, records: [] });
    config.endpoint = null;
    await transport.send(workerJob().batch);
    config.endpoint = "https://ingest.example/logs";
    config.securityContext.id = "owner";
    await expect(transport.send(workerJob().batch)).rejects.toMatchObject({ kind: "permanent" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("closes the old worker when its factory changes", async () => {
    const { transport, config, workers } = setup();
    await transport.send(workerJob().batch);
    const next = new FakeWorker();
    config.transportWorker = () => next as unknown as Worker;
    await transport.send(workerJob().batch);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    config.transportWorker = undefined;
    await transport.send(workerJob().batch);
    expect(next.terminate).toHaveBeenCalledOnce();
  });

  it("keeps a new worker after its replaced worker ends a request", async () => {
    const old = new FakeWorker();
    old.connect = () => undefined;
    const next = new FakeWorker();
    const { transport, config } = setup({ transportWorker: () => old as unknown as Worker });
    const sent = transport.send(workerJob().batch);
    await vi.waitFor(() => {
      expect(old.postMessage).toHaveBeenCalledOnce();
    });

    config.transportWorker = () => next as unknown as Worker;
    await transport.send(workerJob().batch);
    await sent;
    await transport.send(workerJob().batch);

    const results = next.port?.sent.filter(
      (message) => (message as { t: string }).t === TRANSPORT_WORKER_TYPE.result,
    );
    expect(results).toHaveLength(2);
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(next.terminate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("uses HTTP after a worker gives no ready answer", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    worker.connect = () => undefined;
    const { transport } = setup({
      transportWorker: () => worker as unknown as Worker,
      delivery: { requestTimeoutMs: 10 },
    });
    const sent = transport.send(workerJob().batch).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await sent).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies a worker network failure as offline only when the browser says so", async () => {
    const { transport } = setup({
      transportWorker: () => scriptedWorker({ failure: "network" }) as unknown as Worker,
    });
    vi.stubGlobal("navigator", { onLine: false });
    await expect(transport.send(workerJob().batch)).rejects.toMatchObject({ kind: "offline" });
    vi.stubGlobal("navigator", { onLine: true });
    await expect(transport.send(workerJob().batch)).rejects.toMatchObject({ kind: "transient" });
  });

  it("covers the headers function with the same deadline", async () => {
    vi.useFakeTimers();
    let resolve!: (headers: Record<string, string>) => void;
    const { transport, factory } = setup({
      headers: () =>
        new Promise((done) => {
          resolve = done;
        }),
      delivery: { requestTimeoutMs: 10 },
    });
    const sent = transport.send(workerJob().batch);
    const result = expect(sent).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it("checks the deadline after a synchronous headers function", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const { transport } = setup({
      headers: () => {
        clock.mockReturnValue(1000);
        return {};
      },
      delivery: { requestTimeoutMs: 10 },
    });
    await expect(transport.send(workerJob().batch)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("classifies invalid header names without sending a batch", async () => {
    // Emulate the browser check that happy-dom omits.
    const OriginalHeaders = Headers;
    vi.stubGlobal(
      "Headers",
      class extends OriginalHeaders {
        constructor(init?: HeadersInit) {
          super(init);
          if (this.has("bad name")) {
            throw new TypeError("The header name is not valid.");
          }
        }
      },
    );
    const { transport } = setup({ headers: { "bad name": "value" } });
    await expect(transport.send(workerJob().batch)).rejects.toMatchObject({ kind: "transient" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels pending work at stop without HTTP fallback", async () => {
    const worker = new FakeWorker();
    worker.connect = () => undefined;
    const { transport } = setup({ transportWorker: () => worker as unknown as Worker });
    const sent = transport.send(workerJob().batch);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    transport.stop();
    await expect(sent).rejects.toMatchObject({ kind: "permanent" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

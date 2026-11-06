import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configure,
  createMemoryTransport,
  flush,
  getLogger,
  getStats,
  rotateSecurityContext,
  shutdown,
} from "../src/index";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import type { ObservabilityConfig } from "../src/models/config";
import { FakeChannel, FakeWorker, stubWorkerChannel } from "./worker-fakes";

beforeEach(() => {
  stubWorkerChannel();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
});

afterEach(async () => {
  await shutdown();
  vi.useRealTimers();
});

async function setup(over: ObservabilityConfig = {}) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  configure({
    endpoint: "https://ingest.example/logs",
    serviceName: "svc",
    transportWorker: factory,
    bus: { mode: "off" },
    storage: "memory",
    identity: "memory",
    compression: "none",
    capture: { errors: false, rejections: false },
    ...over,
  });
  await flush();
  return { workers, factory, log: getLogger("app") };
}

describe("Worker transport in the runtime", () => {
  it("passes only built records after the privacy hooks to the worker", async () => {
    const { log, workers } = await setup({
      redact: (record) => ({ ...record, attributes: { ...record.attributes, token: "[masked]" } }),
    });
    log.info("worker record", { token: "private" });
    await flush();
    const wire = JSON.stringify(FakeChannel.created[0].port1.sent);
    expect(wire).toContain("[masked]");
    expect(wire).not.toContain("private");
    const body = vi.mocked(fetch).mock.calls[0][1]?.body;
    expect(body).toBeTypeOf("string");
    expect(body).not.toContain("private");
    expect((await getStats()).lastSendAt).not.toBeNull();
    await shutdown();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("stores a failed worker batch and retries it on the main thread", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValue(new Response(null, { status: 204 })),
    );
    const { log, factory } = await setup({
      delivery: { retryBaseDelayMs: 1000, retryMaxDelayMs: 1000 },
    });
    log.info("retry me");
    await flush();
    expect((await getStats()).stored).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await getStats()).stored).toBe(0);
    const calls = vi.mocked(fetch).mock.calls;
    expect((calls[0][1]?.headers as Headers).get("X-UiObs-Batch-Id")).toBe(
      (calls[1][1]?.headers as Headers).get("X-UiObs-Batch-Id"),
    );
    expect(factory).toHaveBeenCalledOnce();
  });

  it("keeps the exit flush and cached headers on the main thread", async () => {
    const { log, factory } = await setup({ headers: () => ({ authorization: "Bearer exit" }) });
    log.info("normal");
    await flush();
    log.info("exit");
    dispatchEvent(new Event("pagehide"));
    expect(fetch).toHaveBeenCalledTimes(2);
    const exit = vi.mocked(fetch).mock.calls[1][1]!;
    expect(exit.keepalive).toBe(true);
    expect((exit.headers as Headers).get("authorization")).toBe("Bearer exit");
    expect(FakeChannel.created[0].port1.sent).toHaveLength(1);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("stops the old worker before it applies the new endpoint and credentials", async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(new Response(null, { status: 204 })),
    );
    const { log, workers } = await setup({
      headers: { authorization: "old" },
      securityContext: { id: "old" },
    });
    log.info("old record");
    const pending = flush();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const next = new FakeWorker();
    await rotateSecurityContext({
      id: "new",
      delivery: {
        endpoint: "https://next.example/logs",
        headers: { authorization: "new" },
        transportWorker: () => next as unknown as Worker,
      },
    });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    release(new Response(null, { status: 204 }));
    await pending;
    log.info("new record");
    await flush();
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("https://ingest.example/logs");
    expect((calls[0][1]?.headers as Headers).get("authorization")).toBe("old");
    expect(calls[1][0]).toBe("https://next.example/logs");
    expect((calls[1][1]?.headers as Headers).get("authorization")).toBe("new");
    const body = calls[1][1]?.body;
    expect(body).toBeTypeOf("string");
    expect(body).not.toContain("old record");
  });

  it("gives a custom transport precedence over a worker factory", async () => {
    const memory = createMemoryTransport();
    const { log, factory } = await setup({ endpoint: null, transport: memory.transport });
    log.info("custom");
    await flush();
    expect(memory.records().map((record) => record.body)).toEqual(["custom"]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses HTTP when the worker module does not load", async () => {
    vi.doMock("../src/transport/worker-transport", () => {
      throw new Error("The chunk did not load.");
    });
    try {
      const { log, factory } = await setup();
      log.info("fallback");
      await flush();
      expect(factory).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../src/transport/worker-transport");
    }
  });

  it("keeps the last valid factory when a config value is invalid", () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const factory = () => new FakeWorker() as unknown as Worker;
    const base = resolveConfig(
      { endpoint: null, serviceName: "svc", transportWorker: factory },
      diagnostics,
    );
    const config = resolveConfig({ transportWorker: 1 as never }, diagnostics, base);
    expect(config.transportWorker).toBe(factory);
    expect(diagnostics.snapshot()["config.invalid"]).toBe(1);
  });

  it("refuses removal of the worker factory after the stack loads", async () => {
    const { factory } = await setup({ securityContext: { isolation: false } });
    configure({ transportWorker: undefined });
    expect(ObservabilityRuntime.current()!.config.transportWorker).toBe(factory);
  });

  it("refuses addition of a worker factory to an active HTTP stack", async () => {
    const { factory } = await setup({
      transportWorker: undefined,
      securityContext: { isolation: false },
    });
    configure({ transportWorker: factory });
    expect(ObservabilityRuntime.current()!.config.transportWorker).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not create a transport worker on Node", async () => {
    vi.stubGlobal("document", undefined);
    const factory = vi.fn(() => new FakeWorker() as unknown as Worker);
    configure({ endpoint: null, serviceName: "svc", transportWorker: factory });
    await flush();
    const runtime = ObservabilityRuntime.current()!;
    expect(runtime.config.transportWorker).toBeUndefined();
    expect(runtime.diagnostics.snapshot()["config.invalid"]).toBe(1);
    expect(factory).not.toHaveBeenCalled();
  });
});

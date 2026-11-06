import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSPORT_WORKER_TYPE } from "../src/constants";
import { Diagnostics } from "../src/core/diagnostics";
import { createWorkerClient, WorkerFault } from "../src/transport/worker-client";
import { workerMessage } from "../src/transport/worker-protocol";
import { FakeChannel, FakePort, FakeWorker, stubWorkerChannel, workerJob } from "./worker-fakes";

beforeEach(() => {
  stubWorkerChannel();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
});

afterEach(() => vi.useRealTimers());

function setup() {
  const worker = new FakeWorker();
  const diagnostics = new Diagnostics(vi.fn(), 0);
  const factory = vi.fn(() => worker as unknown as Worker);
  const client = createWorkerClient(factory, diagnostics);
  const signal = new AbortController();
  return { worker, diagnostics, factory, client, signal };
}

describe("Worker client", () => {
  it("sends concurrent batches on one private port", async () => {
    const { client, factory, worker, signal } = setup();
    const jobs = [workerJob(), workerJob()];
    jobs[1].batch.id = "second";
    const results = await Promise.all(jobs.map((job) => client.send(job, signal.signal, 1000)));
    expect(results).toMatchObject([{ status: 204 }, { status: 204 }]);
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    await client.send(workerJob(), signal.signal, 1000);
    client.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a stopped client and an aborted signal", async () => {
    const { client, signal, factory } = setup();
    signal.abort();
    await expect(client.send(workerJob(), signal.signal, 1000)).rejects.toMatchObject({
      kind: "cancelled",
    });
    client.close();
    await expect(
      client.send(workerJob(), new AbortController().signal, 1000),
    ).rejects.toBeInstanceOf(WorkerFault);
    expect(factory).not.toHaveBeenCalled();
  });

  it("contains a factory failure", async () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const client = createWorkerClient(() => {
      throw new Error("factory");
    }, diagnostics);
    await expect(
      client.send(workerJob(), new AbortController().signal, 1000),
    ).rejects.toMatchObject({ kind: "channel" });
    expect(diagnostics.snapshot()["transport.http_error"]).toBeGreaterThan(0);
    client.close();
  });

  it("contains a failed connect message", async () => {
    const { worker, client, signal } = setup();
    worker.postMessage.mockImplementation(() => {
      throw new Error("connect");
    });
    await expect(client.send(workerJob(), signal.signal, 1000)).rejects.toMatchObject({
      kind: "channel",
    });
    expect(worker.terminate).toHaveBeenCalled();
    client.close();
  });

  it("contains a port listener failure at startup", async () => {
    const { worker, client, signal } = setup();
    vi.spyOn(FakePort.prototype, "addEventListener").mockImplementation(() => {
      throw new Error("listener");
    });
    await expect(client.send(workerJob(), signal.signal, 1000)).rejects.toMatchObject({
      kind: "channel",
    });
    expect(FakeChannel.created[0].port1.close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalled();
    client.close();
  });

  it("fails the channel when the worker gives no ready answer", async () => {
    vi.useFakeTimers();
    const { worker, client, signal } = setup();
    worker.connect = () => undefined;
    const sent = client.send(workerJob(), signal.signal, 10);
    const result = expect(sent).rejects.toMatchObject({ kind: "channel" });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(worker.terminate).toHaveBeenCalledOnce();
    client.close();
  });

  it("ends a request at its deadline and sends cancellation", async () => {
    vi.useFakeTimers();
    const { worker, client, signal } = setup();
    worker.connect = (_data, port) => {
      port.postMessage(workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: true }));
    };
    const sent = client.send(workerJob(), signal.signal, 10);
    const result = expect(sent).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(FakeChannel.created[0].port1.sent).toContainEqual(
      expect.objectContaining({ t: TRANSPORT_WORKER_TYPE.cancel, id: 1 }),
    );
    client.close();
  });

  it("cancels an active send when its signal aborts", async () => {
    const { worker, client, signal } = setup();
    worker.connect = () => undefined;
    const sent = client.send(workerJob(), signal.signal, 1000);
    signal.abort();
    await expect(sent).rejects.toMatchObject({ kind: "cancelled" });
    client.close();
  });

  it("sends no batch when the factory aborts the delivery context", async () => {
    const signal = new AbortController();
    const worker = new FakeWorker();
    const client = createWorkerClient(
      () => {
        signal.abort();
        return worker as unknown as Worker;
      },
      new Diagnostics(vi.fn(), 0),
    );
    await expect(client.send(workerJob(), signal.signal, 1000)).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it("sends no batch when the factory closes its client", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(
      () => {
        client.close();
        return worker as unknown as Worker;
      },
      new Diagnostics(vi.fn(), 0),
    );
    await expect(
      client.send(workerJob(), new AbortController().signal, 1000),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["error", "messageerror", "port error"])(
    "ends each pending call after %s",
    async (event) => {
      const { worker, client, signal } = setup();
      worker.connect = () => undefined;
      const sent = client.send(workerJob(), signal.signal, 1000);
      if (event === "port error") {
        FakeChannel.created[0].port1.emit("messageerror", {});
      } else {
        worker.dispatchEvent(new Event(event));
      }
      await expect(sent).rejects.toMatchObject({ kind: "channel" });
      client.close();
    },
  );

  it.each([
    { p: "wrong" },
    workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: false }),
    workerMessage("other"),
    workerMessage(TRANSPORT_WORKER_TYPE.result, { id: "1" }),
    workerMessage(TRANSPORT_WORKER_TYPE.result, { id: 1, result: { status: "bad" } }),
  ])("refuses an invalid private reply %j", async (message) => {
    const { worker, client, signal } = setup();
    worker.connect = () => undefined;
    const sent = client.send(workerJob(), signal.signal, 1000);
    FakeChannel.created[0].port1.emit("message", { data: message });
    await expect(sent).rejects.toMatchObject({ kind: "channel" });
    client.close();
  });

  it("ignores a second ready message and a result without a pending id", async () => {
    const { worker, client, signal } = setup();
    await client.send(workerJob(), signal.signal, 1000);
    const channel = FakeChannel.created[0];
    const count = channel.port1.sent.length;
    channel.port1.emit("message", {
      data: workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: true }),
    });
    channel.port1.emit("message", {
      data: workerMessage(TRANSPORT_WORKER_TYPE.result, { id: 999, result: { status: 204 } }),
    });
    expect(channel.port1.sent).toHaveLength(count);
    expect(worker.terminate).not.toHaveBeenCalled();
    client.close();
  });

  it("contains a batch clone failure", async () => {
    const { client, signal } = setup();
    const job = workerJob();
    job.batch.records[0].attributes.bad = () => undefined;
    await expect(client.send(job, signal.signal, 1000)).rejects.toMatchObject({ kind: "channel" });
    client.close();
  });

  it("contains cancellation and close failures", async () => {
    const { worker, client, signal, diagnostics } = setup();
    worker.connect = () => undefined;
    const sent = client.send(workerJob(), signal.signal, 1000);
    const port = FakeChannel.created[0].port1;
    port.postMessage.mockImplementation(() => {
      throw new Error("cancel");
    });
    signal.abort();
    await expect(sent).rejects.toMatchObject({ kind: "cancelled" });
    port.close.mockImplementation(() => {
      throw new Error("close");
    });
    client.close();
    expect(worker.terminate).toHaveBeenCalled();
    expect(diagnostics.snapshot()["transport.http_error"]).toBeGreaterThan(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPRESSION_THRESHOLD_BYTES,
  TRANSPORT_WORKER_MAX_JOBS,
  TRANSPORT_WORKER_TYPE,
} from "../src/constants";
import { Diagnostics } from "../src/core/diagnostics";
import * as compression from "../src/transport/compression";
import { workerMessage, type WorkerJob } from "../src/transport/worker-protocol";
import { serveWorkerPort } from "../src/transport/worker-server";
import * as serializers from "../src/transport/serializers/select";
import { FakeChannel, workerJob } from "./worker-fakes";

let stops: (() => void)[];

beforeEach(() => {
  stops = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
});

afterEach(() => {
  for (const stop of stops) {
    stop();
  }
  vi.useRealTimers();
});

function setup() {
  const channel = new FakeChannel();
  const diagnostics = new Diagnostics(vi.fn(), 0);
  const stop = serveWorkerPort(channel.port2 as unknown as MessagePort, diagnostics);
  stops.push(stop);
  const deliver = (data: unknown): void => channel.port2.emit("message", { data });
  const send = (job: WorkerJob = workerJob(), id = 1): void =>
    deliver(workerMessage(TRANSPORT_WORKER_TYPE.send, { id, job }));
  const results = (): any[] =>
    channel.port2.sent.filter((message: any) => message.t === TRANSPORT_WORKER_TYPE.result);
  return { channel, diagnostics, stop, deliver, send, results };
}

describe("Transport worker service", () => {
  it.each(["otlp", "ecs"] as const)(
    "serializes logs as %s and returns response hints",
    async (serializer) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(null, {
              status: 200,
              headers: {
                "X-UiObs-Sampling": "rules",
                Date: "Sun, 01 Nov 2026 10:00:00 GMT",
                "Retry-After": "2",
              },
            }),
          ),
        ),
      );
      const { send, results } = setup();
      const job = workerJob();
      job.serializer = serializer;
      job.headers = { authorization: "Bearer current" };
      send(job);
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0].result).toMatchObject({
        status: 200,
        sampling: "rules",
        date: "Sun, 01 Nov 2026 10:00:00 GMT",
        retryAfterMs: 2000,
      });
      const init = vi.mocked(fetch).mock.calls[0][1]!;
      expect(init).toMatchObject({
        method: "POST",
        priority: "low",
        credentials: "omit",
        cache: "no-store",
      });
      expect((init.headers as Headers).get("authorization")).toBe("Bearer current");
      expect(init.body).toEqual(
        expect.stringContaining(serializer === "otlp" ? "resourceLogs" : '"ecs"'),
      );
    },
  );

  it.each(["metrics", "traces"] as const)("uses the OTLP %s serializer", async (kind) => {
    const { send, results } = setup();
    const job = workerJob();
    job.kind = kind;
    job.batch.records[0].attributes =
      kind === "metrics"
        ? { "metric.name": "count", "metric.value": 1, "metric.type": "gauge", "metric.unit": "1" }
        : { "span.kind": "internal" };
    send(job);
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toEqual(
      expect.stringContaining(kind === "metrics" ? "resourceMetrics" : "resourceSpans"),
    );
  });

  it.each(["compressed", "unsupported", "failed"])("handles gzip as %s", async (mode) => {
    const gzip = vi.spyOn(compression, "gzip");
    if (mode === "compressed") {
      gzip.mockResolvedValue(new Uint8Array([1, 2]));
    } else if (mode === "unsupported") {
      gzip.mockResolvedValue(null);
    } else {
      gzip.mockRejectedValue(new Error("compression"));
    }
    const { send, results } = setup();
    const job = workerJob();
    job.compression = "gzip";
    job.batch.records[0].body = "x".repeat(COMPRESSION_THRESHOLD_BYTES * 2);
    send(job);
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0].result.compressionFailed).toBe(mode === "failed");
    const init = vi.mocked(fetch).mock.calls[0][1]!;
    expect((init.headers as Headers).get("Content-Encoding")).toBe(
      mode === "compressed" ? "gzip" : null,
    );
  });

  it("keeps a small gzip request as text", async () => {
    const gzip = vi.spyOn(compression, "gzip");
    const { send, results } = setup();
    const job = workerJob();
    job.compression = "gzip";
    send(job);
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(gzip).not.toHaveBeenCalled();
  });

  it("starts no HTTP request after serialization exhausts the deadline", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    vi.spyOn(serializers, "serializerFor").mockReturnValue({
      name: "slow",
      serialize: () => {
        clock.mockReturnValue(2000);
        return { body: "body", contentType: "text/plain" };
      },
    });
    const { send, results } = setup();
    send(workerJob());
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0].result).toEqual({ failure: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts no work for a request that arrives after its deadline", async () => {
    const { send, results } = setup();
    const job = workerJob();
    job.deadlineMs = 1;
    send(job);
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0].result).toEqual({ failure: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a serializer failure without sending the batch", async () => {
    const { send, results } = setup();
    const job = workerJob();
    const resource = job.batch.records[0].resource;
    resource.cycle = resource;
    send(job);
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0].result).toEqual({ failure: "serialize" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "{bad",
    "null",
    '{"maxBytes":"bad"}',
    '{"maxBytes":-1}',
    '{"maxBytes":1e999}',
    '{"maxBytes":100}',
  ])("reads a 413 body %s", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(body, { status: 413 }))),
    );
    const { send, results } = setup();
    send();
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0].result.maxBytes).toBe(body === '{"maxBytes":100}' ? 100 : undefined);
  });

  it("reports a network rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { send, results } = setup();
    send();
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0].result).toEqual({ failure: "network" });
  });

  it("bounds an operation that never settles", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const { send, results } = setup();
    const job = workerJob();
    job.timeoutMs = 10;
    send(job);
    await vi.advanceTimersByTimeAsync(10);
    expect(results()[0].result).toEqual({ failure: "timeout" });
    release(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not fetch after cancellation during compression", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Uint8Array<ArrayBuffer> | null) => void;
    vi.spyOn(compression, "gzip").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { send, deliver, results } = setup();
    const job = workerJob();
    job.compression = "gzip";
    job.batch.records[0].body = "x".repeat(COMPRESSION_THRESHOLD_BYTES * 2);
    send(job);
    deliver(workerMessage(TRANSPORT_WORKER_TYPE.cancel, { id: 1 }));
    deliver(workerMessage(TRANSPORT_WORKER_TYPE.cancel, { id: 999 }));
    resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(results()).toEqual([]);
  });

  it("clears active fetches when the service stops", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, fail) => {
            reject = fail;
          }),
      ),
    );
    const { send, stop, results, channel } = setup();
    const listener = [...channel.port2.listeners.get("message")!][0];
    send();
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    stop();
    listener({ data: workerMessage(TRANSPORT_WORKER_TYPE.send, { id: 2, job: workerJob() }) });
    expect(signal?.aborted).toBe(true);
    reject(new Error("aborted"));
    await vi.advanceTimersByTimeAsync(0);
    expect(results()).toEqual([]);
  });

  it("refuses invalid jobs, duplicate ids and requests above the cap", async () => {
    let finish!: () => void;
    const gate = new Promise<Response>((resolve) => {
      finish = () => resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => gate),
    );
    const { send, deliver, results } = setup();
    deliver(workerMessage(TRANSPORT_WORKER_TYPE.send, { id: 100, job: null }));
    send();
    send();
    for (let id = 2; id <= TRANSPORT_WORKER_MAX_JOBS + 1; id++) {
      send(workerJob(), id);
    }
    expect(results().filter((reply) => reply.result.failure === "protocol")).toHaveLength(3);
    finish();
    await vi.waitFor(() => expect(results()).toHaveLength(TRANSPORT_WORKER_MAX_JOBS + 3));
  });

  it("ignores malformed envelopes and unknown type tags", () => {
    const { deliver } = setup();
    for (const data of [
      null,
      workerMessage(TRANSPORT_WORKER_TYPE.send, { id: "1" }),
      workerMessage(TRANSPORT_WORKER_TYPE.send, { id: 0 }),
      workerMessage(TRANSPORT_WORKER_TYPE.send, { id: 0.5 }),
      workerMessage("other", { id: 1 }),
    ]) {
      deliver(data);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

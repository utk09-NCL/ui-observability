import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TELEMETRY_SDK_VERSION, TRANSPORT_WORKER_TYPE } from "../src/constants";
import { serveTransportWorker } from "../src/index";
import { workerMessage } from "../src/transport/worker-protocol";
import * as server from "../src/transport/worker-server";
import { FakeChannel } from "./worker-fakes";

let stop: (() => void) | undefined;

beforeEach(() => {
  stop = undefined;
});

afterEach(() => {
  stop?.();
});

function connect(
  channel: FakeChannel,
  data: unknown = workerMessage(TRANSPORT_WORKER_TYPE.connect),
): void {
  dispatchEvent(
    new MessageEvent("message", { data, ports: [channel.port2 as unknown as MessagePort] }),
  );
}

describe("serveTransportWorker", () => {
  it("reports a call on the main page", () => {
    const report = vi.fn();
    serveTransportWorker({ onDiagnostic: report })();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: "config.invalid" }));
  });

  it("reports a context without message listeners", () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("addEventListener", undefined);
    const report = vi.fn();
    serveTransportWorker({ onDiagnostic: report })();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: "config.invalid" }));
  });

  it("installs one private service before its first request", async () => {
    vi.stubGlobal("document", undefined);
    stop = serveTransportWorker();
    expect(serveTransportWorker()).toBe(stop);
    const channel = new FakeChannel();
    connect(channel);
    await vi.waitFor(() =>
      expect(channel.port2.sent).toContainEqual(
        workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: true }),
      ),
    );
    const second = new FakeChannel();
    connect(second);
    expect(second.port2.sent).toContainEqual(
      workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: false }),
    );
    expect(second.port2.closed).toBe(true);
    stop();
    expect(channel.port2.closed).toBe(true);
  });

  it("ignores unrelated messages and connections without a port", () => {
    vi.stubGlobal("document", undefined);
    stop = serveTransportWorker();
    for (const data of [
      null,
      { p: "other" },
      workerMessage("other"),
      workerMessage(TRANSPORT_WORKER_TYPE.connect),
    ]) {
      dispatchEvent(new MessageEvent("message", { data }));
    }
  });

  it("keeps a restarted service active after an old stop call", () => {
    vi.stubGlobal("document", undefined);
    const first = serveTransportWorker();
    first();
    stop = serveTransportWorker();
    first();
    expect(serveTransportWorker()).toBe(stop);
  });

  it("refuses a worker from another library version", () => {
    vi.stubGlobal("document", undefined);
    stop = serveTransportWorker();
    const channel = new FakeChannel();
    connect(channel, {
      ...workerMessage(TRANSPORT_WORKER_TYPE.connect),
      v: `${TELEMETRY_SDK_VERSION}-other`,
    });
    expect(channel.port2.sent).toContainEqual(
      workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: false }),
    );
    expect(channel.port2.closed).toBe(true);
  });

  it("does not install a service after its stop during loading", async () => {
    vi.stubGlobal("document", undefined);
    stop = serveTransportWorker();
    const start = vi.spyOn(server, "serveWorkerPort");
    const channel = new FakeChannel();
    connect(channel);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(start).not.toHaveBeenCalled();
    expect(channel.port2.closed).toBe(true);
  });

  it("reports a delivery module that fails at installation", async () => {
    vi.stubGlobal("document", undefined);
    vi.spyOn(server, "serveWorkerPort").mockImplementation(() => {
      throw new Error("install");
    });
    const report = vi.fn();
    stop = serveTransportWorker({ onDiagnostic: report });
    const channel = new FakeChannel();
    connect(channel);
    await vi.waitFor(() => expect(channel.port2.closed).toBe(true));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: "transport.http_error" }));
  });
});

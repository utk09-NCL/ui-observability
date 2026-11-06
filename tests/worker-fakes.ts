import { vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import type { WorkerJob } from "../src/transport/worker-protocol";
import { serveWorkerPort } from "../src/transport/worker-server";

/** Ordered message ports with structured cloning. Both ends run their real protocol handlers. */
export class FakePort {
  peer!: FakePort;
  closed = false;
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: unknown[] = [];

  postMessage = vi.fn((value: unknown): void => {
    if (this.closed) {
      throw new Error("closed port");
    }
    const data: unknown = structuredClone(value);
    this.sent.push(data);
    queueMicrotask(() => {
      if (!this.peer.closed) {
        this.peer.emit("message", { data });
      }
    });
  });

  start = vi.fn();
  close = vi.fn(() => {
    this.closed = true;
  });

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export class FakeChannel {
  static created: FakeChannel[] = [];
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
    FakeChannel.created.push(this);
  }
}

/** Dedicated worker stand-in. A test can replace its connect handler or emit an error. */
export class FakeWorker extends EventTarget {
  private stop: (() => void) | undefined;
  port: FakePort | undefined;
  connect: ((data: unknown, port: FakePort) => void) | undefined;
  readonly diagnostics = new Diagnostics(vi.fn(), 0);

  postMessage = vi.fn((data: unknown, transfer: Transferable[]): void => {
    const port = transfer[0] as unknown as FakePort;
    this.port = port;
    if (this.connect) {
      this.connect(data, port);
    } else {
      this.stop = serveWorkerPort(port as unknown as MessagePort, this.diagnostics);
    }
  });

  terminate = vi.fn(() => {
    this.stop?.();
    this.port?.close();
  });
}

export function workerJob(): WorkerJob {
  return {
    batch: {
      id: "batch",
      createdAt: 0,
      attempts: 0,
      records: [
        {
          timeUnixNano: "1000000",
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
          severityNumber: 9,
          severityText: "INFO",
          body: "record",
          attributes: {},
          resource: {},
        },
      ],
    },
    kind: "logs",
    endpoint: "https://ingest.example/logs",
    serializer: "otlp",
    headers: {},
    compression: "none",
    credentials: "omit",
    priority: "low",
    timeoutMs: 1000,
    deadlineMs: Date.now() + 1000,
  };
}

export function stubWorkerChannel(): void {
  FakeChannel.created = [];
  vi.stubGlobal("MessageChannel", FakeChannel);
}

// tests/memory-transport.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configure,
  createMemoryTransport,
  flush,
  getDiagnosticCounters,
  getLogger,
  shutdown,
} from "../src/index";
import type { TransportRequest } from "../src/models/config";

/**
 * Builds a transport request with one record.
 * @param body Body of the record.
 * @returns The request.
 */
const request = (body: string): TransportRequest => ({
  body: "{}",
  contentType: "application/json",
  batchId: `batch-${body}`,
  attempt: 0,
  records: [
    {
      timeUnixNano: "1755543600123000000",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
      severityNumber: 9,
      severityText: "INFO",
      body,
      attributes: {},
      resource: {},
    },
  ],
});

afterEach(async () => {
  await shutdown();
  vi.unstubAllGlobals();
});

describe("createMemoryTransport", () => {
  it("accepts each batch with 200 and keeps its records", async () => {
    const memory = createMemoryTransport();

    await expect(memory.transport(request("one"))).resolves.toEqual({ status: 200 });
    await memory.transport(request("two"));

    expect(memory.records().map((record) => record.body)).toEqual(["one", "two"]);
    expect(memory.batches()).toHaveLength(2);
  });

  it("answers with the status that respondWith sets, and keeps no record it refused", async () => {
    const memory = createMemoryTransport();

    memory.respondWith(429, 1000);
    const answer = await memory.transport(request("throttled"));

    expect(answer).toEqual({ status: 429, retryAfterMs: 1000 });
    expect(memory.batches()).toHaveLength(1);
    expect(memory.records()).toEqual([]);
  });

  it("answers with a status and no delay when respondWith gets no delay", async () => {
    const memory = createMemoryTransport();

    memory.respondWith(500);

    await expect(memory.transport(request("failed"))).resolves.toEqual({ status: 500 });
  });

  it("forgets every batch on clear", async () => {
    const memory = createMemoryTransport();
    await memory.transport(request("one"));

    memory.clear();

    expect(memory.batches()).toEqual([]);
    expect(memory.records()).toEqual([]);
  });
});

describe("createMemoryTransport through the public API", () => {
  it("receives a record that a test logs and flushes, with no endpoint and no fetch", async () => {
    // This is the pattern from the README. It uses the public API only.
    vi.stubGlobal("fetch", vi.fn());
    const memory = createMemoryTransport();
    configure({
      serviceName: "orders",
      transport: memory.transport,
      storage: "none",
      bus: { mode: "off" },
      identity: "memory",
    });

    getLogger("orders.ticket").logAction("ORDER_SUBMIT", { orderId: "ORD-1" });
    await flush();

    expect(memory.records()).toContainEqual(
      expect.objectContaining({
        body: "ORDER_SUBMIT",
        attributes: expect.objectContaining({ orderId: "ORD-1" }) as unknown,
      }),
    );
    expect(getDiagnosticCounters()["config.invalid"]).toBeUndefined();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

// tests/delivery-health.test.ts
//
// getHealth().delivery holds the delivery counts, the send and failure times, the throttle end
// and the losses. A rotation resets the failures and the throttle and keeps the rest, and the
// next configure() after shutdown() starts at zero.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configure,
  createMemoryTransport,
  flush,
  getHealth,
  info,
  rotateSecurityContext,
  shutdown,
} from "../src/index";

/** Settings that keep a test away from storage, captures and the bus. */
const quiet = {
  serviceName: "health",
  storage: { backend: "memory" as const },
  capture: { errors: false, rejections: false },
  bus: { mode: "off" as const },
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Waits for every chunk load, the startup and one timer turn. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("getHealth().delivery", () => {
  it("counts the losses for each reason, also without an onDrop hook", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport });
    await settle();
    memory.respondWith(400);
    info("refused");
    info("refused too");
    await flush();

    expect((await getHealth()).delivery.dropped).toEqual({ rejected: 2 });
  });

  it("keeps the last send and the losses across a rotation, and resets the failures", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport, securityContext: { id: "A" } });
    await settle();
    info("accepted");
    await flush();
    const { lastSendAt } = (await getHealth()).delivery;
    expect(lastSendAt).not.toBeNull();

    memory.respondWith(429, 30_000);
    const before = Date.now();
    info("throttled");
    await flush();
    const throttled = (await getHealth()).delivery;
    expect(throttled).toMatchObject({ consecutiveFailures: 1, lastSendAt, stored: 1 });
    expect(throttled.lastFailureAt).toBeGreaterThanOrEqual(before);
    expect(throttled.throttledUntil).toBeGreaterThanOrEqual(before + 29_000);

    await rotateSecurityContext({ id: "B", routing: { transport: memory.transport } });

    expect((await getHealth()).delivery).toEqual({
      pending: 0,
      inFlight: 0,
      stored: 0,
      lastSendAt,
      lastFailureAt: null,
      consecutiveFailures: 0,
      throttledUntil: null,
      dropped: { security_context: 1 },
    });
  });

  it("starts at zero after shutdown() and the next configure()", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport });
    await settle();
    info("accepted");
    await flush();
    await shutdown({ pending: "discard" });

    configure({ ...quiet, transport: memory.transport });
    await settle();

    expect((await getHealth()).delivery).toEqual({
      pending: 0,
      inFlight: 0,
      stored: 0,
      lastSendAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      throttledUntil: null,
      dropped: {},
    });
  });

  it("holds numbers and times only, so no server text or URL reaches it", async () => {
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      headers: { authorization: "Bearer secret" },
    });
    await settle();
    memory.respondWith(500);
    info("failed");
    await flush();

    const { dropped, ...rest } = (await getHealth()).delivery;
    const kinds = Object.values(rest).map((value) => (value === null ? "null" : typeof value));
    expect(new Set(kinds)).toEqual(new Set(["number", "null"]));
    expect(Object.values(dropped).every((count) => typeof count === "number")).toBe(true);
  });
});

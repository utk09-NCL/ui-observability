// tests/rotation-safety.test.ts
//
// A security-context rotation runs at logout or at a tenant change. These tests check that no
// record leaves with the old context's settings after the app asked to leave it, also when a
// rotation fails, overlaps another one or races the delivery stack load.

import { describe, expect, it, vi } from "vitest";
import { ObservabilityRuntime } from "../src/core/runtime";
import { Sender } from "../src/core/sender";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import {
  configure,
  createMemoryTransport,
  flush,
  getHealth,
  getLogger,
  rotateSecurityContext,
  shutdown,
} from "../src/index";

/** A runtime config with fast retries, no captures and no bus. */
const base = {
  serviceName: "rotation",
  identity: "memory",
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
  delivery: { retryIdleDelayMs: 20, retryBaseDelayMs: 20 },
} as const;

const rt = (): ObservabilityRuntime => ObservabilityRuntime.current()!;

/** Waits on real timers, so the retry engine gets time to run. */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Leaves one batch of context A in localStorage, from a page whose send failed. */
async function storeOldBatch(isolation = true): Promise<void> {
  const failing = createMemoryTransport();
  failing.respondWith(500);
  configure({
    ...base,
    storage: "localstorage",
    transport: failing.transport,
    securityContext: { id: "A", isolation },
  });
  getLogger("pay").info("user A secret");
  await flush();
  await shutdown();
}

/** Checks whether localStorage still holds the old record. */
const secretAtRest = (): boolean =>
  Object.keys(localStorage).some((key) =>
    (localStorage.getItem(key) ?? "").includes("user A secret"),
  );

describe("a rotation that fails while the delivery stack loads", () => {
  it("sends nothing after the rejection, and the health shows no ready sender", async () => {
    await storeOldBatch();
    const next = createMemoryTransport();
    configure({
      ...base,
      storage: "localstorage",
      transport: next.transport,
      securityContext: { id: "A" },
    });

    // The delivery stack is still loading, and the pending rule is a typo.
    await expect(
      rotateSecurityContext({ id: "B", delivery: {} }, { pending: "flsh" as never }),
    ).rejects.toThrow("Invalid security-context rotation options");
    const sentAtRejection = next.records().length;
    await wait(200);
    getLogger("pay").info("new record after the rejection");
    await flush();

    expect(next.records()).toHaveLength(sentAtRejection);
    expect(await getHealth()).toMatchObject({
      status: "degraded",
      senderReady: false,
      issues: ["security.rotation_failed"],
    });
  });
});

describe.each([true, false])(
  "a failed rotation, then a good one, with isolation %s",
  (isolation) => {
    it("applies the good rotation's discard rule to the stored batches of the closed context", async () => {
      await storeOldBatch(isolation);
      const failing = createMemoryTransport();
      failing.respondWith(500);
      const next = createMemoryTransport();
      const onDrop = vi.fn<(summary: DropSummary) => void>();
      configure({
        ...base,
        storage: "localstorage",
        transport: failing.transport,
        onDrop,
        securityContext: { id: "A", isolation },
      });
      await flush();

      await expect(
        rotateSecurityContext({ id: "B", delivery: { credentials: "bogus" as never } }),
      ).rejects.toThrow("Invalid delivery settings");
      await rotateSecurityContext({ id: "C", delivery: { transport: next.transport } });
      await wait(200);
      await flush();

      // The old user's record neither stays on the device nor goes to the next context.
      expect(next.records().map((record) => record.body)).not.toContain("user A secret");
      expect(secretAtRest()).toBe(false);
      expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ reason: "security_context" }));
    });
  },
);

describe("overlapping rotations", () => {
  it("runs a second rotation after the first one, in call order", async () => {
    const tenant = createMemoryTransport();
    configure({
      ...base,
      storage: "memory",
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
    });
    await flush();

    const login = rotateSecurityContext({ id: "B", delivery: { transport: tenant.transport } });
    const logout = rotateSecurityContext({ id: "anon", delivery: {} });
    await login;
    await logout;
    getLogger("pay").info("after the logout");
    await flush();

    expect(rt().config.securityContext.id).toBe("anon");
    expect(tenant.records().map((record) => record.body)).not.toContain("after the logout");
  });

  it("sends nothing to the first new context while a later rotation waits behind its carry", async () => {
    const tenantB = createMemoryTransport();
    const tenantC = createMemoryTransport();
    configure({
      ...base,
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
    });
    await flush();
    const adopt = Sender.prototype.adopt;
    // The log call lands while B's carry still stores the old batches and C's switch waits.
    vi.spyOn(Sender.prototype, "adopt").mockImplementation(async function (
      this: Sender,
      ...args: Parameters<Sender["adopt"]>
    ) {
      getLogger("app").info("user C data");
      await wait(30);
      return adopt.apply(this, args);
    });

    const login = rotateSecurityContext(
      { id: "B", delivery: { transport: tenantB.transport } },
      { pending: "carry" },
    );
    const switchUser = rotateSecurityContext(
      { id: "C", delivery: { transport: tenantC.transport } },
      { pending: "flush" },
    );
    await login;
    await switchUser;
    await flush();

    expect(tenantB.records().map((record) => record.body)).not.toContain("user C data");
  });
});

/** Builds a record the way the builder would, for the paths that take a built record. */
const built = (body: string): LogRecord => ({
  timeUnixNano: "1",
  traceId: "0".repeat(32),
  spanId: "0".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes: { "log.type": "log", "app.namespace": "rotation" },
  resource: {},
});

/** Sums the records of each onDrop summary with one reason. */
const lost = (onDrop: ReturnType<typeof vi.fn>, reason: string): number =>
  (onDrop.mock.calls as [DropSummary][])
    .filter(([summary]) => summary.reason === reason)
    .reduce((sum, [summary]) => sum + summary.records, 0);

describe("records built during a rotation that succeeds", () => {
  it("reports each one with security_context", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({
      ...base,
      storage: "memory",
      transport: createMemoryTransport().transport,
      onDrop,
      securityContext: { id: "A" },
    });
    await flush();

    const rotating = rotateSecurityContext({
      id: "B",
      delivery: { transport: createMemoryTransport().transport },
    });
    for (let i = 0; i < 3; i++) {
      rt().emit(built(`point ${String(i)}`));
    }
    await rotating;
    await flush();

    expect(lost(onDrop, "security_context")).toBe(3);
  });
});

describe("a rotation in a forwarder", () => {
  it("rejects as a usage error and leaves the delivery open", async () => {
    configure({ ...base, storage: "memory", endpoint: null, securityContext: { id: "A" } });
    await flush();
    Object.assign(rt(), { role: () => "forwarder" });

    await expect(rotateSecurityContext({ id: "B", delivery: {} })).rejects.toThrow(
      "upstream owner",
    );

    expect(rt()["deliveryClosed"]).toBe(false);
    expect((await getHealth()).issues).not.toContain("security.rotation_failed");
  });
});

describe("queued rotations", () => {
  it("runs a queued rotation after an earlier one rejects, and opens the delivery again", async () => {
    const next = createMemoryTransport();
    configure({
      ...base,
      storage: "memory",
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
    });
    await flush();

    const failing = rotateSecurityContext({
      id: "B",
      delivery: { credentials: "bogus" as never },
    });
    const good = rotateSecurityContext({ id: "C", delivery: { transport: next.transport } });
    await expect(failing).rejects.toThrow("Invalid delivery settings");
    await good;
    getLogger("pay").info("in C");
    await flush();

    expect(next.records().map((record) => record.body)).toEqual(["in C"]);
  });

  it("rejects a queued rotation that starts after shutdown()", async () => {
    configure({ ...base, storage: "memory", endpoint: null, securityContext: { id: "A" } });
    await flush();

    const first = rotateSecurityContext({ id: "B", delivery: {} });
    const second = rotateSecurityContext({ id: "C", delivery: {} });
    const closing = shutdown();

    await expect(second).rejects.toThrow("The runtime has stopped.");
    await first.catch(() => undefined);
    await closing;
  });
});

describe("a closed context and the next rotation's flush rule", () => {
  it("removes the closed context's records as discard does, because flush would use the old settings", async () => {
    const failing = createMemoryTransport();
    failing.respondWith(500);
    const next = createMemoryTransport();
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({
      ...base,
      storage: "memory",
      transport: failing.transport,
      onDrop,
      securityContext: { id: "A" },
    });
    getLogger("pay").info("user A secret");
    await flush();

    await expect(
      rotateSecurityContext({ id: "B", delivery: { credentials: "bogus" as never } }),
    ).rejects.toThrow();
    failing.respondWith(200);
    await rotateSecurityContext(
      { id: "C", delivery: { transport: next.transport } },
      { pending: "flush" },
    );
    await flush();

    expect([...failing.records(), ...next.records()].map((record) => record.body)).not.toContain(
      "user A secret",
    );
    expect(lost(onDrop, "security_context")).toBeGreaterThan(0);
  });
});

describe("a delivery stack load that ends after the context closed", () => {
  it("parks its sender instead of sending, and retires a second late one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = Sender.create.bind(Sender);
    vi.spyOn(Sender, "create").mockImplementation(async (deps) => {
      await gate;
      return original(deps);
    });
    const retire = vi.spyOn(Sender.prototype, "retire");
    configure({
      ...base,
      storage: "memory",
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
    });
    // A failed rotation closed the context while this load ran.
    Object.assign(rt(), { deliveryClosed: true });
    release();
    await rt()["senderLoad"];

    expect(rt()["sender"]).toBeUndefined();
    expect(rt()["parkedSender"]).toBeDefined();

    rt()["senderLoad"] = undefined;
    await rt()["loadSender"]();

    expect(rt()["sender"]).toBeUndefined();
    expect(retire).toHaveBeenCalledWith("retain", 0, "A");
  });
});

describe("a rotation to an endpoint that isn't a plain absolute URL", () => {
  it("applies a relative endpoint in its absolute form", async () => {
    configure({ ...base, storage: "memory", endpoint: null, securityContext: { id: "A" } });
    await flush();

    await rotateSecurityContext({ id: "B", delivery: { endpoint: "/v1/logs" } });

    expect(rt().config.endpoint).toBe(new URL("/v1/logs", document.baseURI).href);
  });

  it.each([["https://user:pw@ingest.example/v1/logs"], ["   "]])(
    "rejects %j and closes the delivery",
    async (endpoint) => {
      configure({ ...base, storage: "memory", endpoint: null, securityContext: { id: "A" } });
      await flush();

      await expect(rotateSecurityContext({ id: "B", delivery: { endpoint } })).rejects.toThrow(
        "Invalid delivery settings",
      );

      expect((await getHealth()).issues).toEqual(["security.rotation_failed"]);
    },
  );
});

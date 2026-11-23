// tests/rotation-safety.test.ts
//
// A security-context rotation runs at logout or at a tenant change. These tests check that no
// record leaves with the old context's settings after the app asked to leave it, also when a
// rotation fails, overlaps another one or races the delivery stack load.

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import { Sender } from "../src/core/sender";
import type { LogBatch } from "../src/models/batch";
import type { DropSummary } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { saveToEmergencyQueue } from "../src/storage/emergency-queue";
import {
  configure,
  createMemoryTransport,
  flush,
  getHealth,
  getLogger,
  rotateSecurityContext,
  shutdown,
} from "../src/index";

// The retry engine's idle wait is a constant. A short one lets a stored batch drain in a test.
vi.mock("../src/constants", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RETRY_IDLE_DELAY_MS: 20,
}));

/** A runtime config with fast retries, no captures and no bus. */
const base = {
  serviceName: "rotation",
  identity: "memory",
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
  delivery: { retryBaseDelayMs: 20 },
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
    storage: { backend: "localstorage" },
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
      storage: { backend: "localstorage" },
      transport: next.transport,
      securityContext: { id: "A" },
    });

    // The delivery stack is still loading, and the pending rule is a typo.
    await expect(
      rotateSecurityContext({ id: "B", routing: {} }, { pending: "flsh" as never }),
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
        storage: { backend: "localstorage" },
        transport: failing.transport,
        onDrop,
        securityContext: { id: "A", isolation },
      });
      await flush();

      await expect(
        rotateSecurityContext({ id: "B", routing: { credentials: "bogus" as never } }),
      ).rejects.toThrow("Invalid routing settings");
      await rotateSecurityContext({ id: "C", routing: { transport: next.transport } });
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
      storage: { backend: "memory" },
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
    });
    await flush();

    const login = rotateSecurityContext({ id: "B", routing: { transport: tenant.transport } });
    const logout = rotateSecurityContext({ id: "anon", routing: {} });
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
      { id: "B", routing: { transport: tenantB.transport } },
      { pending: "carry" },
    );
    const switchUser = rotateSecurityContext(
      { id: "C", routing: { transport: tenantC.transport } },
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
      storage: { backend: "memory" },
      transport: createMemoryTransport().transport,
      onDrop,
      securityContext: { id: "A" },
    });
    await flush();

    const rotating = rotateSecurityContext({
      id: "B",
      routing: { transport: createMemoryTransport().transport },
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
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      securityContext: { id: "A" },
    });
    await flush();
    Object.assign(rt(), { role: () => "forwarder" });

    await expect(rotateSecurityContext({ id: "B", routing: {} })).rejects.toThrow("upstream owner");

    expect((await getHealth()).issues).not.toContain("security.rotation_failed");
  });

  it("reports a record built during the rejected call to onDrop", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      onDrop,
      securityContext: { id: "A" },
    });
    await flush();
    Object.assign(rt(), { role: () => "forwarder" });

    const rotation = rotateSecurityContext({ id: "B", routing: {} });
    rt().emit(built("built during the call"));
    await expect(rotation).rejects.toThrow("upstream owner");
    await flush();

    expect(lost(onDrop, "security_context")).toBe(1);
  });
});

describe("the stored count after a failed rotation", () => {
  it("still counts the closed context's stored batches", async () => {
    const failing = createMemoryTransport();
    failing.respondWith(500);
    configure({
      ...base,
      storage: { backend: "memory" },
      transport: failing.transport,
      securityContext: { id: "A" },
    });
    getLogger("pay").info("user A");
    await flush();
    const before = (await getHealth()).delivery.stored;

    await expect(
      rotateSecurityContext({ id: "B", routing: { credentials: "bogus" as never } }),
    ).rejects.toThrow();

    expect(before).toBe(1);
    expect((await getHealth()).delivery.stored).toBe(1);
  });
});

describe("the rotation context", () => {
  it("rejects a context that isn't an object, and takes null as no context", async () => {
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      securityContext: { id: "A" },
    });
    await flush();

    await expect(
      rotateSecurityContext({ id: "B", routing: {}, context: "tenant" as never }),
    ).rejects.toThrow("Invalid security-context rotation options.");
    await expect(
      rotateSecurityContext({ id: "C", routing: {}, context: null as never }),
    ).resolves.toBeUndefined();
  });
});

describe("the rotation timeoutMs", () => {
  it.each([-1, 600_001, 2 ** 31])("rejects %s as an invalid option", async (timeoutMs) => {
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      securityContext: { id: "A" },
    });
    await flush();

    await expect(rotateSecurityContext({ id: "B", routing: {} }, { timeoutMs })).rejects.toThrow(
      "Invalid security-context rotation options.",
    );
  });

  it("accepts 0 and 600000", async () => {
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      securityContext: { id: "A" },
    });
    await flush();

    await rotateSecurityContext({ id: "B", routing: {} }, { timeoutMs: 0 });
    await rotateSecurityContext({ id: "C", routing: {} }, { timeoutMs: 600_000 });

    expect(rt().config.securityContext.id).toBe("C");
  });
});

describe("queued rotations", () => {
  it("runs a queued rotation after an earlier one rejects, and opens the delivery again", async () => {
    const next = createMemoryTransport();
    configure({
      ...base,
      storage: { backend: "memory" },
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
    });
    await flush();

    const failing = rotateSecurityContext({
      id: "B",
      routing: { credentials: "bogus" as never },
    });
    const good = rotateSecurityContext({ id: "C", routing: { transport: next.transport } });
    await expect(failing).rejects.toThrow("Invalid routing settings");
    await good;
    getLogger("pay").info("in C");
    await flush();

    expect(next.records().map((record) => record.body)).toEqual(["in C"]);
  });

  it("rejects a queued rotation that starts after shutdown()", async () => {
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      securityContext: { id: "A" },
    });
    await flush();

    const first = rotateSecurityContext({ id: "B", routing: {} });
    const second = rotateSecurityContext({ id: "C", routing: {} });
    const closing = shutdown();

    await expect(second).rejects.toThrow("The runtime has stopped.");
    await first.catch(() => undefined);
    await closing;
  });
});

describe("a shutdown while the rotation code loads", () => {
  it("rejects the rotation and keeps the stored batch", async () => {
    let loading = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.doMock("../src/core/rotation", async (importOriginal) => {
      loading = true;
      await gate;
      return importOriginal();
    });
    onTestFinished(() => {
      vi.doUnmock("../src/core/rotation");
    });
    await storeOldBatch();
    const failing = createMemoryTransport();
    failing.respondWith(500);
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({
      ...base,
      storage: { backend: "localstorage" },
      transport: failing.transport,
      onDrop,
      securityContext: { id: "A" },
    });
    await flush();

    const rotation = rotateSecurityContext(
      { id: "B", routing: { transport: createMemoryTransport().transport } },
      { pending: "discard" },
    );
    await vi.waitFor(() => {
      expect(loading).toBe(true);
    });
    const closing = shutdown();
    release();

    await expect(rotation).rejects.toThrow("The runtime has stopped.");
    await closing;
    expect(secretAtRest()).toBe(true);
    expect(lost(onDrop, "security_context")).toBe(0);
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
      storage: { backend: "memory" },
      transport: failing.transport,
      onDrop,
      securityContext: { id: "A" },
    });
    getLogger("pay").info("user A secret");
    await flush();

    await expect(
      rotateSecurityContext({ id: "B", routing: { credentials: "bogus" as never } }),
    ).rejects.toThrow();
    failing.respondWith(200);
    await rotateSecurityContext(
      { id: "C", routing: { transport: next.transport } },
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
  it("parks its sender instead of sending, and the next rotation retires it", async () => {
    vi.doMock("../src/core/rotation", () => {
      throw new Error("The rotation chunk did not load.");
    });
    onTestFinished(() => {
      vi.doUnmock("../src/core/rotation");
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = Sender.create.bind(Sender);
    const old = createMemoryTransport();
    const next = createMemoryTransport();
    const codes: string[] = [];
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      securityContext: { id: "A", isolation: false },
      onDiagnostic: (event) => {
        codes.push(event.code);
      },
    });
    await flush();
    vi.spyOn(Sender, "create").mockImplementation(async (deps) => {
      await gate;
      return original(deps);
    });
    // This load runs while the rotation fails, so the closed context's sender comes late.
    configure({ transport: old.transport });
    const failed = rotateSecurityContext({ id: "B", routing: { transport: next.transport } });
    getLogger("pay").info("user A");
    // The failed rotation closes the context, then waits for this load.
    await vi.waitFor(() => {
      expect(codes).toContain("security.rotation_failed");
    });
    release();
    await expect(failed).rejects.toThrow();
    await flush();

    expect(old.batches()).toEqual([]);
    expect(await getHealth()).toMatchObject({
      senderReady: false,
      issues: ["security.rotation_failed"],
    });

    vi.doUnmock("../src/core/rotation");
    const retire = vi.spyOn(Sender.prototype, "retire");
    await rotateSecurityContext({ id: "C", routing: { transport: next.transport } });

    expect(retire).toHaveBeenCalledWith("discard", 5000, "A");
    expect(old.batches()).toEqual([]);
  });
});

describe("a rotation to an endpoint that isn't a plain absolute URL", () => {
  it("applies a relative endpoint in its absolute form", async () => {
    configure({
      ...base,
      storage: { backend: "memory" },
      endpoint: null,
      securityContext: { id: "A" },
    });
    await flush();

    await rotateSecurityContext({ id: "B", routing: { endpoint: "/v1/logs" } });

    expect(rt().config.endpoint).toBe(new URL("/v1/logs", document.baseURI).href);
  });

  it.each([["https://user:pw@ingest.example/v1/logs"], ["   "]])(
    "rejects %j and closes the delivery",
    async (endpoint) => {
      configure({
        ...base,
        storage: { backend: "memory" },
        endpoint: null,
        securityContext: { id: "A" },
      });
      await flush();

      await expect(rotateSecurityContext({ id: "B", routing: { endpoint } })).rejects.toThrow(
        "Invalid routing settings",
      );

      expect((await getHealth()).issues).toEqual(["security.rotation_failed"]);
    },
  );
});

describe("a hidden page's keepalive request when a rotation retires the sender", () => {
  const endpoint = "https://ingest.example/v1/logs";

  /** Ends the requests that a test left open, so the teardown flush doesn't wait for them. */
  const open: (() => void)[] = [];

  afterEach(() => {
    for (const end of open.splice(0)) {
      end();
    }
  });

  /** Holds the first request until its signal aborts. Every later request gets a 204. */
  function holdFirstRequest(): ReturnType<typeof vi.fn<typeof fetch>> {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      calls++;
      if (calls > 1) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      return new Promise<Response>((resolve, reject) => {
        open.push(() => {
          resolve(new Response(null, { status: 204 }));
        });
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
  }

  /**
   * Leaves one request open. A hidden page sends it with keepalive, a visible one without.
   * @param hidden True for a hidden page.
   * @returns The onDrop spy of the runtime.
   */
  async function openRequest(hidden: boolean): Promise<ReturnType<typeof vi.fn>> {
    const fetchMock = holdFirstRequest();
    if (hidden) {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    }
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({
      ...base,
      endpoint,
      storage: { backend: "localstorage" },
      securityContext: { id: "A", isolation: true },
      onDrop,
    });
    await vi.dynamicImportSettled();
    await flush();

    getLogger("pay").info("user A secret");
    const sent = await flush({ timeoutMs: 50 });

    // The setup is right only if the request is open, and only a hidden page used keepalive.
    expect(sent.pending).toBe(1);
    expect(fetchMock.mock.calls[0][1]?.keepalive).toBe(hidden);

    return onDrop;
  }

  const pages = [
    ["visible", false],
    ["hidden", true],
  ] as const;

  it.each(pages)(
    "keeps the record in storage under the old context with retain (%s page)",
    async (_page, hidden) => {
      const onDrop = await openRequest(hidden);

      await rotateSecurityContext({ id: "B", routing: { endpoint } }, { pending: "retain" });
      await flush();

      expect(secretAtRest()).toBe(true);
      expect(lost(onDrop, "security_context")).toBe(0);
    },
  );

  it.each(pages)(
    "sends the record to the new context with carry (%s page)",
    async (_page, hidden) => {
      await openRequest(hidden);
      const next = createMemoryTransport();

      await rotateSecurityContext(
        { id: "B", routing: { transport: next.transport } },
        { pending: "carry" },
      );
      await flush();

      expect(next.records().map((record) => record.body)).toContain("user A secret");
    },
  );

  it.each(pages)(
    "reports the record with security_context at a discard rotation (%s page)",
    async (_page, hidden) => {
      const onDrop = await openRequest(hidden);

      await rotateSecurityContext({ id: "B", routing: { endpoint } }, { pending: "discard" });
      await flush();

      expect(lost(onDrop, "security_context")).toBe(1);
      expect(secretAtRest()).toBe(false);
    },
  );

  it.each(pages)(
    "keeps the record in storage when the rotation fails (%s page)",
    async (_page, hidden) => {
      const onDrop = await openRequest(hidden);

      await expect(
        rotateSecurityContext({ id: "B", routing: { credentials: "bogus" as never } }),
      ).rejects.toThrow("Invalid routing settings");
      await flush();

      expect(secretAtRest()).toBe(true);
      expect(lost(onDrop, "security_context")).toBe(0);
    },
  );
});

describe("the emergency entries of the old context at a discard rotation", () => {
  /** Lists the keys of the emergency queue in localStorage. */
  const emergencyKeys = (): string[] =>
    Object.keys(localStorage).filter((key) => key.startsWith("ui-observability.emergency."));

  it("reports the records of an entry that another tab parked, and removes the entry", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({
      ...base,
      storage: { backend: "localstorage" },
      transport: createMemoryTransport().transport,
      securityContext: { id: "A", isolation: true },
      onDrop,
    });
    await vi.dynamicImportSettled();
    await flush();
    await wait(0);

    // A second tab with the same stable id parks its exit batch after this tab's startup import.
    const parked: LogBatch = {
      id: "other-tab",
      createdAt: Date.now(),
      attempts: 0,
      routingContextId: "A",
      persistenceNamespace: "",
      records: [built("parked by another tab")],
    };
    saveToEmergencyQueue(parked, new Diagnostics(vi.fn(), 0));
    expect(emergencyKeys()).toHaveLength(1);

    await rotateSecurityContext(
      { id: "B", routing: { transport: createMemoryTransport().transport } },
      { pending: "discard" },
    );
    await flush();

    expect(emergencyKeys()).toEqual([]);
    expect(lost(onDrop, "security_context")).toBe(1);
  });
});

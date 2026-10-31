import type { Sender as SenderInstance } from "../src/core/sender";
import { describe, expect, it, vi } from "vitest";
import { validMessage } from "../src/bus/validation";
import { ContextStorage } from "../src/storage/context-storage";
import { LocalStorageStorage } from "../src/storage/local-storage";
import { MemoryStorage } from "../src/storage/memory-storage";
import { createChildrenLink } from "../src/bus/links";
import { BATCH_KEY_TIME_WIDTH, BATCH_STORAGE_KEY_PREFIX, SESSION_ID_KEY } from "../src/constants";
import {
  clearEmergencyContext,
  drainEmergencyQueue,
  saveToEmergencyQueue,
} from "../src/storage/emergency-queue";
import {
  configure,
  flush,
  getHealth,
  getLogger,
  registerFrame,
  rotateSecurityContext,
  shutdown,
  createMemoryTransport,
  registerWorker,
  counter,
  addBreadcrumb,
} from "../src/index";
import { ObservabilityRuntime } from "../src/core/runtime";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { NetworkCapture } from "../src/capture/network";
import { Bus } from "../src/bus/bus";
import type { BusMessage, MessageSource } from "../src/models/bus";
import type { LogRecord } from "../src/models/log-record";
import type { LogBatch } from "../src/models/batch";

const record = (): LogRecord => ({
  timeUnixNano: "123",
  traceId: "",
  spanId: "",
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "x",
  attributes: {},
  resource: {},
});
const batch = (id: string): LogBatch => ({
  id,
  records: [record()],
  createdAt: Date.now(),
  attempts: 0,
  routingContextId: id,
});
const diag = (): Diagnostics => new Diagnostics(vi.fn(), 0);
const memory = () => new MemoryStorage({ maxBatches: 500, maxAgeMs: 60000, maxAttempts: 5 });
const base = {
  endpoint: null,
  serviceName: "policies",
  storage: "memory",
  identity: "memory",
  capture: { errors: false, rejections: false },
  bus: { mode: "off" },
} as const;
const rt = (): ObservabilityRuntime => ObservabilityRuntime.current()!;

describe("strict wire schema", () => {
  it.each([
    { t: "hello", tabId: "tab" },
    { t: "tab", tabId: "tab" },
    { t: "welcome", to: "child", tabId: "tab" },
    { t: "welcome", to: "child", tabId: "tab", routingContextId: "A" },
    { t: "journey?" },
    { t: "sampling?" },
    { t: "journey", journey: null },
    { t: "journey", to: "child", journey: {} },
    { t: "sampling", to: "child", rules: null },
    { t: "security-context", id: "B" },
    { t: "records", records: [record()] },
    {
      t: "records",
      records: [
        {
          ...record(),
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          observedTimeUnixNano: "456",
        },
      ],
      routingContextId: "A",
    },
  ])("accepts a correctly shaped $t message", (message) => {
    expect(validMessage({ ...message, from: "peer" })).toBe(true);
  });

  it.each([
    null,
    1,
    {},
    { from: "", t: "hello" },
    { from: 1, t: "hello" },
    { from: "peer", t: 1 },
    { t: "hello" },
    { t: "unknown" },
    { t: "welcome", to: 1, tabId: "tab" },
    { t: "welcome", to: "child" },
    { t: "welcome", to: "child", tabId: "tab", routingContextId: 1 },
    { t: "journey", to: 1, journey: null },
    { t: "journey" },
    { t: "sampling", to: "child" },
    { t: "sampling", to: 1, rules: {} },
    { t: "security-context", id: "" },
    { t: "security-context", id: 1 },
    { t: "records", records: {} },
    { t: "records", records: [], routingContextId: 1 },
  ])("rejects malformed protocol input %#", (message) => {
    const candidate =
      typeof message === "object" && message ? { from: "peer", ...message } : message;
    expect(validMessage(candidate)).toBe(false);
  });

  it.each([
    {},
    { severityText: "UNKNOWN" },
    { attributes: [] },
    { resource: [] },
    { timeUnixNano: "NaN" },
    { observedTimeUnixNano: "bad" },
    { traceId: undefined },
    { traceId: "wrong" },
    { spanId: undefined },
    { spanId: "wrong" },
    { traceFlags: 1.5 },
    { traceFlags: -1 },
    { traceFlags: 256 },
    { severityNumber: 100 },
  ])("rejects malformed forwarded record %#", (over) => {
    const r = Object.keys(over).length ? { ...record(), ...over } : null;
    expect(validMessage({ t: "records", from: "peer", records: [r] })).toBe(false);
  });
});

describe("partition persistence", () => {
  it("never saves foreign batches, delegates retry/prune, and permits an explicit isolation opt-out", async () => {
    const backing = memory();
    const policy = { id: "A", isolation: true };
    const storage = new ContextStorage(backing, policy);
    await storage.save(batch("B"));
    expect(await backing.count()).toBe(0);
    await storage.save(batch("A"));
    await storage.bumpAttempts("A", 2);
    expect((await storage.take(1))[0].attempts).toBe(2);
    await storage.prune();
    await backing.save(batch("B"));
    policy.isolation = false;
    expect(await storage.count()).toBe(2);
    policy.isolation = true;
    await storage.remove("A");
    expect(await storage.count()).toBe(0);
    await storage.retire(false);
    await storage.save(batch("A"));
    expect(await backing.count()).toBe(1);
  });

  it("removes a slow save that finishes after its context was discarded", async () => {
    const backing = memory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = backing.save.bind(backing);
    vi.spyOn(backing, "save").mockImplementation(async (batch) => {
      await gate;
      await save(batch);
    });
    const storage = new ContextStorage(backing, { id: "A", isolation: true });
    const saving = storage.save(batch("A"));
    await storage.retire(true);
    release();
    await saving;
    expect(await backing.count()).toBe(0);
  });

  it("imports and clears emergency entries only for their owning context", async () => {
    const diagnostics = diag();
    const backing = memory();
    saveToEmergencyQueue(batch("A"), diagnostics);
    saveToEmergencyQueue(batch("B"), diagnostics);
    expect(await drainEmergencyQueue(backing, diagnostics, (b) => b.routingContextId === "A")).toBe(
      1,
    );
    clearEmergencyContext("A", diagnostics);
    expect(await drainEmergencyQueue(backing, diagnostics)).toBe(1);
    saveToEmergencyQueue(batch("A"), diagnostics);
    clearEmergencyContext("A", diagnostics);
    expect(await drainEmergencyQueue(backing, diagnostics)).toBe(0);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    clearEmergencyContext("A", diagnostics);
  });
});

describe("policy validation", () => {
  it.each([
    { capture: { interactions: 1 } },
    { capture: { interactions: { text: "yes", selector: 1, maxTextChars: -1 } } },
    { capture: { interactions: { ignoreSelector: "[" } } },
    { capture: { interactions: { ignoreSelector: 1 } } },
    { loggerCache: { maxEntries: -1 } },
    { loggerCache: { maxEntries: Infinity } },
    { bus: { sourcePolicy: "all", validation: "off", maxMessageBytes: -1, maxTrackedSources: -1 } },
  ])("reports invalid policy settings without broadening capture %#", (input) => {
    const diagnostics = diag();
    const config = resolveConfig({ ...base, ...input } as never, diagnostics);
    expect(diagnostics.snapshot()["config.invalid"]).toBeGreaterThan(0);
    expect(config.loggerCache.maxEntries).toBe(256);
  });

  it("merges interaction options and supports unbounded cache on repeated configuration", () => {
    const diagnostics = diag();
    const a = resolveConfig(
      {
        ...base,
        loggerCache: { maxEntries: null },
        capture: { interactions: { text: true, ignoreSelector: ".private" } },
      },
      diagnostics,
    );
    const b = resolveConfig({ capture: { interactions: { selector: true } } }, diagnostics, a);
    expect(b.capture.interactions).toMatchObject({
      text: true,
      selector: true,
      ignoreSelector: ".private",
    });
    expect(b.loggerCache.maxEntries).toBeNull();
  });
});

describe("health and transition lifecycle", () => {
  it("reports version conflict as a machine-readable health failure", async () => {
    const key = Symbol.for("ui-observability.runtime");
    (globalThis as Record<symbol, unknown>)[key] = { sdkVersion: "0.0.1" };
    configure(base);
    await flush();
    expect(await getHealth()).toMatchObject({
      status: "degraded",
      mode: "console-only",
      owningSdkVersion: "0.0.1",
      issues: ["runtime.version_mismatch"],
    });
    await shutdown();
    Reflect.deleteProperty(globalThis, key);
  });

  it("reports unavailable sender initialization", async () => {
    const { Sender } = await import("../src/core/sender");
    vi.spyOn(Sender, "create").mockRejectedValue(new Error("unavailable"));
    configure({ ...base, transport: createMemoryTransport().transport });
    await flush();
    expect(await getHealth()).toMatchObject({ status: "degraded", issues: ["sender.unavailable"] });
  });

  it("validates before retirement and rejects rotation after shutdown", async () => {
    const send = createMemoryTransport();
    configure({ ...base, transport: send.transport, securityContext: { id: "A" } });
    await flush();
    await expect(
      rotateSecurityContext({ id: "B", delivery: { endpoint: "bad-url" } }),
    ).rejects.toThrow("Invalid delivery");
    expect(rt().config.securityContext.id).toBe("A");
    getLogger("still-active").info("A survives");
    await flush();
    expect(send.records()[0].body).toBe("A survives");
    await shutdown();
    await expect(rotateSecurityContext({ delivery: {} })).rejects.toThrow("stopped");
  });

  it("starts a fresh generated context without a destination, and refuses configure while rotating", async () => {
    configure(base);
    await flush();
    const before = rt().config.securityContext.id;
    const changing = rotateSecurityContext({ delivery: {} });
    configure({ serviceName: "refused" });
    addBreadcrumb("during");
    counter("during").add(1);
    await changing;
    expect(rt().config.serviceName).toBe("policies");
    expect(rt().config.securityContext.id).not.toBe(before);
    expect(rt().breadcrumbs.snapshot()).toEqual([]);
  });

  it("cancels public source registrations after they are attached", async () => {
    configure(base);
    await flush();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const detachFrame = registerFrame(iframe, { origin: location.origin });
    const worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const detachWorker = registerWorker(worker);
    await vi.waitFor(() => {
      expect(worker.addEventListener).toHaveBeenCalled();
    });
    detachFrame();
    detachWorker();
    expect(worker.removeEventListener).toHaveBeenCalled();
  });

  it("drops completions from a fetch started in the previous security context", async () => {
    configure({ ...base, capture: { errors: false, rejections: false, fetch: true } });
    await flush();
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const capture = new NetworkCapture({
      config: rt().config,
      diagnostics: diag(),
      logger,
      recordMetric: vi.fn(),
    } as never);
    capture.install();
    const request = fetch("https://api.example/account/A");
    await rotateSecurityContext({ delivery: {} });
    resolve(new Response("", { status: 500 }));
    await request;
    expect(logger.warn).not.toHaveBeenCalled();
    capture.uninstall();
  });
});

describe("bus capability and delivery boundaries", () => {
  function create() {
    const config = resolveConfig(
      { ...base, bus: { mode: "sender" }, securityContext: { id: "A" } },
      diag(),
    );
    const handlers = {
      onRecords: vi.fn(),
      onJourney: vi.fn(),
      onJourneyRequest: vi.fn(() => ({
        id: "journey",
        name: "flow",
        startedAt: Date.now(),
        ownerContextId: "host",
      })),
      onTabConflict: vi.fn(),
      remote: { sampling: null },
      onSecurityContext: vi.fn((id: string) => {
        config.securityContext.id = id;
        return true;
      }),
    };
    const bus = new Bus(
      config,
      diag(),
      { platform: "browser", isTopLevelDocument: true, isWorker: false, userAgent: "test" },
      "host",
      "tab",
      handlers,
    );
    return {
      config,
      handlers,
      bus,
      receive: (m: BusMessage, s: MessageSource) => bus["receive"](m, s),
    };
  }

  it("does not disclose control payloads to a records-only worker", () => {
    const { bus, handlers } = create();
    const worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const detach = bus.attachWorker(worker);
    bus.broadcastJourney({ id: "private", name: "flow", startedAt: Date.now() } as never);
    expect(worker.postMessage).not.toHaveBeenCalled();
    const listener = worker.addEventListener.mock.calls[0][1] as (e: MessageEvent) => void;
    listener(new MessageEvent("message", { data: { p: "uiobs-bus-v1", m: {} } }));
    detach();
    expect(worker.removeEventListener).toHaveBeenCalled();
    expect(handlers.onRecords).not.toHaveBeenCalled();
    bus.destroy();
  });

  it("supports direct permitted queries, rejects forged authority and stale context records", () => {
    const { bus, handlers, receive } = create();
    const peer = {} as Window;
    bus.registerFrame(peer, {
      origin: location.origin,
      permissions: ["records", "journey:read", "journey:write", "sampling:read"],
    });
    const reply = vi.fn();
    bus.acceptDirect({ t: "hello", from: "child", tabId: "tab" }, reply, peer);
    bus.acceptDirect({ t: "journey?", from: "child" }, reply, peer);
    bus.acceptDirect({ t: "sampling?", from: "child" }, reply, peer);
    bus.acceptDirect(
      { t: "records", from: "child", records: [record()], routingContextId: "old" },
      reply,
      peer,
    );
    expect(reply.mock.calls.map(([m]) => m.t)).toEqual([
      "welcome",
      "journey",
      "sampling",
      "security-context",
    ]);
    expect(handlers.onRecords).not.toHaveBeenCalled();
    receive(
      { t: "sampling", from: "child", to: "host", rules: {} },
      { link: "direct", origin: location.origin, peer },
    );
    receive(
      { t: "security-context", from: "child", id: "evil" },
      { link: "direct", origin: location.origin, peer },
    );
    expect(handlers.onSecurityContext).not.toHaveBeenCalled();
    bus.destroy();
  });

  it("chunks outbound batches and drops a record that cannot fit by itself", () => {
    const { bus, config } = create();
    const post = vi.fn();
    bus["upstream"] = { kind: "parent", post, close: vi.fn() };
    config.bus.maxRecordsPerMessage = 1;
    bus.sendRecords([record(), record()]);
    expect(post).toHaveBeenCalledTimes(2);
    post.mockClear();
    config.bus.maxMessageBytes = 10;
    bus.sendRecords([record()]);
    expect(post).not.toHaveBeenCalled();
    bus.sendRecords([]);
    bus.destroy();
  });

  it("checks physical source budgets, finite fields and broadcast data-plane permission", () => {
    const { bus, config, handlers, receive } = create();
    const m: BusMessage = {
      t: "records",
      from: "peer",
      routingContextId: "A",
      records: [record()],
    };
    receive(m, { link: "broadcast", origin: "same-origin" });
    receive(
      { ...m, records: [{ ...record(), attributes: { value: Infinity } }] },
      { link: "openfin", origin: "openfin", peer: "one" },
    );
    config.bus.maxTrackedSources = 1;
    receive(m, { link: "openfin", origin: "openfin", peer: "two" });
    expect(handlers.onRecords).not.toHaveBeenCalled();
    config.bus.maxTrackedSources = 0;
    receive(m, { link: "openfin", origin: "openfin", peer: "three" });
    expect(handlers.onRecords).toHaveBeenCalledTimes(1);
    bus.destroy();
    receive(m, { link: "openfin", origin: "openfin" });
    expect(handlers.onRecords).toHaveBeenCalledTimes(1);
  });
});

// Control when the work completes. These tests do not wait for a retry timer.
describe("delivery cancellation and owner adoption", () => {
  it("rejects foreign or stopped transport sends and aborts HTTP already in flight", async () => {
    const { HttpTransport } = await import("../src/transport/http-transport");
    const config = resolveConfig(
      {
        ...base,
        endpoint: "https://ingest.example/logs",
        compression: "none",
        securityContext: { id: "A" },
      },
      diag(),
    );
    const http = new HttpTransport(config, diag());
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => {
            reject(new Error("cancelled"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(http.send(batch("B"))).rejects.toMatchObject({ kind: "permanent" });
    const sending = http.send(batch("A"));
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    http.stop();
    await expect(sending).rejects.toMatchObject({ kind: "permanent" });
    await expect(http.send(batch("A"))).rejects.toMatchObject({ kind: "permanent" });
  });

  it("does not mutate a stored retry after stop wins an in-flight failure race", async () => {
    const { RetryEngine } = await import("../src/transport/retry-engine");
    const backing = memory();
    await backing.save(batch("A"));
    let fail!: (reason: Error) => void;
    const send = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const retry = new RetryEngine(
      backing,
      { send, throttledForMs: () => 0 },
      diag(),
      resolveConfig(base, diag()),
    );
    const draining = retry["drain"]();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });
    retry.stop();
    fail(new Error("cancelled"));
    await draining;
    expect((await backing.take(1))[0].attempts).toBe(0);
  });

  it("retains memory-backed records across rotations within the same runtime", async () => {
    const send = createMemoryTransport();
    send.respondWith(503);
    configure({ ...base, transport: send.transport, securityContext: { id: "A" } });
    getLogger("orders").info("park A");
    await flush();
    await rotateSecurityContext(
      { id: "B", delivery: { transport: send.transport } },
      { pending: "retain" },
    );
    await rotateSecurityContext({ id: "A", delivery: { transport: send.transport } });
    send.respondWith(204);
    await rt()["sender"]!["retry"]["drain"]();
    expect(send.records()[0].body).toBe("park A");
  });

  it("clears buffered user context when an automatic forwarder adopts a changed owner", async () => {
    configure(base);
    await flush();
    const runtime = rt();
    const bus = (await runtime["constructBus"]())!;
    const adopt = bus["handlers"].onSecurityContext!;
    runtime.context.set("user", "old");
    addBreadcrumb("old");
    counter("old").add(1);
    expect(adopt("owner-A")).toBe(true);
    expect(runtime.config.securityContext.id).toBe("owner-A");
    expect(runtime.context.getAll()).toEqual({});
    expect(runtime.breadcrumbs.snapshot()).toEqual([]);
    expect(adopt("owner-A")).toBe(true);
    bus["role"] = "forwarder";
    expect((await getHealth()).mode).toBe("forwarder");
    await expect(rotateSecurityContext({ delivery: {} })).rejects.toThrow("upstream owner");
    runtime["ingestForwarded"]([]);
  });

  it("reports explicit owner identity mismatch without adopting it", async () => {
    configure({ ...base, securityContext: { id: "explicit" } });
    await flush();
    const bus = (await rt()["constructBus"]())!;
    expect(bus["handlers"].onSecurityContext!("foreign")).toBe(false);
    expect((await getHealth()).issues).toContain("security.context_mismatch");
    expect(bus["handlers"].onSecurityContext!("explicit")).toBe(true);
    expect((await getHealth()).issues).not.toContain("security.context_mismatch");
  });

  it("lets health inspect startup and rotation without waiting for startup work", async () => {
    const { JourneyEngine } = await import("../src/core/journey");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(JourneyEngine.prototype, "bootstrap").mockReturnValue(gate);
    configure(base);
    expect((await getHealth()).status).toBe("starting");
    const bus = (await rt()["constructBus"]())!;
    expect(bus["handlers"].onSecurityContext!("initial-owner")).toBe(true);
    const changing = rotateSecurityContext({ delivery: {} });
    expect((await getHealth()).status).toBe("rotating");
    getLogger("orders").error("during", new Error("secret"));
    rt()["ingestForwarded"]([record()]);
    release();
    await changing;
    expect((await getHealth()).status).toBe("ready");
    const runtime = rt();
    await shutdown();
    runtime.registerWorker({
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })();
  });

  it("rejects malformed rotation arguments as promises", async () => {
    configure(base);
    for (const update of [
      null,
      1,
      {},
      { delivery: null },
      { delivery: "wrong" },
      { delivery: {}, id: 1 },
    ]) {
      await expect(rotateSecurityContext(update as never)).rejects.toThrow("Invalid");
    }
    await expect(rotateSecurityContext({ delivery: {} }, { timeoutMs: -1 })).rejects.toThrow();
    await expect(
      rotateSecurityContext({ delivery: {} }, { pending: "unknown" as never }),
    ).rejects.toThrow();
  });

  it("honors cancellation before a new sender is installed", async () => {
    const { Sender } = await import("../src/core/sender");
    configure({ ...base, transport: createMemoryTransport().transport });
    await flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = Sender.prototype.retire;
    const retiring = vi.spyOn(Sender.prototype, "retire").mockImplementation(async function (
      this: SenderInstance,
      ...args
    ) {
      await gate;
      return original.apply(this, args);
    });
    const changing = rotateSecurityContext({ delivery: {} });
    await vi.waitFor(() => {
      expect(retiring).toHaveBeenCalled();
    });
    const closing = shutdown();
    release();
    await Promise.all([changing, closing]);
    expect((await getHealth()).status).toBe("stopped");
  });

  it("preserves unbounded cache on invalid updates and compares locked maps and regex settings", () => {
    const diagnostics = diag();
    const a = resolveConfig({ ...base, loggerCache: { maxEntries: null } }, diagnostics);
    expect(
      resolveConfig({ loggerCache: { maxEntries: -1 } }, diagnostics, a).loggerCache.maxEntries,
    ).toBeNull();
    configure({
      ...base,
      minLevels: { one: "DEBUG" },
      capture: { ignoreUrls: [/api/] },
      lockConfiguration: true,
    });
    configure({ capture: { ignoreUrls: [/api/] } });
    configure({ minLevels: { two: "DEBUG" } });
    expect(rt().config.minLevels).toEqual({ one: "DEBUG" });
    rt().setConfigurationLocked("bad" as never);
    expect(rt().config.lockConfiguration).toBe(true);
  });
});

describe("registered bus control traffic", () => {
  function create() {
    const config = resolveConfig(
      { ...base, bus: { mode: "sender" }, securityContext: { id: "A" } },
      diag(),
    );
    const h = {
      onRecords: vi.fn(),
      onJourney: vi.fn(),
      onJourneyRequest: vi.fn(() => ({
        id: "j",
        name: "flow",
        startedAt: Date.now(),
        ownerContextId: "host",
      })),
      onTabConflict: vi.fn(),
      remote: { sampling: null },
      onSecurityContext: vi.fn(() => true),
    };
    const bus = new Bus(
      config,
      diag(),
      { platform: "browser", isTopLevelDocument: true, isWorker: false, userAgent: "test" },
      "host",
      "tab",
      h,
    );
    return {
      bus,
      h,
      config,
      receive: (message: BusMessage, source: MessageSource) => bus["receive"](message, source),
    };
  }

  it("keeps re-registered sources authorized until their current registration is removed", () => {
    const { bus, config } = create();
    const peer = {} as Window;
    expect(bus.isRegistered(null, location.origin)).toBe(false);
    const a = bus.registerFrame(peer, { origin: location.origin });
    const b = bus.registerFrame(peer, { origin: location.origin, permissions: [] });
    a();
    expect(bus.isRegistered(peer, location.origin)).toBe(true);
    b();
    expect(bus.isRegistered(peer, location.origin)).toBe(false);
    config.bus.sourcePolicy = "trusted-origin";
    expect(bus.isRegistered(peer, location.origin)).toBe(true);
    config.bus.trustedOrigins = ["https://allowed.example"];
    expect(bus.isRegistered(peer, "https://allowed.example")).toBe(true);
    expect(bus.isRegistered(peer, "null")).toBe(false);
    expect(bus.isRegistered(peer, "https://denied.example")).toBe(false);
    const detached = document.createElement("iframe");
    Object.defineProperty(detached, "contentWindow", { value: null });
    expect(() => bus.registerFrame(detached, { origin: location.origin })).toThrow();
    expect(() => bus.registerFrame(peer, { origin: `${location.origin}/path` })).toThrow();
    bus.destroy();
  });

  it("grants and revokes worker control capabilities in both directions", () => {
    const { bus, h } = create();
    const worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const detach = bus.attachWorker(worker, {
      permissions: ["records", "journey:read", "journey:write", "sampling:read"],
    });
    const link = bus["links"].at(-1)!;
    bus.broadcastJourney(null);
    link.post({ t: "journey?", from: "host" });
    bus["receive"](
      { t: "journey?", from: "child" },
      { link: "worker", origin: "same-origin", peer: worker },
    );
    bus["receive"](
      { t: "sampling?", from: "child" },
      { link: "worker", origin: "same-origin", peer: worker },
    );
    bus["receive"](
      { t: "journey", from: "child", journey: null },
      { link: "worker", origin: "same-origin", peer: worker },
    );
    expect(worker.postMessage.mock.calls.map(([e]) => e.m.t)).toContain("sampling");
    expect(h.onJourneyRequest).toHaveBeenCalled();
    const n = worker.postMessage.mock.calls.length;
    detach();
    link.post({ t: "journey", from: "host", journey: null });
    expect(worker.postMessage).toHaveBeenCalledTimes(n);
    const second = bus.attachWorker(worker, { permissions: [] });
    bus.broadcastJourney(null);
    bus["links"].at(-1)!.post({ t: "journey?", from: "host" });
    bus["links"].at(-1)!.post({ t: "sampling", from: "host", to: "child", rules: null });
    bus.destroy();
    second();
    detach();
  });

  it("accepts context publication only from the negotiated physical upstream", () => {
    const { bus, h, receive } = create();
    const peer = {};
    bus["role"] = "forwarder";
    bus["upstream"] = { kind: "parent", post: vi.fn(), close: vi.fn() };
    const source: MessageSource = { link: "parent", origin: location.origin, peer };
    const settle = vi.fn();
    bus["awaitingWelcome"] = { link: "parent", settle };
    h.onSecurityContext.mockReturnValueOnce(false);
    receive(
      { t: "welcome", from: "owner", to: "host", tabId: "tab", routingContextId: "A" },
      source,
    );
    expect(settle).not.toHaveBeenCalled();
    receive(
      { t: "welcome", from: "owner", to: "host", tabId: "tab", routingContextId: "A" },
      source,
    );
    expect(settle).toHaveBeenCalledWith(true);
    receive({ t: "security-context", from: "owner", id: "B" }, source);
    h.onSecurityContext.mockReturnValueOnce(false);
    receive({ t: "security-context", from: "owner", id: "C" }, source);
    const count = h.onSecurityContext.mock.calls.length;
    receive({ t: "security-context", from: "owner", id: "D" }, { ...source, peer: {} });
    receive({ t: "security-context", from: "forged", id: "D" }, source);
    expect(h.onSecurityContext).toHaveBeenCalledTimes(count);
    const child = {} as Window;
    bus.registerFrame(child, { origin: location.origin });
    bus.acceptDirect({ t: "hello", from: "host", tabId: "tab" }, vi.fn(), child);
    bus.acceptDirect(
      { t: "records", from: "child", records: [record()], routingContextId: "A" },
      vi.fn(),
      child,
    );
    expect(bus["upstream"].post).toHaveBeenCalledWith(expect.objectContaining({ t: "records" }));
    receive({ t: "sampling", from: "owner", to: "host", rules: null }, { ...source, peer: {} });
    // A configured forwarder uses announce(). It has no pending handshake promise.
    bus["awaitingWelcome"] = null;
    bus["ownerId"] = null;
    receive(
      { t: "welcome", from: "owner", to: "host", tabId: "tab", routingContextId: "A" },
      source,
    );
    receive({ t: "journey", from: "owner", journey: null }, source);
    expect(h.onJourney).toHaveBeenCalledWith(null);
    bus.destroy();
  });

  it("drops unregistered direct traffic and non-finite data, and expires named-source budgets", () => {
    const { bus, config, h, receive } = create();
    bus.acceptDirect({ t: "hello", from: "child", tabId: "tab" }, vi.fn());
    const m: BusMessage = {
      t: "records",
      from: "peer",
      records: [record()],
      routingContextId: "A",
    };
    receive(m, { link: "openfin", origin: "openfin", peer: "old" });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1001);
    config.bus.maxTrackedSources = 1;
    receive(m, { link: "openfin", origin: "openfin", peer: "new" });
    expect(h.onRecords).toHaveBeenCalledTimes(2);
    bus.destroy();
  });
});

describe("policy edge cases", () => {
  it("guards frame egress after unregistering and before granting journey reads", async () => {
    const { envelope } = await import("../src/models/bus");
    configure(base);
    await flush();
    const runtime = rt();
    expect(runtime.busCanAccept(window, location.origin)).toBe(false);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const detach = registerFrame(iframe, { origin: location.origin });
    await vi.waitFor(() => {
      expect(runtime.busCanAccept(iframe.contentWindow!, location.origin)).toBe(true);
    });
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    dispatchEvent(
      new MessageEvent("message", {
        data: envelope({ t: "hello", from: "frame", tabId: "tab" }),
        source: iframe.contentWindow,
        origin: location.origin,
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ m: expect.objectContaining({ t: "welcome" }) }),
      location.origin,
    );
    post.mockClear();
    runtime["bus"]!.broadcastJourney(null);
    expect(post).not.toHaveBeenCalled();
    detach();
    runtime["bus"]!.rotateContext();
    expect(post).not.toHaveBeenCalled();
    const { createDirectLink } = await import("../src/bus/links");
    const parent = { [Symbol.for("ui-observability.runtime")]: runtime } as unknown as Window &
      typeof globalThis;
    vi.spyOn(window, "parent", "get").mockReturnValue(parent);
    expect(createDirectLink(vi.fn(), diag())).toBeNull();
  });

  it("uses OpenFin's physical source identity when supplied", async () => {
    const { createOpenFinLink } = await import("../src/bus/links");
    const { envelope } = await import("../src/models/bus");
    let listener!: (m: unknown, uuid?: string, name?: string) => void;
    vi.stubGlobal("fin", {
      InterApplicationBus: {
        subscribe: vi.fn((_identity, _topic, cb) => {
          listener = cb;
          return Promise.resolve();
        }),
        publish: vi.fn().mockResolvedValue(undefined),
      },
    });
    const receive = vi.fn();
    const link = createOpenFinLink("topic", "app", receive, diag());
    listener(envelope({ t: "hello", from: "peer", tabId: "tab" }), "app");
    listener(envelope({ t: "hello", from: "peer", tabId: "tab" }), "app", "view");
    expect(receive.mock.calls[1][1].peer).toBe("app:view");
    link!.close();
  });

  it("supports registration in environments without a window link", () => {
    vi.stubGlobal("window", undefined);
    const config = resolveConfig(base, diag());
    const bus = new Bus(
      config,
      diag(),
      { platform: "browser", isTopLevelDocument: false, isWorker: true, userAgent: "test" },
      "host",
      "tab",
      {
        onRecords: vi.fn(),
        onJourney: vi.fn(),
        onJourneyRequest: () => null,
        onTabConflict: vi.fn(),
        remote: { sampling: null },
      },
    );
    bus.registerFrame({} as Window, { origin: location.origin })();
    bus.destroy();
    vi.stubGlobal("document", undefined);
    expect(
      resolveConfig({ ...base, capture: { interactions: { ignoreSelector: ".private" } } }, diag())
        .capture.interactions,
    ).toMatchObject({ ignoreSelector: ".private" });
  });

  it("ignores captures during rotation and handles explicit empty action IDs", async () => {
    const { InteractionCapture } = await import("../src/capture/interactions");
    configure({ ...base, capture: { errors: false, rejections: false } });
    await flush();
    rt().config.capture.interactions = { text: true };
    rt().config.capture.navigation = true;
    let active = false;
    const capture = new InteractionCapture({
      config: rt().config,
      diagnostics: diag(),
      breadcrumbs: rt().breadcrumbs,
      tracing: rt().tracing,
      isActive: () => active,
      logger: getLogger("capture"),
    } as never);
    capture.install();
    document.body.innerHTML = '<button data-observability-action="">private</button>';
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    history.pushState({}, "", "/ignored-navigation");
    await Promise.resolve();
    expect(rt().breadcrumbs.snapshot()).toEqual([]);
    active = true;
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rt().breadcrumbs.snapshot()[0]).toMatchObject({
      message: "unknown-click",
      data: { text: "private" },
    });
    capture.uninstall();
  });

  it("parks a buffered batch before its flush interval and flushes eligible persisted work with old credentials", async () => {
    const send = createMemoryTransport();
    configure({ ...base, transport: send.transport, securityContext: { id: "A" } });
    await flush();
    getLogger("pending").info("buffered A");
    await rotateSecurityContext(
      { id: "B", delivery: { transport: send.transport } },
      { pending: "retain" },
    );
    await rotateSecurityContext({ id: "A", delivery: { transport: send.transport } });
    await rotateSecurityContext({ id: "C", delivery: {} }, { pending: "flush" });
    expect(send.records()[0].body).toBe("buffered A");
    expect(send.batches()[0].routingContextId).toBe("A");
  });

  it("still shuts down cleanly when a concurrently awaited rotation rejects", async () => {
    configure(base);
    await flush();
    const change = rotateSecurityContext({ delivery: { endpoint: "invalid" } });
    const rejected = expect(change).rejects.toThrow("Invalid delivery");
    const closing = shutdown();
    await rejected;
    await closing;
  });

  it("cannot change the routing identity through ordinary configure by default", async () => {
    configure({ ...base, securityContext: { id: "" } });
    await flush();
    const id = rt().config.securityContext.id;
    configure({ securityContext: { id: "other" } });
    expect(rt().config.securityContext.id).toBe(id);
  });

  it("honors a master disable triggered while preparing a console-only error", () => {
    configure({ ...base, minLevel: "FATAL", console: true, redact: (r) => r });
    const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("private");
    Object.defineProperty(error, "name", {
      get() {
        configure({ enabled: false });
        return "Error";
      },
    });
    getLogger("orders").error("private", error);
    expect(write).not.toHaveBeenCalled();
  });

  it("cancels header preparation synchronously and an unload send before dispatch", async () => {
    const { HttpTransport } = await import("../src/transport/http-transport");
    const config = resolveConfig(
      {
        ...base,
        endpoint: "https://ingest.example/logs",
        securityContext: { id: "A" },
        compression: "none",
      },
      diag(),
    );
    const http = new HttpTransport(config, diag());
    config.headers = () => {
      http.stop();
      return {};
    };
    await expect(http.send(batch("A"))).rejects.toMatchObject({ kind: "permanent" });
    const next = new HttpTransport({ ...config, headers: undefined }, diag());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init: RequestInit) => {
        expect(init.signal!.aborted).toBe(true);
        return Promise.reject(new Error("cancelled"));
      }),
    );
    await expect(
      next.send(batch("A"), () => {
        next.stop();
      }),
    ).rejects.toMatchObject({ kind: "permanent" });
  });
});

it("compares locked cyclic serializer objects without recursion failure", () => {
  interface Cyclic {
    name: string;
    serialize: () => { body: string; contentType: string };
    self?: Cyclic;
  }
  const a: Cyclic = {
    name: "custom",
    serialize: () => ({ body: "{}", contentType: "application/json" }),
  };
  a.self = a;
  const b: Cyclic = { ...a };
  b.self = b;
  configure({ ...base, serializer: a, lockConfiguration: true });
  configure({ serializer: b });
  expect(rt().diagnostics.snapshot()["config.locked"]).toBeUndefined();
  const c: Cyclic = { ...b };
  c.self = b;
  configure({ serializer: c });
  expect(rt().diagnostics.snapshot()["config.locked"]).toBe(1);
});

describe("rotation reach, frame registration and partial storage reads", () => {
  function create() {
    const config = resolveConfig(
      { ...base, bus: { mode: "sender" }, securityContext: { id: "A" } },
      diag(),
    );
    const handlers = {
      onRecords: vi.fn(),
      onJourney: vi.fn(),
      onJourneyRequest: vi.fn(() => null),
      onTabConflict: vi.fn(),
      remote: { sampling: null },
      onSecurityContext: vi.fn(() => true),
    };
    const bus = new Bus(
      config,
      diag(),
      { platform: "browser", isTopLevelDocument: true, isWorker: false, userAgent: "test" },
      "host",
      "tab",
      handlers,
    );
    return { bus, config, handlers };
  }

  it("sends a rotated context to OpenFin views, and a view accepts it from its provider", () => {
    const { bus, config } = create();
    const post = vi.fn();
    bus["links"].push({ kind: "openfin", post, close: vi.fn() });
    config.securityContext.id = "B";
    bus.rotateContext();
    expect(post).toHaveBeenCalledWith({ t: "security-context", from: "host", id: "B" });
    // A view that forwards does not send on the OpenFin link.
    post.mockClear();
    bus["role"] = "forwarder";
    bus.rotateContext();
    expect(post).not.toHaveBeenCalled();
    bus.destroy();

    const view = create();
    view.bus["role"] = "forwarder";
    view.bus["upstream"] = { kind: "openfin", post: vi.fn(), close: vi.fn() };
    view.bus["ownerId"] = "provider";
    view.bus["ownerPeer"] = "app:provider";
    view.bus["receive"](
      { t: "security-context", from: "provider", id: "B" },
      { link: "openfin", origin: "openfin", peer: "app:provider" },
    );
    expect(view.handlers.onSecurityContext).toHaveBeenCalledWith("B");
    view.bus.destroy();
  });

  it("registers a cross-origin window without a property read that throws", () => {
    const { bus } = create();
    const blocked = (): never => {
      throw new DOMException("Blocked a frame from a cross-origin access.", "SecurityError");
    };
    const crossOrigin = new Proxy({}, { has: blocked, get: blocked }) as Window;
    const detach = bus.registerFrame(crossOrigin, { origin: "https://orders.example" });
    expect(bus.isRegistered(crossOrigin, "https://orders.example")).toBe(true);
    detach();
    expect(bus.isRegistered(crossOrigin, "https://orders.example")).toBe(false);
    // A realm without HTMLIFrameElement has no frame elements. The value is the window.
    vi.stubGlobal("HTMLIFrameElement", undefined);
    const peer = {} as Window;
    bus.registerFrame(peer, { origin: location.origin });
    expect(bus.isRegistered(peer, location.origin)).toBe(true);
    bus.destroy();
  });

  it("ignores parent messages on the child link of a nested frame", async () => {
    const { envelope: wrap } = await import("../src/models/bus");
    const parentFrame = document.createElement("iframe");
    const childFrame = document.createElement("iframe");
    document.body.append(parentFrame, childFrame);
    vi.spyOn(window, "parent", "get").mockReturnValue(
      parentFrame.contentWindow as Window & typeof globalThis,
    );
    const receive = vi.fn();
    const link = createChildrenLink(receive, [], diag())!;
    const hello = wrap({ t: "hello", from: "peer", tabId: "tab" });
    dispatchEvent(
      new MessageEvent("message", {
        data: hello,
        source: parentFrame.contentWindow,
        origin: location.origin,
      }),
    );
    expect(receive).not.toHaveBeenCalled();
    dispatchEvent(
      new MessageEvent("message", {
        data: hello,
        source: childFrame.contentWindow,
        origin: location.origin,
      }),
    );
    expect(receive).toHaveBeenCalledTimes(1);
    link.close();
  });

  it("measures each outbound record one time and fills a message to its byte limit", () => {
    const { bus, config } = create();
    const post = vi.fn();
    bus["upstream"] = { kind: "parent", post, close: vi.fn() };
    const two = new TextEncoder().encode(
      JSON.stringify({
        t: "records",
        from: "host",
        records: [record(), record()],
        routingContextId: "A",
      }),
    ).length;
    config.bus.maxRecordsPerMessage = 0;
    config.bus.maxMessageBytes = two;
    const stringify = vi.spyOn(JSON, "stringify");
    bus.sendRecords([record(), record(), record()]);
    // One call for the empty envelope and one call for each record.
    expect(stringify).toHaveBeenCalledTimes(4);
    stringify.mockRestore();
    expect(post.mock.calls.map(([m]) => m.records.length)).toEqual([2, 1]);

    // Without a byte limit, the bus does not encode the records.
    post.mockClear();
    config.bus.maxMessageBytes = 0;
    config.bus.maxRecordsPerMessage = 2;
    const unmeasured = vi.spyOn(JSON, "stringify");
    bus.sendRecords([record(), record(), record()]);
    expect(unmeasured).not.toHaveBeenCalled();
    unmeasured.mockRestore();
    expect(post.mock.calls.map(([m]) => m.records.length)).toEqual([2, 1]);
    bus.destroy();
  });

  it("reads only the active part of the store for retry and count", async () => {
    const backing = memory();
    await backing.save(batch("A"));
    await backing.save(batch("B"));
    await backing.save({ ...batch("A"), id: "A2" });
    const policy = { id: "A", isolation: true };
    const storage = new ContextStorage(backing, policy);
    const take = vi.spyOn(backing, "take");
    expect((await storage.take(5)).map((b) => b.id)).toEqual(["A", "A2"]);
    expect(await storage.count()).toBe(2);
    expect(take).not.toHaveBeenCalled();
    policy.isolation = false;
    expect((await storage.take(1)).map((b) => b.id)).toEqual(["A"]);
    expect(take).toHaveBeenCalledWith(1);
    expect(await storage.count()).toBe(3);

    // An adapter without a context read falls back to a filtered full read.
    const bare = memory();
    await bare.save(batch("A"));
    await bare.save(batch("B"));
    // Own undefined properties hide the prototype methods. The type of bare stays MemoryStorage.
    Object.assign(bare, { takeContext: undefined, countContext: undefined });
    const fallback = new ContextStorage(bare, { id: "A", isolation: true });
    expect((await fallback.take(5)).map((b) => b.id)).toEqual(["A"]);
    expect(await fallback.count()).toBe(1);
  });

  it("reads one context from localStorage, stops at the limit and removes corrupt entries", async () => {
    const store = new LocalStorageStorage(
      { maxBatches: 500, maxAgeMs: 60000, maxAttempts: 5 },
      diag(),
    );
    const now = Date.now();
    await store.save({ ...batch("A"), id: "a1", createdAt: now });
    await store.save({ ...batch("B"), id: "b1", createdAt: now + 1 });
    await store.save({ ...batch("A"), id: "a2", createdAt: now + 2 });
    const corrupt = `${BATCH_STORAGE_KEY_PREFIX}${String(now - 1).padStart(BATCH_KEY_TIME_WIDTH, "0")}.bad`;
    localStorage.setItem(corrupt, "{");
    expect((await store.takeContext("A", 1)).map((b) => b.id)).toEqual(["a1"]);
    expect(localStorage.getItem(corrupt)).toBeNull();
    expect((await store.takeContext("A", 5)).map((b) => b.id)).toEqual(["a1", "a2"]);
    expect(await store.countContext("A")).toBe(2);
  });

  it("retains more buffered records than the batch limit as whole batches", async () => {
    const send = createMemoryTransport();
    configure({
      ...base,
      transport: send.transport,
      securityContext: { id: "A" },
      retention: { maxBatches: 2 },
    });
    await flush();
    for (let i = 0; i < 5; i++) {
      getLogger("pending").info(`buffered ${String(i)}`);
    }
    await rotateSecurityContext(
      { id: "B", delivery: { transport: send.transport } },
      { pending: "retain" },
    );
    await rotateSecurityContext({ id: "A", delivery: { transport: send.transport } });
    await rt()["sender"]!["retry"]["drain"]();
    const bodies = send.records().map((r) => r.body);
    expect(bodies.filter((body) => body.startsWith("buffered"))).toHaveLength(5);
  });

  it("uses the session that a same-origin owner stores when it adopts a new owner context", async () => {
    configure({ ...base, identity: "storage" });
    await flush();
    const runtime = rt();
    const adopt = (await runtime["constructBus"]())!["handlers"].onSecurityContext!;
    localStorage.setItem(
      SESSION_ID_KEY,
      JSON.stringify({ id: "owner-session", lastSeenAt: Date.now() }),
    );
    adopt("owner-A");
    expect(runtime.identity.sessionId).toBe("owner-session");
    // The stored session is the current session. The owner did not store a new one.
    adopt("owner-B");
    const minted = runtime.identity.sessionId;
    expect(minted).not.toBe("owner-session");
    localStorage.removeItem(SESSION_ID_KEY);
    adopt("owner-C");
    expect(runtime.identity.sessionId).not.toBe(minted);
  });
});

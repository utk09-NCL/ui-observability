import type { Sender as SenderInstance } from "../src/core/sender";
import { describe, expect, it, vi } from "vitest";
import { validMessage } from "../src/bus/validation";
import { ContextStorage } from "../src/storage/context-storage";
import { LocalStorageStorage } from "../src/storage/local-storage";
import { MemoryStorage } from "../src/storage/memory-storage";
import { createChildrenLink, createDirectLink, type Receive } from "../src/bus/links";
import {
  BATCH_KEY_TIME_WIDTH,
  BATCH_STORAGE_KEY_PREFIX,
  BUS_MAX_TRACKED_SOURCES,
  BUS_PROTOCOL,
  SESSION_ID_KEY,
} from "../src/constants";
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
  setConfigurationLocked,
  shutdown,
  createMemoryTransport,
  registerWorker,
  counter,
  addBreadcrumb,
} from "../src/index";
import { ObservabilityRuntime } from "../src/core/runtime";
import { resolveConfig } from "../src/core/config";
import { applyRemote } from "../src/core/remote-rules";
import { Diagnostics, type DiagnosticEvent } from "../src/core/diagnostics";
import { NetworkCapture } from "../src/capture/network";
import { Bus } from "../src/bus/bus";
import type { BusMessage, MessageSource } from "../src/models/bus";
import type { LogRecord } from "../src/models/log-record";
import type { LogBatch } from "../src/models/batch";
import type { ResolvedConfig } from "../src/models/config";

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
  storage: { backend: "memory" },
  identity: "memory",
  capture: { errors: false, rejections: false },
  bus: { mode: "off" },
} as const;
const rt = (): ObservabilityRuntime => ObservabilityRuntime.current()!;

describe("strict wire schema", () => {
  it.each([
    { t: "ui-observability.message.hello", tabId: "tab" },
    { t: "ui-observability.message.tab", tabId: "tab" },
    { t: "ui-observability.message.tab", tabId: "tab", since: 1_700_000_000_000.5 },
    { t: "ui-observability.message.welcome", to: "child", tabId: "tab" },
    { t: "ui-observability.message.welcome", to: "child", tabId: "tab", routingContextId: "A" },
    { t: "ui-observability.message.journey-request" },
    { t: "ui-observability.message.sampling-request" },
    { t: "ui-observability.message.journey", journey: null },
    { t: "ui-observability.message.journey", to: "child", journey: {} },
    { t: "ui-observability.message.sampling", to: "child", rules: null },
    { t: "ui-observability.message.security-context", id: "B" },
    { t: "ui-observability.message.records", records: [record()] },
    {
      t: "ui-observability.message.records",
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
    { from: "", t: "ui-observability.message.hello" },
    { from: 1, t: "ui-observability.message.hello" },
    { from: "peer", t: 1 },
    { t: "ui-observability.message.hello" },
    { t: "unknown" },
    { t: "ui-observability.message.welcome", to: 1, tabId: "tab" },
    { t: "ui-observability.message.welcome", to: "child" },
    { t: "ui-observability.message.welcome", to: "child", tabId: "tab", routingContextId: 1 },
    { t: "ui-observability.message.journey", to: 1, journey: null },
    { t: "ui-observability.message.journey" },
    { t: "ui-observability.message.sampling", to: "child" },
    { t: "ui-observability.message.sampling", to: 1, rules: {} },
    { t: "ui-observability.message.security-context", id: "" },
    { t: "ui-observability.message.security-context", id: 1 },
    { t: "ui-observability.message.records", records: {} },
    { t: "ui-observability.message.records", records: [], routingContextId: 1 },
  ])("rejects malformed protocol input %#", (message) => {
    const candidate =
      typeof message === "object" && message ? { from: "peer", ...message } : message;
    expect(validMessage(candidate)).toBe(false);
  });

  it.each([
    ["a string", "1700000000000"],
    ["null", null],
    ["a boolean", true],
    ["an object", {}],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects a tab claim whose since is %s", (_name, since) => {
    expect(
      validMessage({ t: "ui-observability.message.tab", from: "peer", tabId: "tab", since }),
    ).toBe(false);
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
    expect(
      validMessage({ t: "ui-observability.message.records", from: "peer", records: [r] }),
    ).toBe(false);
  });
});

describe("partition persistence", () => {
  it("never saves foreign batches, delegates retry/prune, and permits an explicit isolation opt-out", async () => {
    const backing = memory();
    const policy = { id: "A", isolation: true };
    const storage = new ContextStorage(backing, policy);
    expect(await storage.save(batch("B"))).toBe(false);
    expect(await backing.count()).toBe(0);
    expect(await storage.save(batch("A"))).toBe(true);
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
    expect(await storage.save(batch("A"))).toBe(false);
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
      return save(batch);
    });
    const storage = new ContextStorage(backing, { id: "A", isolation: true });
    const saving = storage.save(batch("A"));
    await storage.retire(true);
    release();
    // The backing store wrote the batch, but the discard removed it again.
    expect(await saving).toBe(false);
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
    { capture: { interactions: { actionAttribute: 1 } } },
    { capture: { interactions: { actionAttribute: "data action" } } },
    { capture: { interactions: { rageClicks: "yes", rageClickCount: 1, rageClickWindowMs: 50 } } },
    { capture: { interactions: { deadClicks: 1, deadClickMs: 20_000 } } },
    { loggerCache: { maxEntries: -1 } },
    { loggerCache: { maxEntries: Infinity } },
    { bus: { sourcePolicy: "all", maxMessageBytes: -1, maxMessagesPerSecond: -1 } },
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

describe("dead click ignore selector", () => {
  /**
   * Resolves the interaction options the way an app's config does.
   * @param value The `capture.interactions` value.
   * @param previous The active config, for a later configure call.
   * @returns The resolved config, its interaction options and each config.invalid message.
   */
  const resolve = (value: unknown, previous?: ResolvedConfig) => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const config = resolveConfig(
      { ...base, capture: { interactions: value } } as never,
      new Diagnostics(handler, 0),
      previous,
    );
    const invalid = handler.mock.calls
      .map(([event]) => event)
      .filter((event) => event.code === "config.invalid")
      .map((event) => event.message);
    return { config, options: config.capture.interactions, invalid };
  };

  it("defaults to the live attribute selector and reports nothing", () => {
    const { options, invalid } = resolve({ deadClicks: true });

    expect(options).toMatchObject({ deadClickIgnoreSelector: "[data-observability-live]" });
    expect(invalid).toEqual([]);
  });

  it.each([".ticker", ".ticker, [data-quote]"])("keeps the valid selector %j", (selector) => {
    const { options, invalid } = resolve({ deadClicks: true, deadClickIgnoreSelector: selector });

    expect(options).toMatchObject({ deadClickIgnoreSelector: selector });
    expect(invalid).toEqual([]);
  });

  it("keeps an empty selector, which turns the filter off", () => {
    // An empty string isn't valid CSS, so a plain validity check would reject it.
    const { options, invalid } = resolve({ deadClicks: true, deadClickIgnoreSelector: "" });

    expect(options).toMatchObject({ deadClickIgnoreSelector: "" });
    expect(invalid).toEqual([]);
  });

  it.each([1, true, {}, null, [".ticker"]])(
    "reports a selector of %j that isn't a string and keeps the default",
    (selector) => {
      const { options, invalid } = resolve({ deadClicks: true, deadClickIgnoreSelector: selector });

      expect(options).toMatchObject({ deadClickIgnoreSelector: "[data-observability-live]" });
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toContain("capture.interactions.deadClickIgnoreSelector");
    },
  );

  it.each(["[", "div >", "#", ":not("])(
    "reports the selector %j that isn't valid CSS and keeps the default",
    (selector) => {
      const { options, invalid } = resolve({ deadClicks: true, deadClickIgnoreSelector: selector });

      expect(options).toMatchObject({ deadClickIgnoreSelector: "[data-observability-live]" });
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toContain("capture.interactions.deadClickIgnoreSelector");
    },
  );

  it.each(["[", 1])("keeps the current selector when a later call passes %j", (selector) => {
    const first = resolve({ deadClicks: true, deadClickIgnoreSelector: ".ticker" }).config;

    const { options, invalid } = resolve({ deadClickIgnoreSelector: selector }, first);

    expect(options).toMatchObject({ deadClicks: true, deadClickIgnoreSelector: ".ticker" });
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain("capture.interactions.deadClickIgnoreSelector");
  });

  it("keeps the current selector, even an empty one, when a later call leaves it out", () => {
    const first = resolve({ deadClicks: true, deadClickIgnoreSelector: "" }).config;

    const { options, invalid } = resolve({ text: true }, first);

    expect(options).toMatchObject({ text: true, deadClickIgnoreSelector: "" });
    expect(invalid).toEqual([]);
  });

  it("keeps a selector string in a realm that has no document to check it", () => {
    vi.stubGlobal("document", undefined);

    const { options, invalid } = resolve({ deadClicks: true, deadClickIgnoreSelector: ".ticker" });

    expect(options).toMatchObject({ deadClickIgnoreSelector: ".ticker" });
    expect(invalid).toEqual([]);
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

  it("validates before retirement, stops sending after a rejection and rejects after shutdown", async () => {
    const send = createMemoryTransport();
    configure({ ...base, transport: send.transport, securityContext: { id: "A" } });
    await flush();
    await expect(
      rotateSecurityContext({
        id: "B",
        routing: { metricsEndpoint: "https://user:pw@ingest.example/v1/metrics" },
      }),
    ).rejects.toThrow("Invalid routing");
    expect(rt().config.securityContext.id).toBe("A");
    getLogger("still-active").info("A stops");
    await flush();
    // The app asked to leave context A, so its transport sends nothing more.
    expect(send.records()).toEqual([]);
    await shutdown();
    await expect(rotateSecurityContext({ routing: {} })).rejects.toThrow("stopped");
  });

  it("starts a fresh generated context without a destination, and refuses configure while rotating", async () => {
    configure(base);
    await flush();
    const before = rt().config.securityContext.id;
    const changing = rotateSecurityContext({ routing: {} });
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
    iframe.srcdoc = "";
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
    await rotateSecurityContext({ routing: {} });
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
    const { bus, handlers } = create();
    const peer = {} as Window;
    bus.registerFrame(peer, {
      origin: location.origin,
      permissions: ["records", "journey:read", "journey:write", "sampling:read"],
    });
    const reply = vi.fn();
    bus.acceptDirect(
      { t: "ui-observability.message.hello", from: "child", tabId: "tab" },
      reply,
      peer,
    );
    bus.acceptDirect({ t: "ui-observability.message.journey-request", from: "child" }, reply, peer);
    bus.acceptDirect(
      { t: "ui-observability.message.sampling-request", from: "child" },
      reply,
      peer,
    );
    bus.acceptDirect(
      {
        t: "ui-observability.message.records",
        from: "child",
        records: [record()],
        routingContextId: "old",
      },
      reply,
      peer,
    );
    expect(reply.mock.calls.map(([m]) => m.t)).toEqual([
      "ui-observability.message.welcome",
      "ui-observability.message.journey",
      "ui-observability.message.sampling",
      "ui-observability.message.security-context",
    ]);
    expect(handlers.onRecords).not.toHaveBeenCalled();
    // A direct child can't publish owner control messages, so nothing answers them.
    reply.mockClear();
    bus.acceptDirect(
      { t: "ui-observability.message.sampling", from: "child", to: "host", rules: {} },
      reply,
      peer,
    );
    bus.acceptDirect(
      { t: "ui-observability.message.security-context", from: "child", id: "evil" },
      reply,
      peer,
    );
    expect(handlers.onSecurityContext).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
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
    const { bus, handlers, receive } = create();
    const m: BusMessage = {
      t: "ui-observability.message.records",
      from: "peer",
      routingContextId: "A",
      records: [record()],
    };
    receive(m, { link: "broadcast", origin: "same-origin" });
    // A non-finite value refuses each message, but the bus still tracks its named source.
    const infinite = { ...m, records: [{ ...record(), attributes: { value: Infinity } }] };
    for (let i = 0; i < BUS_MAX_TRACKED_SOURCES; i++) {
      receive(infinite, { link: "openfin", origin: "openfin", peer: `peer-${String(i)}` });
    }
    receive(m, { link: "openfin", origin: "openfin", peer: "one too many" });
    expect(handlers.onRecords).not.toHaveBeenCalled();
    receive(m, { link: "openfin", origin: "openfin", peer: "peer-0" });
    expect(handlers.onRecords).toHaveBeenCalledTimes(1);
    bus.destroy();
    receive(m, { link: "openfin", origin: "openfin" });
    expect(handlers.onRecords).toHaveBeenCalledTimes(1);
  });
});

// The tests control when the work completes, so they never wait for a retry timer.
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
        new Promise<number>((_resolve, reject) => {
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
      { id: "B", routing: { transport: send.transport } },
      { pending: "retain" },
    );
    await rotateSecurityContext({ id: "A", routing: { transport: send.transport } });
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
    runtime.context.merge({ user: "old" });
    addBreadcrumb("old");
    counter("old").add(1);
    // The first owner id keeps the app's context, because those records had no other identity.
    expect(adopt("owner-A")).toBe(true);
    expect(runtime.config.securityContext.id).toBe("owner-A");
    expect(runtime.context.getAll()).toEqual({ user: "old" });
    // A later owner id is a rotation, which clears the old identity's context.
    expect(adopt("owner-B")).toBe(true);
    expect(runtime.config.securityContext.id).toBe("owner-B");
    expect(runtime.context.getAll()).toEqual({});
    expect(runtime.breadcrumbs.snapshot()).toEqual([]);
    expect(adopt("owner-B")).toBe(true);
    bus["role"] = "forwarder";
    expect((await getHealth()).mode).toBe("forwarder");
    await expect(rotateSecurityContext({ routing: {} })).rejects.toThrow("upstream owner");
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
    const changing = rotateSecurityContext({ routing: {} });
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
    await expect(rotateSecurityContext({ routing: {} }, { timeoutMs: -1 })).rejects.toThrow();
    await expect(
      rotateSecurityContext({ routing: {} }, { pending: "unknown" as never }),
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
    const changing = rotateSecurityContext({ routing: {} });
    await vi.waitFor(() => {
      expect(retiring).toHaveBeenCalled();
    });
    const closing = shutdown();
    release();
    await expect(changing).rejects.toThrow("The runtime has stopped.");
    await closing;
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

  it("trusts its same-origin children under trusted-origin when this parent is a srcdoc frame", () => {
    const { bus, config } = create();
    const realOrigin = location.origin;
    const child = {} as Window;
    config.bus.sourcePolicy = "trusted-origin";
    // A srcdoc parent's location.origin reads "null", and its origin global holds the real one.
    vi.stubGlobal("location", { origin: "null" });
    vi.stubGlobal("origin", realOrigin);

    expect(bus.isRegistered(child, realOrigin)).toBe(true);
    // The location's "null" is no origin of this page, so an opaque child still gets nothing.
    expect(bus.isRegistered(child, "null")).toBe(false);
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
    link.post({ t: "ui-observability.message.journey-request", from: "host" });
    bus["receive"](
      { t: "ui-observability.message.journey-request", from: "child" },
      { link: "worker", origin: "same-origin", peer: worker },
    );
    bus["receive"](
      { t: "ui-observability.message.sampling-request", from: "child" },
      { link: "worker", origin: "same-origin", peer: worker },
    );
    bus["receive"](
      { t: "ui-observability.message.journey", from: "child", journey: null },
      { link: "worker", origin: "same-origin", peer: worker },
    );
    expect(worker.postMessage.mock.calls.map(([e]) => e.m.t)).toContain(
      "ui-observability.message.sampling",
    );
    expect(h.onJourneyRequest).toHaveBeenCalled();
    const n = worker.postMessage.mock.calls.length;
    detach();
    link.post({ t: "ui-observability.message.journey", from: "host", journey: null });
    expect(worker.postMessage).toHaveBeenCalledTimes(n);
    const second = bus.attachWorker(worker, { permissions: [] });
    bus.broadcastJourney(null);
    bus["links"].at(-1)!.post({ t: "ui-observability.message.journey-request", from: "host" });
    bus["links"]
      .at(-1)!
      .post({ t: "ui-observability.message.sampling", from: "host", to: "child", rules: null });
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
      {
        t: "ui-observability.message.welcome",
        from: "owner",
        to: "host",
        tabId: "tab",
        routingContextId: "A",
      },
      source,
    );
    expect(settle).not.toHaveBeenCalled();
    receive(
      {
        t: "ui-observability.message.welcome",
        from: "owner",
        to: "host",
        tabId: "tab",
        routingContextId: "A",
      },
      source,
    );
    expect(settle).toHaveBeenCalledWith(true);
    receive({ t: "ui-observability.message.security-context", from: "owner", id: "B" }, source);
    h.onSecurityContext.mockReturnValueOnce(false);
    receive({ t: "ui-observability.message.security-context", from: "owner", id: "C" }, source);
    const count = h.onSecurityContext.mock.calls.length;
    receive(
      { t: "ui-observability.message.security-context", from: "owner", id: "D" },
      { ...source, peer: {} },
    );
    receive({ t: "ui-observability.message.security-context", from: "forged", id: "D" }, source);
    expect(h.onSecurityContext).toHaveBeenCalledTimes(count);
    const child = {} as Window;
    bus.registerFrame(child, { origin: location.origin });
    bus.acceptDirect(
      { t: "ui-observability.message.hello", from: "host", tabId: "tab" },
      vi.fn(),
      child,
    );
    bus.acceptDirect(
      {
        t: "ui-observability.message.records",
        from: "child",
        records: [record()],
        routingContextId: "A",
      },
      vi.fn(),
      child,
    );
    expect(bus["upstream"].post).toHaveBeenCalledWith(
      expect.objectContaining({ t: "ui-observability.message.records" }),
    );
    receive(
      { t: "ui-observability.message.sampling", from: "owner", to: "host", rules: null },
      { ...source, peer: {} },
    );
    // A configured forwarder uses announce(), so it has no pending handshake promise.
    bus["awaitingWelcome"] = null;
    bus["ownerId"] = null;
    receive(
      {
        t: "ui-observability.message.welcome",
        from: "owner",
        to: "host",
        tabId: "tab",
        routingContextId: "A",
      },
      source,
    );
    receive({ t: "ui-observability.message.journey", from: "owner", journey: null }, source);
    expect(h.onJourney).toHaveBeenCalledWith(null);
    bus.destroy();
  });

  it("drops unregistered direct traffic and non-finite data, and expires named-source budgets", () => {
    const { bus, h, receive } = create();
    bus.acceptDirect({ t: "ui-observability.message.hello", from: "child", tabId: "tab" }, vi.fn());
    const m: BusMessage = {
      t: "ui-observability.message.records",
      from: "peer",
      records: [record()],
      routingContextId: "A",
    };
    for (let i = 0; i < BUS_MAX_TRACKED_SOURCES; i++) {
      receive(m, { link: "openfin", origin: "openfin", peer: `old-${String(i)}` });
    }
    const now = Date.now();
    // Every old source's second has ended, so a new name finds room.
    vi.spyOn(Date, "now").mockReturnValue(now + 1001);
    receive(m, { link: "openfin", origin: "openfin", peer: "new" });
    expect(h.onRecords).toHaveBeenCalledTimes(BUS_MAX_TRACKED_SOURCES + 1);
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
    iframe.srcdoc = "";
    document.body.append(iframe);
    const detach = registerFrame(iframe, { origin: location.origin });
    await vi.waitFor(() => {
      expect(runtime.busCanAccept(iframe.contentWindow!, location.origin)).toBe(true);
    });
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    dispatchEvent(
      new MessageEvent("message", {
        data: envelope({ t: "ui-observability.message.hello", from: "frame", tabId: "tab" }),
        source: iframe.contentWindow,
        origin: location.origin,
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        m: expect.objectContaining({ t: "ui-observability.message.welcome" }),
      }),
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

  it("lets a registered same-origin frame attach directly to the real runtime", async () => {
    configure(base);
    await flush();
    const runtime = rt();
    expect(runtime.protocol).toBe(BUS_PROTOCOL);

    const detach = registerFrame(window, { origin: location.origin });
    await vi.waitFor(() => {
      expect(runtime.busCanAccept(window, location.origin)).toBe(true);
    });
    const parent = { [Symbol.for("ui-observability.runtime")]: runtime } as unknown as Window &
      typeof globalThis;
    const parentSpy = vi.spyOn(window, "parent", "get").mockReturnValue(parent);
    const handler = vi.fn();

    expect(createDirectLink(vi.fn(), new Diagnostics(handler, 0))?.kind).toBe("direct");
    expect(handler).not.toHaveBeenCalled();

    parentSpy.mockRestore();
    detach();
  });

  it("lets a registered srcdoc frame attach directly to the real runtime, but not an opaque one", async () => {
    configure(base);
    await flush();
    const runtime = rt();
    const registered = location.origin;

    const detach = registerFrame(window, { origin: registered });
    await vi.waitFor(() => {
      expect(runtime.busCanAccept(window, registered)).toBe(true);
    });
    const parent = { [Symbol.for("ui-observability.runtime")]: runtime } as unknown as Window &
      typeof globalThis;
    const parentSpy = vi.spyOn(window, "parent", "get").mockReturnValue(parent);

    // A srcdoc frame reads "null" from location and its parent's origin from the origin global.
    vi.stubGlobal("location", { origin: "null" });
    vi.stubGlobal("origin", registered);
    expect(createDirectLink(vi.fn(), diag())?.kind).toBe("direct");

    // With both "null" the frame is opaque, and the real runtime refuses that origin.
    vi.stubGlobal("origin", "null");
    expect(createDirectLink(vi.fn(), diag())).toBeNull();

    // Put location back before the runtime's teardown reads it.
    vi.unstubAllGlobals();
    parentSpy.mockRestore();
    detach();
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
    listener(envelope({ t: "ui-observability.message.hello", from: "peer", tabId: "tab" }), "app");
    listener(
      envelope({ t: "ui-observability.message.hello", from: "peer", tabId: "tab" }),
      "app",
      "view",
    );
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
      { id: "B", routing: { transport: send.transport } },
      { pending: "retain" },
    );
    await rotateSecurityContext({ id: "A", routing: { transport: send.transport } });
    await rotateSecurityContext({ id: "C", routing: {} }, { pending: "flush" });
    expect(send.records()[0].body).toBe("buffered A");
    expect(send.batches()[0].routingContextId).toBe("A");
  });

  it("still shuts down cleanly when a concurrently awaited rotation rejects", async () => {
    configure(base);
    await flush();
    const change = rotateSecurityContext({ routing: { credentials: "invalid" as never } });
    // The call starts on a later microtask, so the shutdown in this task comes first.
    const rejected = expect(change).rejects.toThrow("The runtime has stopped.");
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
    configure({ ...base, minLevel: "FATAL", consoleOutput: true, redact: (r) => r });
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
    expect(post).toHaveBeenCalledWith({
      t: "ui-observability.message.security-context",
      from: "host",
      id: "B",
    });
    // A view that forwards doesn't send on the OpenFin link.
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
      { t: "ui-observability.message.security-context", from: "provider", id: "B" },
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
    // A realm without HTMLIFrameElement has no frame elements, so the value is the window.
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
    parentFrame.srcdoc = "";
    childFrame.srcdoc = "";
    document.body.append(parentFrame, childFrame);
    vi.spyOn(window, "parent", "get").mockReturnValue(
      parentFrame.contentWindow as Window & typeof globalThis,
    );
    const receive = vi.fn();
    const link = createChildrenLink(receive, [], diag())!;
    const hello = wrap({ t: "ui-observability.message.hello", from: "peer", tabId: "tab" });
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

  it("measures each outbound record once and fills a message to its byte limit", () => {
    const { bus, config } = create();
    const post = vi.fn();
    bus["upstream"] = { kind: "parent", post, close: vi.fn() };
    const two = new TextEncoder().encode(
      JSON.stringify({
        t: "ui-observability.message.records",
        from: "host",
        records: [record(), record()],
        routingContextId: "A",
      }),
    ).length;
    config.bus.maxRecordsPerMessage = null;
    config.bus.maxMessageBytes = two;
    const stringify = vi.spyOn(JSON, "stringify");
    bus.sendRecords([record(), record(), record()]);
    // One call for the empty envelope and one per record.
    expect(stringify).toHaveBeenCalledTimes(4);
    stringify.mockRestore();
    expect(post.mock.calls.map(([m]) => m.records.length)).toEqual([2, 1]);

    // Without a byte limit, the bus doesn't encode the records.
    post.mockClear();
    config.bus.maxMessageBytes = null;
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
    // Own undefined properties hide the prototype methods, and bare is still typed MemoryStorage.
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
      { id: "B", routing: { transport: send.transport } },
      { pending: "retain" },
    );
    await rotateSecurityContext({ id: "A", routing: { transport: send.transport } });
    await rt()["sender"]!["retry"]["drain"]();
    const bodies = send.records().map((r) => r.body);
    expect(bodies.filter((body) => body.startsWith("buffered"))).toHaveLength(5);
  });

  it("ends the old remote rules when it adopts a new owner context", async () => {
    configure({ ...base, sampling: { remote: true } });
    await flush();
    const runtime = rt();
    const adopt = (await runtime["constructBus"]())!["handlers"].onSecurityContext!;

    adopt("owner-A");
    applyRemote(runtime["remote"], runtime.config, { rules: { rates: {} }, ttlMs: 60000 });
    adopt("owner-B");

    expect(runtime["remote"].sampling).toBeNull();
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
    // The first owner id does not reset the session.
    adopt("owner-A");
    adopt("owner-B");
    expect(runtime.identity.sessionId).toBe("owner-session");
    // The stored session is the current session. The owner did not store a new one.
    adopt("owner-C");
    const minted = runtime.identity.sessionId;
    expect(minted).not.toBe("owner-session");
    localStorage.removeItem(SESSION_ID_KEY);
    adopt("owner-D");
    expect(runtime.identity.sessionId).not.toBe(minted);
  });
});

/**
 * Builds an owner bus with the default policies and context id "A".
 * @returns The bus, its config and its handlers.
 */
function makeBus() {
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
  return { bus, config, handlers };
}

describe("direct link, owner adoption and answer routing", () => {
  it("connects a same-origin child through the direct link under the default source policy", async () => {
    const owner = makeBus();
    owner.bus.registerFrame(window, { origin: location.origin });
    const host = {
      busAccept: (...args: Parameters<Bus["acceptDirect"]>) => {
        owner.bus.acceptDirect(...args);
      },
      busCanAccept: (source: Window, origin: string) => owner.bus.isRegistered(source, origin),
      protocol: BUS_PROTOCOL,
    };
    vi.spyOn(window, "parent", "get").mockReturnValue({
      [Symbol.for("ui-observability.runtime")]: host,
    } as unknown as Window & typeof globalThis);
    const childConfig = resolveConfig(
      { ...base, bus: { mode: "auto" }, securityContext: { id: "child" } },
      diag(),
    );
    const onSecurityContext = vi.fn((id: string) => {
      childConfig.securityContext.id = id;
      return true;
    });
    const child = new Bus(
      childConfig,
      diag(),
      { platform: "browser", isTopLevelDocument: false, isWorker: false, userAgent: "test" },
      "child",
      "tab",
      {
        onRecords: vi.fn(),
        onJourney: vi.fn(),
        onJourneyRequest: vi.fn(() => null),
        onTabConflict: vi.fn(),
        remote: { sampling: null },
        onSecurityContext,
      },
      { timeoutMs: 50, maxAttempts: 1 },
    );
    expect(await child.start()).toBe("forwarder");
    expect(onSecurityContext).toHaveBeenCalledWith("A");
    child.sendRecords([record()]);
    expect(owner.handlers.onRecords).toHaveBeenCalledTimes(1);
    child.destroy();
    owner.bus.destroy();
  });

  it("forwards to a parent from 0.9.5 to 0.12 only after that parent registers the frame", async () => {
    const owner = makeBus();
    // Releases 0.9.5 to 0.12 expose busCanAccept but no protocol field.
    const host = {
      busAccept: (...args: Parameters<Bus["acceptDirect"]>) => {
        owner.bus.acceptDirect(...args);
      },
      busCanAccept: (source: Window, origin: string) => owner.bus.isRegistered(source, origin),
    };
    vi.spyOn(window, "parent", "get").mockReturnValue({
      [Symbol.for("ui-observability.runtime")]: host,
    } as unknown as Window & typeof globalThis);
    const handler = vi.fn();

    // The parent's source policy still decides, so an unregistered frame gets no direct link.
    expect(createDirectLink(vi.fn(), new Diagnostics(handler, 0))).toBeNull();

    owner.bus.registerFrame(window, { origin: location.origin });
    const childConfig = resolveConfig(
      { ...base, bus: { mode: "auto" }, securityContext: { id: "child" } },
      diag(),
    );
    const child = new Bus(
      childConfig,
      new Diagnostics(handler, 0),
      { platform: "browser", isTopLevelDocument: false, isWorker: false, userAgent: "test" },
      "child",
      "tab",
      {
        onRecords: vi.fn(),
        onJourney: vi.fn(),
        onJourneyRequest: vi.fn(() => null),
        onTabConflict: vi.fn(),
        remote: { sampling: null },
        // The owner drops records from a child that hasn't taken the owner's context id.
        onSecurityContext: (id: string) => {
          childConfig.securityContext.id = id;
          return true;
        },
      },
      { timeoutMs: 50, maxAttempts: 1 },
    );

    expect(await child.start()).toBe("forwarder");
    expect(handler).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "bus.protocol_mismatch" }),
    );

    // The records reach the owner's handler, which is where the owner's redact runs.
    child.sendRecords([record()]);
    expect(owner.handlers.onRecords).toHaveBeenCalledTimes(1);
    child.destroy();
    owner.bus.destroy();
  });

  it("sends an owner id that a forwarder takes from a welcome to its own children", () => {
    const { bus } = makeBus();
    const post = vi.fn();
    bus["links"].push({ kind: "children", post, close: vi.fn() });
    bus["role"] = "forwarder";
    bus["upstream"] = { kind: "parent", post: vi.fn(), close: vi.fn() };
    const settle = vi.fn();
    bus["awaitingWelcome"] = { link: "parent", settle };
    bus["receive"](
      {
        t: "ui-observability.message.welcome",
        from: "owner",
        to: "host",
        tabId: "tab",
        routingContextId: "T",
      },
      { link: "parent", origin: location.origin, peer: {} },
    );
    expect(settle).toHaveBeenCalledWith(true);
    expect(post).toHaveBeenCalledWith({
      t: "ui-observability.message.security-context",
      from: "host",
      id: "T",
    });
    bus.destroy();
  });

  it("answers a hello only to the child that sent it", async () => {
    const { envelope: wrap } = await import("../src/models/bus");
    const { bus } = makeBus();
    const a = document.createElement("iframe");
    const b = document.createElement("iframe");
    a.srcdoc = "";
    b.srcdoc = "";
    document.body.append(a, b);
    bus.registerFrame(a, { origin: location.origin });
    bus.registerFrame(b, { origin: location.origin });
    const postA = vi.spyOn(a.contentWindow!, "postMessage");
    const postB = vi.spyOn(b.contentWindow!, "postMessage");
    const hello = (from: string, source: Window): void => {
      dispatchEvent(
        new MessageEvent("message", {
          data: wrap({ t: "ui-observability.message.hello", from, tabId: "tab" }),
          source,
          origin: location.origin,
        }),
      );
    };
    hello("b", b.contentWindow!);
    hello("a", a.contentWindow!);
    expect(postB).toHaveBeenCalledTimes(1);
    expect(postA).toHaveBeenCalledTimes(1);
    expect(postA.mock.calls[0][0]).toMatchObject({
      m: { t: "ui-observability.message.welcome", to: "a" },
    });
    bus.destroy();
  });

  it("starts a new rate window when the clock moves back", () => {
    const { bus, config, handlers } = makeBus();
    config.bus.maxMessagesPerSecond = 1;
    const peer = {} as Window;
    bus.registerFrame(peer, { origin: location.origin });
    const m: BusMessage = {
      t: "ui-observability.message.records",
      from: "peer",
      records: [record()],
      routingContextId: "A",
    };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    bus.acceptDirect(m, vi.fn(), peer);
    bus["receive"](m, { link: "openfin", origin: "openfin", peer: "view" });
    clock.mockReturnValue(now - 3_600_000);
    bus.acceptDirect(m, vi.fn(), peer);
    bus["receive"](m, { link: "openfin", origin: "openfin", peer: "view" });
    expect(handlers.onRecords).toHaveBeenCalledTimes(4);
    bus.destroy();
  });

  it("binds a registered origin under the trusted-origin policy", () => {
    const { bus, config } = makeBus();
    config.bus.sourcePolicy = "trusted-origin";
    const popup = {} as Window;
    bus.registerFrame(popup, { origin: "https://partner.example" });
    expect(bus.isRegistered(popup, "https://partner.example")).toBe(true);
    expect(bus.isRegistered(popup, location.origin)).toBe(false);
    bus.destroy();
  });
});

describe("rotation delivery limits and early configuration", () => {
  it("reads all stored IndexedDB batches with isolation off", async () => {
    const { IndexedDbStorage } = await import("../src/storage/indexeddb-storage");
    const store = new IndexedDbStorage(
      "unbounded-take",
      { maxBatches: 5, maxAgeMs: 60000, maxAttempts: 5 },
      diag(),
    );
    await store.save(batch("A"));
    const takeOldest = store["db"].takeOldest.bind(store["db"]);
    // A browser refuses a getAll() count above 2^32 - 1. fake-indexeddb does not, so emulate it.
    vi.spyOn(store["db"], "takeOldest").mockImplementation((limit: number) =>
      limit > 0xffffffff
        ? Promise.reject(new TypeError("The count is outside the unsigned long range."))
        : takeOldest(limit),
    );
    const storage = new ContextStorage(store, { id: "B", isolation: false });
    expect((await storage.take(Number.MAX_SAFE_INTEGER)).map((b) => b.id)).toEqual(["A"]);
    await store.close();
  });

  it("carries a stored backlog larger than the buffer budget through storage", async () => {
    const send = createMemoryTransport();
    send.respondWith(503);
    const onDrop = vi.fn();
    configure({ ...base, transport: send.transport, securityContext: { id: "A" }, onDrop });
    await flush();
    for (let i = 0; i < 5; i++) {
      getLogger("backlog").info(`stored ${String(i)}`);
    }
    await flush();
    expect((await getHealth()).delivery.stored).toBeGreaterThan(0);
    configure({ buffering: { maxPendingRecords: 2 } });
    send.clear();
    send.respondWith(204);
    await rotateSecurityContext(
      { id: "B", routing: { transport: send.transport } },
      { pending: "carry" },
    );
    await rt()["sender"]!["retry"]["drain"]();
    await flush();
    expect(onDrop).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "buffer_full" }));
    expect(send.records().filter((r) => r.body.startsWith("stored"))).toHaveLength(5);
    expect(send.batches().every((b) => b.routingContextId === "B")).toBe(true);
    // No stored batch to carry, then no new sender to take the stored batches.
    await rotateSecurityContext(
      { id: "C", routing: { transport: send.transport } },
      { pending: "carry" },
    );
    send.respondWith(503);
    getLogger("backlog").info("stored in C");
    await flush();
    getLogger("backlog").info("buffered in C");
    onDrop.mockClear();
    // A context without a sender can't take the stored batch, so it stays parked under C.
    await rotateSecurityContext({ id: "D", routing: {} }, { pending: "carry" });
    const parked = await rt()["memoryStorage"]!.take(10);
    expect(parked.map((b) => [b.routingContextId, b.records[0].body])).toEqual([
      ["C", "stored in C"],
    ]);
    await flush();
    expect(onDrop).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "security_context" }),
    );
  });

  it("drops a new record when each held record is in flight", async () => {
    let release!: (response: { status: number }) => void;
    const hang = vi.fn(
      () =>
        new Promise<{ status: number }>((resolve) => {
          release = resolve;
        }),
    );
    const onDrop = vi.fn();
    configure({ ...base, transport: hang, onDrop, buffering: { maxPendingRecords: 1 } });
    await flush();
    getLogger("orders").info("in flight");
    void flush();
    await vi.waitFor(() => {
      expect(hang).toHaveBeenCalled();
    });
    // The record in flight can't be removed, so the new record has no space.
    getLogger("orders").info("refused");
    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "buffer_full", records: 1 }),
      );
    });
    // Complete the request so shutdown doesn't wait for the request timeout.
    release({ status: 204 });
  });

  it("retires startup records when the owner changes its id before startup completes", async () => {
    const { JourneyEngine } = await import("../src/core/journey");
    let release!: () => void;
    vi.spyOn(JourneyEngine.prototype, "bootstrap").mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const onDrop = vi.fn();
    configure({ ...base, onDrop });
    const runtime = rt();
    const adopt = (await runtime["constructBus"]())!["handlers"].onSecurityContext!;
    getLogger("boot").info("startup record");
    adopt("owner-A");
    expect(runtime["bootBuffer"].length).toBe(1);
    const session = runtime.identity.sessionId;
    adopt("owner-B");
    expect(runtime["bootBuffer"].length).toBe(0);
    expect(runtime.identity.sessionId).not.toBe(session);
    release();
    await flush();
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "security_context", records: 1 }),
    );
  });

  it("treats an id from the first configure after an implicit start as explicit", async () => {
    getLogger("early").info("before configure");
    configure({ ...base, securityContext: { id: "explicit" } });
    await flush();
    const bus = (await rt()["constructBus"]())!;
    expect(bus["handlers"].onSecurityContext!("owner")).toBe(false);
    expect((await getHealth()).issues).toContain("security.context_mismatch");
  });

  it("accepts a storage namespace in the first configure after an implicit start", () => {
    getLogger("early").info("before configure");
    configure({ ...base, storage: { namespace: "orders" } });
    expect(rt().config.storage.namespace).toBe("orders");
  });

  it("keeps a lock change that the app makes during a rotation", async () => {
    const hang = vi.fn(() => new Promise<{ status: number }>(() => undefined));
    configure({ ...base, transport: hang, securityContext: { id: "A" } });
    getLogger("orders").info("old");
    void flush();
    await vi.waitFor(() => {
      expect(hang).toHaveBeenCalled();
    });
    const rotating = rotateSecurityContext(
      { id: "B", routing: { transport: createMemoryTransport().transport } },
      { pending: "flush", timeoutMs: 50 },
    );
    // Wait until the rotation reads its next settings and waits for the old flush.
    await new Promise((resolve) => setTimeout(resolve, 10));
    setConfigurationLocked(true);
    await rotating;
    expect(rt().config.lockConfiguration).toBe(true);
  });

  it("drops only a record that is larger than the byte budget", async () => {
    const send = createMemoryTransport();
    const onDrop = vi.fn();
    configure({ ...base, transport: send.transport, onDrop, buffering: { maxPendingBytes: 3000 } });
    await flush();
    getLogger("orders").info("small");
    getLogger("orders").info("x".repeat(5000));
    await flush();
    expect(send.records().map((r) => r.body)).toContain("small");
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "buffer_full", records: 1 }),
    );
  });

  it("rejects a rotation with a context getter that throws, and stops the old sender", async () => {
    const send = createMemoryTransport();
    configure({ ...base, transport: send.transport, securityContext: { id: "A" } });
    await flush();
    const context = Object.defineProperty({}, "user", {
      enumerable: true,
      get(): never {
        throw new Error("getter failed");
      },
    });
    await expect(
      rotateSecurityContext({ id: "B", routing: { transport: send.transport }, context }),
    ).rejects.toThrow("getter failed");
    expect(rt().config.securityContext.id).toBe("A");
    getLogger("orders").info("after the rejection");
    await flush();
    expect(send.records().map((r) => r.body)).not.toContain("after the rejection");
  });

  it("reports forwarded records that arrive during a rotation", async () => {
    const onDrop = vi.fn();
    configure({
      ...base,
      transport: createMemoryTransport().transport,
      securityContext: { id: "A" },
      onDrop,
      // The sender masks forwarded action names, so onDrop must report only the masked name.
      redact: (r) => ({ ...r, body: "[masked]" }),
    });
    await flush();
    const action = { ...record(), body: "SECRET_ACTION", attributes: { "log.type": "action" } };
    const rotating = rotateSecurityContext({ id: "B", routing: {} });
    rt()["ingestForwarded"]([action, { malformed: true }]);
    await rotating;
    await flush();
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "security_context", records: 1, actions: ["[masked]"] }),
    );
    // A late bus message after shutdown changes nothing and reports nothing.
    const runtime = rt();
    await shutdown();
    onDrop.mockClear();
    runtime["ingestForwarded"]([record()]);
    await Promise.resolve();
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe("refused owner identity", () => {
  it("keeps the physical owner after a refused welcome and accepts its later matching id", () => {
    const { bus, handlers, config } = makeBus();
    // This frame has the explicit id "A" and refuses every other owner id.
    handlers.onSecurityContext.mockImplementation((id: string) => id === config.securityContext.id);
    bus["role"] = "forwarder";
    bus["upstream"] = { kind: "parent", post: vi.fn(), close: vi.fn() };
    const settle = vi.fn();
    bus["awaitingWelcome"] = { link: "parent", settle };
    const source: MessageSource = { link: "parent", origin: location.origin, peer: {} };
    bus["receive"](
      {
        t: "ui-observability.message.welcome",
        from: "owner",
        to: "host",
        tabId: "tab",
        routingContextId: "Y",
      },
      source,
    );
    expect(settle).not.toHaveBeenCalled();
    expect(bus["ownerId"]).toBe("owner");
    // The owner rotates to this frame's id. The frame takes the update from that owner only.
    bus["receive"](
      { t: "ui-observability.message.security-context", from: "owner", id: "A" },
      source,
    );
    expect(handlers.onSecurityContext).toHaveBeenLastCalledWith("A");
    handlers.onSecurityContext.mockClear();
    bus["receive"](
      { t: "ui-observability.message.security-context", from: "other", id: "A" },
      source,
    );
    expect(handlers.onSecurityContext).not.toHaveBeenCalled();
    bus.destroy();
  });
});

describe("nested frames, carry timing and early encoding", () => {
  it("welcomes the children of a forwarder that knows its owner and relays their records", () => {
    const { bus } = makeBus();
    const upstream = { kind: "direct" as const, post: vi.fn(), close: vi.fn() };
    bus["role"] = "forwarder";
    bus["upstream"] = upstream;
    const child = {} as Window;
    bus.registerFrame(child, { origin: location.origin });
    const reply = vi.fn();
    // Without a known owner, the forwarder does not own its children yet.
    bus.acceptDirect(
      { t: "ui-observability.message.hello", from: "grandchild", tabId: "tab" },
      reply,
      child,
    );
    expect(reply).not.toHaveBeenCalled();
    bus["ownerId"] = "owner";
    bus.acceptDirect(
      { t: "ui-observability.message.hello", from: "grandchild", tabId: "tab" },
      reply,
      child,
    );
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        t: "ui-observability.message.welcome",
        to: "grandchild",
        routingContextId: "A",
      }),
      expect.objectContaining({ link: "direct" }),
    );
    bus.acceptDirect(
      {
        t: "ui-observability.message.records",
        from: "grandchild",
        records: [record()],
        routingContextId: "A",
      },
      reply,
      child,
    );
    expect(upstream.post).toHaveBeenCalledWith(
      expect.objectContaining({ t: "ui-observability.message.records" }),
    );
    bus.destroy();
  });

  it("sends no temporary id while it waits for its own owner, then sends the final id", () => {
    const { bus } = makeBus();
    const children = { kind: "children" as const, post: vi.fn(), close: vi.fn() };
    bus["links"].push(children);
    bus["awaitingWelcome"] = { link: "parent", settle: vi.fn() };
    const child = {} as Window;
    bus.registerFrame(child, { origin: location.origin });
    const reply = vi.fn();
    bus.acceptDirect(
      { t: "ui-observability.message.hello", from: "child", tabId: "tab" },
      reply,
      child,
    );
    expect(reply.mock.calls[0][0]).toMatchObject({
      t: "ui-observability.message.welcome",
      routingContextId: undefined,
    });
    bus.acceptDirect(
      {
        t: "ui-observability.message.records",
        from: "child",
        records: [record()],
        routingContextId: "child",
      },
      reply,
      child,
    );
    expect(reply.mock.calls.map(([m]) => m.t)).toEqual(["ui-observability.message.welcome"]);
    // The role is final, so the children link and the direct child get the final id right away.
    bus["awaitingWelcome"] = null;
    bus["announce"]();
    const final = { t: "ui-observability.message.security-context", from: "host", id: "A" };
    expect(children.post).toHaveBeenCalledWith(final);
    expect(reply).toHaveBeenLastCalledWith(final, expect.objectContaining({ link: "direct" }));
    // A child that still sends an old id gets the id again in the answer.
    bus.acceptDirect(
      {
        t: "ui-observability.message.records",
        from: "child",
        records: [record()],
        routingContextId: "child",
      },
      reply,
      child,
    );
    expect(reply.mock.calls.map(([m]) => m.t)).toEqual([
      "ui-observability.message.welcome",
      "ui-observability.message.security-context",
      "ui-observability.message.security-context",
    ]);
    bus.destroy();
  });

  it("reports a registered frame that speaks from another origin", async () => {
    const { envelope: wrap } = await import("../src/models/bus");
    const { bus, config } = makeBus();
    config.bus.sourcePolicy = "trusted-origin";
    const frame = document.createElement("iframe");
    frame.srcdoc = "";
    document.body.append(frame);
    bus.registerFrame(frame, { origin: "https://wrong.example" });
    dispatchEvent(
      new MessageEvent("message", {
        data: wrap({ t: "ui-observability.message.hello", from: "frame", tabId: "tab" }),
        source: frame.contentWindow,
        origin: location.origin,
      }),
    );
    expect(bus["diagnostics"].snapshot()["bus.untrusted_origin"]).toBe(1);
    bus.destroy();
  });

  it("doesn't call an unregistered same-origin child untrusted when this parent is a srcdoc frame", async () => {
    const { envelope: wrap } = await import("../src/models/bus");
    const { bus } = makeBus();
    const realOrigin = location.origin;
    const frame = document.createElement("iframe");
    frame.srcdoc = "";
    document.body.append(frame);
    bus["ensureChildrenLink"]();
    // A srcdoc parent's location.origin reads "null", and its origin global holds the real one.
    vi.stubGlobal("location", { origin: "null" });
    vi.stubGlobal("origin", realOrigin);

    dispatchEvent(
      new MessageEvent("message", {
        data: wrap({ t: "ui-observability.message.hello", from: "frame", tabId: "tab" }),
        source: frame.contentWindow,
        origin: realOrigin,
      }),
    );

    // The default policy wants a registration, so the bus counts the message. Its origin is fine.
    expect(bus["diagnostics"].snapshot()["bus.rejected_message"]).toBe(1);
    expect(bus["diagnostics"].snapshot()["bus.untrusted_origin"]).toBeUndefined();
    bus.destroy();
  });

  it("delivers logger calls while carry stores old batches again, without duplicates", async () => {
    const { Sender } = await import("../src/core/sender");
    const send = createMemoryTransport();
    send.respondWith(503);
    configure({ ...base, transport: send.transport, securityContext: { id: "A" } });
    await flush();
    getLogger("carry").info("stored in A");
    await flush();
    const adopt = Sender.prototype.adopt;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(Sender.prototype, "adopt").mockImplementation(async function (
      this: SenderInstance,
      ...args
    ) {
      await gate;
      return adopt.apply(this, args);
    });
    const carrying = rotateSecurityContext(
      { id: "B", routing: { transport: send.transport } },
      { pending: "carry" },
    );
    await vi.waitFor(() => {
      expect(Sender.prototype.adopt).toHaveBeenCalled();
    });
    getLogger("carry").info("during carry");
    release();
    await carrying;
    // The same batch id replaced the old copy, and the new destination starts with no attempts.
    const stored = await rt()["memoryStorage"]!.take(10);
    expect(stored.map((b) => [b.routingContextId, b.attempts])).toEqual([["B", 0]]);
    expect(rt().diagnostics.snapshot()["record.dropped_during_rotation"]).toBeUndefined();
    send.respondWith(204);
    await flush();
    await rt()["sender"]!["retry"]["drain"]();
    expect(send.records().map((r) => r.body)).toEqual(
      expect.arrayContaining(["during carry", "stored in A"]),
    );
  });

  it("drops only an unencodable record when the byte budget is off", async () => {
    const send = createMemoryTransport();
    const onDrop = vi.fn();
    configure({
      ...base,
      transport: send.transport,
      onDrop,
      buffering: { maxPendingBytes: null },
    });
    await flush();
    const resource: Record<string, unknown> = {};
    resource.self = resource;
    rt()["sender"]!["pipeline"].push({ ...record(), body: "circular", resource });
    getLogger("orders").info("kept");
    await flush();
    expect(send.records().map((r) => r.body)).toContain("kept");
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unserializable", records: 1 }),
    );
  });
});

describe("configurable click action attribute and namespaced locks", () => {
  it("names a click by a configured action attribute and keeps it on an invalid change", async () => {
    const { InteractionCapture } = await import("../src/capture/interactions");
    configure({
      ...base,
      capture: {
        errors: false,
        rejections: false,
        interactions: { actionAttribute: "data-testid" },
      },
    });
    const runtime = rt();
    const capture = new InteractionCapture({
      config: runtime.config,
      diagnostics: diag(),
      breadcrumbs: runtime.breadcrumbs,
      tracing: runtime.tracing,
    } as never);
    capture.install();
    document.body.innerHTML =
      '<button data-testid="submit-order" data-observability-action="other"><span>Submit</span></button>';
    document.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(runtime.breadcrumbs.snapshot().at(-1)).toMatchObject({
      category: "click",
      message: "submit-order",
    });
    configure({ capture: { interactions: { actionAttribute: "data test" } } });
    expect(runtime.config.capture.interactions).toMatchObject({ actionAttribute: "data-testid" });
    capture.uninstall();
  });

  it("names the retry and emergency locks by the storage namespace", async () => {
    const { lockName } = await import("../src/utils/lock");
    const { RetryEngine } = await import("../src/transport/retry-engine");
    expect(lockName("ui-observability.drain", "")).toBe("ui-observability.drain");
    const request = vi.fn(
      (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) =>
        callback({}),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    await drainEmergencyQueue(memory(), diag(), () => true, "orders app");
    const retry = new RetryEngine(
      memory(),
      { send: vi.fn(), throttledForMs: () => 0 },
      diag(),
      resolveConfig({ ...base, storage: { namespace: "orders app" } }, diag()),
    );
    await retry["drain"]();
    retry.stop();
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      "ui-observability.emergency:orders%20app",
      "ui-observability.drain:orders%20app",
    ]);
  });
});

/**
 * Starts a child bus in this window, with the owner bus acting as a same-origin parent's runtime.
 * @param owner The parent's bus.
 * @param config The child's resolved config.
 * @param onSecurityContext The child's handler for an owner id.
 * @returns The started child bus.
 */
async function startDirectChild(
  owner: Bus,
  config: ResolvedConfig,
  onSecurityContext: (id: string) => boolean,
): Promise<Bus> {
  owner.registerFrame(window, { origin: location.origin });
  const host = {
    busAccept: (...args: Parameters<Bus["acceptDirect"]>) => {
      owner.acceptDirect(...args);
    },
    busCanAccept: (source: Window, origin: string) => owner.isRegistered(source, origin),
    protocol: BUS_PROTOCOL,
  };
  vi.spyOn(window, "parent", "get").mockReturnValue({
    [Symbol.for("ui-observability.runtime")]: host,
  } as unknown as Window & typeof globalThis);
  const child = new Bus(
    config,
    diag(),
    { platform: "browser", isTopLevelDocument: false, isWorker: false, userAgent: "test" },
    "child",
    "tab",
    {
      onRecords: vi.fn(),
      onJourney: vi.fn(),
      onJourneyRequest: vi.fn(() => null),
      onTabConflict: vi.fn(),
      remote: { sampling: null },
      onSecurityContext,
    },
    { timeoutMs: 50, maxAttempts: 1 },
  );
  await child.start();
  return child;
}

describe("rotation reach on the direct link", () => {
  it("clears the context mismatch of an explicit direct child when the owner rotates to its id", async () => {
    configure({ ...base, securityContext: { id: "B" } });
    await flush();
    const runtime = rt();
    const adopt = (await runtime["constructBus"]())!["handlers"].onSecurityContext!;
    runtime.config.bus.mode = "auto";
    const owner = makeBus();
    const child = await startDirectChild(owner.bus, runtime.config, adopt);
    expect((await getHealth()).issues).toContain("security.context_mismatch");

    owner.config.securityContext.id = "B";
    owner.bus.rotateContext();

    expect((await getHealth()).issues).not.toContain("security.context_mismatch");
    child.destroy();
    owner.bus.destroy();
  });

  it("sends a rotated id to a direct child right away", async () => {
    const owner = makeBus();
    const config = resolveConfig({ ...base, bus: { mode: "auto" } }, diag());
    const child = await startDirectChild(owner.bus, config, (id) => {
      config.securityContext.id = id;
      return true;
    });
    expect(config.securityContext.id).toBe("A");

    owner.config.securityContext.id = "C";
    owner.bus.rotateContext();

    expect(config.securityContext.id).toBe("C");
    // The child sends with the new id, and the owner doesn't refuse this first batch.
    child.sendRecords([record()]);
    expect(owner.handlers.onRecords).toHaveBeenCalledTimes(1);
    child.destroy();
    owner.bus.destroy();
  });

  it("drops a direct child that is closed, freed or no longer registered", () => {
    const { bus } = makeBus();
    const [removed, closesLate, unregistered, freed, stays] = [{}, {}, {}, {}, {}] as Window[];
    const unregister = bus.registerFrame(unregistered, { origin: location.origin });
    for (const peer of [removed, closesLate, freed, stays]) {
      bus.registerFrame(peer, { origin: location.origin });
    }
    const reply = vi.fn();
    const hello = (peer: Window): void => {
      bus.acceptDirect(
        { t: "ui-observability.message.hello", from: "child", tabId: "tab" },
        reply,
        peer,
      );
    };
    const close = (peer: Window): void => {
      Object.defineProperty(peer, "closed", { value: true });
    };
    hello(removed);
    hello(closesLate);
    hello(unregistered);
    hello(freed);

    // A closed frame leaves the map when the next child speaks.
    close(removed);
    hello(stays);
    expect(bus["directReplies"].has(removed)).toBe(false);

    // The rotation drops the other children that can't get the id.
    close(closesLate);
    unregister();
    bus["directReplies"].set(freed, { deref: () => undefined } as WeakRef<Receive>);
    reply.mockClear();
    bus.rotateContext();

    expect([...bus["directReplies"].keys()]).toEqual([stays]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      { t: "ui-observability.message.security-context", from: "host", id: "A" },
      { link: "direct", origin: "same-origin", peer: stays },
    );
    bus.destroy();
    expect(bus["directReplies"].size).toBe(0);
  });

  it("sends a rotated id to its direct children when this parent is a srcdoc frame", () => {
    const { bus, config } = makeBus();
    const realOrigin = location.origin;
    const [registered, trusted] = [{}, {}] as Window[];
    bus.registerFrame(registered, { origin: realOrigin });
    // A srcdoc parent's location.origin reads "null", and its origin global holds the real one.
    vi.stubGlobal("location", { origin: "null" });
    vi.stubGlobal("origin", realOrigin);
    config.bus.sourcePolicy = "trusted-origin";
    const reply = vi.fn();
    for (const peer of [registered, trusted]) {
      bus.acceptDirect(
        { t: "ui-observability.message.hello", from: "child", tabId: "tab" },
        reply,
        peer,
      );
    }

    reply.mockClear();
    bus.rotateContext();

    // Without the real origin, both children keep the old id and their next batch is dropped.
    expect([...bus["directReplies"].keys()]).toEqual([registered, trusted]);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith(
      { t: "ui-observability.message.security-context", from: "host", id: "A" },
      { link: "direct", origin: "same-origin", peer: trusted },
    );
    bus.destroy();
  });

  it("sends the id to the next direct child when one reply throws", () => {
    const { bus } = makeBus();
    const [broken, working] = [{}, {}] as Window[];
    bus.registerFrame(broken, { origin: location.origin });
    bus.registerFrame(working, { origin: location.origin });
    // A records message with the current id gets no answer. Only the rotation calls the replies.
    const records: BusMessage = {
      t: "ui-observability.message.records",
      from: "child",
      records: [record()],
      routingContextId: "A",
    };
    const fail = vi.fn(() => {
      throw new Error("freed document");
    });
    const reply = vi.fn();
    bus.acceptDirect(records, fail, broken);
    bus.acceptDirect(records, reply, working);

    bus.rotateContext();

    expect(fail).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ t: "ui-observability.message.security-context" }),
      expect.objectContaining({ peer: working }),
    );
    expect(bus["diagnostics"].snapshot()["bus.send_failed"]).toBe(1);
    bus.destroy();
  });
});

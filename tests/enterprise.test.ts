import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configure,
  flush,
  getLogger,
  getHealth,
  getDiagnosticCounters,
  rotateSecurityContext,
  setConfigurationLocked,
  setContext,
  shutdown,
  registerFrame,
  registerWorker,
} from "../src/index";
import { ObservabilityRuntime } from "../src/core/runtime";
import { InteractionCapture } from "../src/capture/interactions";
import { Bus } from "../src/bus/bus";
import { envelope } from "../src/models/bus";
import type { BusMessage, MessageSource } from "../src/models/bus";
import type { LogRecord } from "../src/models/log-record";
import type { TransportRequest, ObservabilityConfig } from "../src/models/config";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";

const rt = (): ObservabilityRuntime => ObservabilityRuntime.current()!;
const transport = () =>
  vi.fn<(r: TransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 204 });
const base: Partial<ObservabilityConfig> = {
  serviceName: "test",
  endpoint: "https://a.example/logs",
  storage: "localstorage",
  identity: "memory",
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
  securityContext: { id: "A" },
};
const record = (): LogRecord => ({
  timeUnixNano: "123",
  traceId: "",
  spanId: "",
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "hello",
  attributes: {},
  resource: {},
});

afterEach(async () => {
  await shutdown();
});

describe("application-owned privacy policies", () => {
  it("uses action ids, handles nested SVG clicks, and excludes regions by default", async () => {
    configure({
      ...base,
      endpoint: null,
      capture: { errors: false, rejections: false, interactions: true },
    });
    const capture = new InteractionCapture({
      config: rt().config,
      diagnostics: rt().diagnostics,
      tracing: rt().tracing,
      breadcrumbs: rt().breadcrumbs,
    } as never);
    capture.install();
    document.body.innerHTML =
      '<button data-observability-action="submit"><svg><path /></svg>Client account 123</button><div data-observability-ignore><button id="ignore">Secret</button></div>';
    document.querySelector("path")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const before = rt().tracing.resolve().traceId;
    document.querySelector("#ignore")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rt().breadcrumbs.snapshot()).toEqual([
      expect.objectContaining({ message: "submit", data: undefined }),
    ]);
    expect(rt().tracing.resolve().traceId).toBe(before);
    capture.uninstall();
    await flush();
  });

  it("allows capture inside excluded regions and bounds explicitly enabled text", () => {
    configure({
      ...base,
      endpoint: null,
      capture: {
        errors: false,
        rejections: false,
        interactions: { text: true, selector: true, ignoreSelector: null, maxTextChars: 4 },
      },
    });
    const capture = new InteractionCapture({
      config: rt().config,
      diagnostics: rt().diagnostics,
      tracing: rt().tracing,
      breadcrumbs: rt().breadcrumbs,
    } as never);
    capture.install();
    document.body.innerHTML =
      '<div data-observability-ignore><button id="inside">Internal</button></div>';
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rt().breadcrumbs.snapshot()[0]).toMatchObject({
      message: "unknown-click",
      data: { text: "Inte", selector: "#inside" },
    });
    capture.uninstall();
  });

  it("redacts sampled-out console output and breadcrumbs without sending the candidate", async () => {
    const send = transport();
    const redact = vi.fn((r: LogRecord) => ({ ...r, body: "[redacted]", attributes: {} }));
    configure({ ...base, transport: send, console: true, sampling: { defaultRate: 0 }, redact });
    const write = vi.spyOn(console, "info").mockImplementation(() => undefined);
    getLogger("orders").info("SECRET", { token: "SECRET" });
    await flush();
    expect(JSON.stringify(write.mock.calls)).not.toContain("SECRET");
    expect(rt().breadcrumbs.snapshot()[0].message).toBe("[redacted]");
    expect(redact).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("runs hooks for a sampled-out record only when a breadcrumb keeps it", () => {
    const redact = vi.fn((r: LogRecord) => r);
    configure({
      ...base,
      endpoint: null,
      console: false,
      sampling: { defaultRate: 0 },
      redact,
      capturePolicy: { breadcrumbs: 0 },
    });
    getLogger("orders").info("no breadcrumb");
    expect(redact).not.toHaveBeenCalled();
    configure({ capturePolicy: { breadcrumbs: 50 } });
    getLogger("orders").logMetric("orders.count", 1);
    expect(redact).not.toHaveBeenCalled();
    getLogger("orders").info("breadcrumb");
    expect(redact).toHaveBeenCalledTimes(1);
    expect(
      rt()
        .breadcrumbs.snapshot()
        .map((crumb) => crumb.message),
    ).toContain("breadcrumb");
  });

  it.each(["null", "throw", "malformed"])(
    "suppresses console output when a sanitizer returns %s",
    async (mode) => {
      configure({
        ...base,
        endpoint: null,
        console: true,
        minLevel: "FATAL",
        redact: () => {
          if (mode === "throw") throw new Error("failed");
          return mode === "null" ? null : ({} as LogRecord);
        },
      });
      const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
      getLogger("orders").error("SECRET", new Error("SECRET"));
      await flush();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("allows raw output when no processor or redactor is configured", () => {
    configure({ ...base, endpoint: null, console: true });
    const write = vi.spyOn(console, "info").mockImplementation(() => undefined);
    getLogger("internal").info("internal detail");
    expect(JSON.stringify(write.mock.calls)).toContain("internal detail");
  });
});

describe("security context delivery", () => {
  it.each(["discard", "flush", "retain", "carry"] as const)(
    "implements the %s queue policy",
    async (pending) => {
      const a = transport().mockResolvedValue({ status: 503 });
      const b = transport();
      configure({ ...base, transport: a });
      setContext("old-user", "A");
      getLogger("orders").info("A record");
      await flush();
      expect((await getHealth()).stored).toBe(1);
      await rotateSecurityContext(
        { id: "B", delivery: { transport: b }, context: { tenant: "B" } },
        { pending },
      );
      expect(rt().context.getAll()).toEqual({ tenant: "B" });
      expect(rt().breadcrumbs.snapshot()).toEqual([]);
      getLogger("orders").info("B record");
      await flush();
      // Carried stored batches wait in storage under the new id. The retry engine sends them.
      await rt()["sender"]!["retry"]["drain"]();
      const bodies = b.mock.calls.flatMap(([r]) => r.records.map((r) => r.body));
      expect(bodies).toContain("B record");
      expect(bodies.includes("A record")).toBe(pending === "carry");
      expect(b.mock.calls.every(([r]) => r.routingContextId === "B")).toBe(true);
      await rotateSecurityContext(
        { id: "A", delivery: { transport: a.mockResolvedValue({ status: 204 }) } },
        { pending: "retain" },
      );
      a.mockClear();
      await rt()["sender"]!["retry"]["drain"]();
      expect(a.mock.calls.flatMap(([r]) => r.records.map((r) => r.body)).includes("A record")).toBe(
        pending === "retain",
      );
    },
  );

  it("cancels a delayed header lookup before it can send under the next identity", async () => {
    let release!: (headers: Record<string, string>) => void;
    const headers = vi.fn(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          release = resolve;
        }),
    );
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    configure({ ...base, headers, compression: "none" });
    getLogger("orders").info("old");
    const oldFlush = flush();
    await vi.waitFor(() => {
      expect(headers).toHaveBeenCalled();
    });
    await rotateSecurityContext({
      id: "B",
      delivery: { endpoint: "https://b.example/logs", headers: { Authorization: "B" } },
    });
    release({ Authorization: "A" });
    await oldFlush;
    getLogger("orders").info("new");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://b.example/logs");
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('"old"');
  });

  it("bounds flush, aborts custom sends and drops calls during rotation", async () => {
    let signal: AbortSignal | undefined;
    const a = vi.fn((r: TransportRequest) => {
      signal = r.signal;
      return new Promise<{ status: number }>(() => undefined);
    });
    configure({ ...base, transport: a });
    getLogger("orders").info("old");
    const oldFlush = flush();
    await vi.waitFor(() => {
      expect(a).toHaveBeenCalled();
    });
    const next = transport();
    const rotating = rotateSecurityContext(
      { id: "B", delivery: { transport: next } },
      { pending: "flush", timeoutMs: 5 },
    );
    getLogger("orders").info("during rotation");
    await rotating;
    await oldFlush;
    expect(signal?.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("parks persisted records across reloads until their explicit context returns", async () => {
    const a = transport().mockResolvedValue({ status: 503 });
    configure({ ...base, transport: a });
    getLogger("orders").info("offline A");
    await flush();
    await shutdown();
    const b = transport();
    configure({ ...base, securityContext: { id: "B" }, transport: b });
    await flush();
    await rt()["sender"]!["retry"]["drain"]();
    expect(b).not.toHaveBeenCalled();
    await rotateSecurityContext({
      id: "A",
      delivery: { transport: a.mockResolvedValue({ status: 204 }) },
    });
    a.mockClear();
    await rt()["sender"]!["retry"]["drain"]();
    expect(a.mock.calls[0][0].records[0].body).toBe("offline A");
  });

  it("rejects mutable routing by default but supports an explicit isolation opt-out", async () => {
    configure({ ...base, transport: transport() });
    await flush();
    configure({ endpoint: "https://b.example/logs" });
    expect(rt().config.endpoint).toBe(base.endpoint);
    configure({ securityContext: { isolation: false } });
    configure({ endpoint: "https://b.example/logs" });
    expect(rt().config.endpoint).toBe("https://b.example/logs");
  });

  it("keeps refused delivery values and applies the other settings of the same call", async () => {
    configure({ ...base, transport: transport() });
    await flush();
    const before = getDiagnosticCounters()["config.invalid"] ?? 0;
    // An unset environment variable gives undefined. It keeps the endpoint. It is not a change.
    configure({ endpoint: undefined, minLevel: "WARN" });
    expect(rt().config.minLevel).toBe("WARN");
    expect(getDiagnosticCounters()["config.invalid"] ?? 0).toBe(before);
    configure({
      endpoint: "https://b.example/logs",
      securityContext: { id: "B" },
      minLevel: "ERROR",
    });
    expect(rt().config.endpoint).toBe(base.endpoint);
    expect(rt().config.securityContext.id).toBe("A");
    expect(rt().config.minLevel).toBe("ERROR");
    expect(getDiagnosticCounters()["config.invalid"]).toBe(before + 1);
  });

  it("removes the old endpoints from the network ignore list at rotation", async () => {
    configure({
      ...base,
      transport: transport(),
      capture: { errors: false, rejections: false, ignoreUrls: ["https://other.example"] },
    });
    await flush();
    expect(rt().config.capture.ignoreUrls).toContain(base.endpoint);
    await rotateSecurityContext({
      id: "B",
      delivery: { endpoint: "https://b.example/logs", transport: transport() },
    });
    expect(rt().config.capture.ignoreUrls).toEqual([
      "https://other.example",
      "https://b.example/logs",
    ]);
  });

  it("rejects invalid and overlapping rotations without changing identity", async () => {
    configure({ ...base, transport: transport() });
    await expect(rotateSecurityContext({ id: "", delivery: {} })).rejects.toThrow();
    await expect(rotateSecurityContext({ id: "A", delivery: {} })).rejects.toThrow();
    const first = rotateSecurityContext({ id: "B", delivery: {} });
    await expect(rotateSecurityContext({ id: "C", delivery: {} })).rejects.toThrow(
      "already running",
    );
    await first;
    expect(rt().config.securityContext.id).toBe("B");
  });
});

describe("runtime ownership and cache", () => {
  it("locks configuration, accepts repeated setup, allows explicit rotation and unlocking", async () => {
    const config = { ...base, transport: transport(), lockConfiguration: true };
    configure(config);
    configure(config);
    expect(getDiagnosticCounters()["config.locked"]).toBeUndefined();
    configure({ serviceName: "remote" });
    expect(rt().config.serviceName).toBe("test");
    expect(getDiagnosticCounters()["config.locked"]).toBe(1);
    await rotateSecurityContext({ id: "B", delivery: { transport: transport() } });
    expect((await getHealth()).configurationLocked).toBe(true);
    setConfigurationLocked(false);
    configure({ serviceName: "host" });
    expect(rt().config.serviceName).toBe("host");
  });

  it("bounds 10,000 namespaces, supports LRU resizing, no cache and explicit unbounded caching", async () => {
    configure({ ...base, endpoint: null });
    for (let i = 0; i < 10000; i++) getLogger(`namespace-${String(i)}`);
    expect((await getHealth()).loggerCache).toEqual({ size: 256, maxEntries: 256 });
    configure({ loggerCache: { maxEntries: 2 } });
    const a = getLogger("a");
    getLogger("b");
    expect(getLogger("a")).toBe(a);
    getLogger("c");
    expect(getLogger("a")).toBe(a);
    configure({ loggerCache: { maxEntries: 0 } });
    expect(getLogger("a")).not.toBe(getLogger("a"));
    configure({ loggerCache: { maxEntries: null } });
    configure({ serviceName: "other" });
    for (let i = 0; i < 300; i++) getLogger(`unlimited-${String(i)}`);
    expect((await getHealth()).loggerCache.size).toBe(300);
    a.info("old handles still work");
  });

  it("reports intentional console-only operation and stopped state", async () => {
    configure({ ...base, endpoint: null });
    await flush();
    expect(await getHealth()).toMatchObject({
      status: "ready",
      mode: "console-only",
      senderReady: false,
      issues: [],
    });
    await shutdown();
    expect((await getHealth()).status).toBe("stopped");
  });
});

describe("bus source policies", () => {
  function setup(over: Partial<ObservabilityConfig> = {}) {
    const config = resolveConfig(
      { ...base, ...over, bus: { mode: "sender", ...over.bus } },
      new Diagnostics(vi.fn()),
    );
    const onRecords = vi.fn();
    const bus = new Bus(
      config,
      new Diagnostics(vi.fn()),
      { platform: "browser", isTopLevelDocument: true, isWorker: false, userAgent: "test" },
      "host",
      "tab",
      {
        onRecords,
        onJourney: vi.fn(),
        onJourneyRequest: () => null,
        onTabConflict: vi.fn(),
        remote: { sampling: null },
      },
    );
    return {
      config,
      bus,
      onRecords,
      deliver: (message: BusMessage, source: MessageSource) => bus["receive"](message, source),
    };
  }

  it("rejects unregistered frames, then admits only the registered window and granted records", async () => {
    const { bus, onRecords } = setup();
    await bus.start();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const send = (data: BusMessage) =>
      dispatchEvent(
        new MessageEvent("message", {
          data: envelope(data),
          source: iframe.contentWindow,
          origin: location.origin,
        }),
      );
    const records: BusMessage = {
      t: "records",
      from: "child",
      records: [record()],
      routingContextId: "A",
    };
    send(records);
    expect(onRecords).not.toHaveBeenCalled();
    const detach = bus.registerFrame(iframe, { origin: location.origin });
    send(records);
    expect(onRecords).toHaveBeenCalledTimes(1);
    detach();
    send(records);
    expect(onRecords).toHaveBeenCalledTimes(1);
    bus.destroy();
  });

  it("enforces schema, rate, size, record count, permission and context checks", () => {
    const { config, bus, onRecords, deliver } = setup({ bus: { maxMessagesPerSecond: 1 } });
    const peer = {} as Window;
    const detach = bus.registerFrame(peer, { origin: location.origin });
    const source: MessageSource = { link: "direct", origin: "same-origin", peer };
    const records: BusMessage = {
      t: "records",
      from: "child",
      records: [record()],
      routingContextId: "A",
    };
    deliver(records, source);
    deliver(records, source);
    expect(onRecords).toHaveBeenCalledTimes(1);
    config.bus.maxMessagesPerSecond = 0;
    deliver({ ...records, records: [{} as LogRecord] }, source);
    config.bus.maxMessageBytes = 10;
    deliver(records, source);
    config.bus.maxMessageBytes = 0;
    config.bus.maxRecordsPerMessage = 1;
    deliver({ ...records, records: [record(), record()] }, source);
    deliver({ ...records, routingContextId: "B" }, source);
    detach();
    bus.registerFrame(peer, { origin: location.origin, permissions: [] });
    deliver(records, source);
    expect(onRecords).toHaveBeenCalledTimes(1);
    bus.destroy();
  });

  it("allows explicit origin-based trust, relaxed validation and disabled budgets", () => {
    const { config, bus, onRecords, deliver } = setup({
      securityContext: { isolation: false },
      bus: {
        sourcePolicy: "trusted-origin",
        validation: "envelope",
        maxMessageBytes: 0,
        maxRecordsPerMessage: 0,
        maxMessagesPerSecond: 0,
      },
    });
    deliver(
      { t: "records", from: "child", records: [{} as LogRecord] },
      { link: "children", origin: location.origin },
    );
    expect(onRecords).toHaveBeenCalledTimes(1);
    expect(config.bus.sourcePolicy).toBe("trusted-origin");
    bus.destroy();
  });

  it("supports early cancellation of public registrations", async () => {
    configure({ ...base, endpoint: null });
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    registerFrame(iframe, { origin: location.origin })();
    const worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    registerWorker(worker)();
    await flush();
    expect(worker.addEventListener).not.toHaveBeenCalled();
  });
});

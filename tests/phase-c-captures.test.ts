import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleCapture } from "../src/capture/lifecycle";
import { ReportCapture } from "../src/capture/reports";
import { ResourceTimingCapture } from "../src/capture/resource-timing";
import type { CaptureContext } from "../src/capture/types";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import { configure, flush } from "../src/index";
import type { ObservabilityConfig } from "../src/models/config";
import { TraceEngine } from "../src/utils/tracing";

class ResourceObserver {
  static supportedEntryTypes: string[] | undefined = ["resource"];
  static latest: ResourceObserver;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(readonly callback: (list: { getEntries(): unknown[] }) => void) {
    ResourceObserver.latest = this;
  }

  emit(...entries: unknown[]): void {
    this.callback({ getEntries: () => entries });
  }
}

class ReportObserver {
  static latest: ReportObserver;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(
    readonly callback: (reports: unknown[]) => void,
    readonly options: unknown,
  ) {
    ReportObserver.latest = this;
  }

  emit(...reports: unknown[]): void {
    this.callback(reports);
  }
}

function context(options: ObservabilityConfig = {}): CaptureContext {
  const diagnostics = new Diagnostics(vi.fn(), 0);
  return {
    config: resolveConfig(
      { endpoint: "https://ingest.example/logs", serviceName: "svc", ...options },
      diagnostics,
    ),
    diagnostics,
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      logEvent: vi.fn(),
      logMetric: vi.fn(),
      debug: vi.fn(),
    },
    breadcrumbs: new BreadcrumbBuffer(10),
    tracing: new TraceEngine(diagnostics),
    once: {
      webVitals: false,
      navigationTiming: false,
      longFrames: false,
      uncleanExit: false,
      userTiming: false,
    },
    recordMetric: vi.fn(),
    recordSpan: vi.fn(),
    sessionId: () => "session",
  };
}

const resource = (
  name = "https://assets.example/app.js?token=secret",
  duration = 1200,
  initiatorType = "script",
) => ({ name, duration, initiatorType });

afterEach(() => {
  vi.useRealTimers();
});

describe("ResourceTimingCapture", () => {
  function setup(options: ObservabilityConfig = {}) {
    ResourceObserver.supportedEntryTypes = ["resource"];
    vi.stubGlobal("PerformanceObserver", ResourceObserver);
    const ctx = context(options);
    const sut = new ResourceTimingCapture(ctx);
    return { ctx, sut };
  }

  it("records durations by host and initiator with a slow event", () => {
    const { ctx, sut } = setup();
    sut.install();
    sut.install();
    expect(ResourceObserver.latest.observe).toHaveBeenCalledExactlyOnceWith({
      type: "resource",
      buffered: true,
    });
    ResourceObserver.latest.emit(
      resource(),
      resource("https://assets.example/style.css", 20, "css"),
    );

    expect(ctx.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ui.resource.duration", unit: "ms" }),
      1200,
      {
        "resource.initiator_type": "script",
        "server.address": "assets.example",
      },
    );
    expect(ctx.logger.logEvent).toHaveBeenCalledExactlyOnceWith("ui.resource.slow", {
      "resource.initiator_type": "script",
      "server.address": "assets.example",
      "resource.duration_ms": 1200,
      "url.full": "https://assets.example/app.js",
    });
    sut.uninstall();
    expect(ResourceObserver.latest.disconnect).toHaveBeenCalledOnce();
    ResourceObserver.latest.emit(resource());
    expect(ctx.recordMetric).toHaveBeenCalledTimes(2);
    sut.uninstall();

    const next = new ResourceTimingCapture(ctx);
    next.install();
    expect(ResourceObserver.latest.observe).toHaveBeenCalledWith({
      type: "resource",
      buffered: false,
    });
    next.uninstall();
  });

  it.each([true, { slowMs: 10 }, {}, { slowMs: 0 }])(
    "uses the slow resource settings %j",
    (resourceTiming) => {
      const { ctx, sut } = setup({ capture: { resourceTiming, fullUrls: true } });
      ctx.config.capture.resourceTiming = resourceTiming;
      sut.install();
      ResourceObserver.latest.emit(resource());
      expect(ctx.recordMetric).toHaveBeenCalledOnce();
      expect(ctx.logger.logEvent).toHaveBeenCalledTimes(
        typeof resourceTiming === "object" && resourceTiming.slowMs === 0 ? 0 : 1,
      );
      if (vi.mocked(ctx.logger.logEvent).mock.calls.length > 0) {
        expect(vi.mocked(ctx.logger.logEvent).mock.calls[0][1]?.["url.full"]).toContain(
          "?token=secret",
        );
      }
      sut.uninstall();
    },
  );

  it("skips ingest endpoints, ignored URLs, invalid durations and non-HTTP resources", () => {
    const { ctx, sut } = setup({
      metricsEndpoint: "https://ingest.example/metrics",
      tracesEndpoint: "https://ingest.example/traces",
      capture: { ignoreUrls: ["ignored", /blocked/] },
    });
    sut.install();
    for (const name of [
      "https://ingest.example/logs",
      "https://ingest.example/metrics?x",
      "https://ingest.example/traces",
      "https://assets.example/ignored",
      "https://assets.example/blocked",
      "data:text/plain,private",
    ]) {
      ResourceObserver.latest.emit(resource(name));
    }
    ctx.config.capture.ignoreUrls = [];
    ResourceObserver.latest.emit(
      resource("https://ingest.example/logs"),
      resource("https://ingest.example/metrics"),
      resource("https://ingest.example/traces"),
    );
    for (const duration of [-1, NaN, Infinity]) {
      ResourceObserver.latest.emit(resource(undefined, duration));
    }
    ResourceObserver.latest.emit(resource("http://[bad"));
    expect(ctx.recordMetric).not.toHaveBeenCalled();
    expect(ctx.diagnostics.snapshot()["capture.record_failed"]).toBe(1);
    sut.uninstall();
  });

  it("applies the resource rate limit after URL filtering", () => {
    const { ctx, sut } = setup({ capturePolicy: { resourcesPerWindow: 1 } });
    sut.install();
    ctx.isActive = () => false;
    ResourceObserver.latest.emit(resource());
    ctx.isActive = () => true;
    ResourceObserver.latest.emit(resource("https://ingest.example/logs"), resource(), resource());
    expect(ctx.recordMetric).toHaveBeenCalledOnce();
    expect(ctx.diagnostics.snapshot()["capture.rate_limited"]).toBe(1);
    sut.uninstall();
  });

  it.each([{ types: undefined }, { types: [] }])(
    "reports a browser without resource timing support %j",
    ({ types }) => {
      const { ctx, sut } = setup();
      ResourceObserver.supportedEntryTypes = types;
      if (types === undefined) {
        vi.stubGlobal("PerformanceObserver", undefined);
      }
      sut.install();
      expect(ctx.diagnostics.snapshot()["capture.install_failed"]).toBe(1);
      sut.uninstall();
    },
  );

  it("reports an old observer without supportedEntryTypes", () => {
    const { ctx, sut } = setup();
    ResourceObserver.supportedEntryTypes = undefined;
    sut.install();
    expect(ctx.diagnostics.snapshot()["capture.install_failed"]).toBe(1);
  });
});

describe("ReportCapture", () => {
  const report = (body: Record<string, unknown> = {}) => ({
    type: "deprecation",
    url: "https://user:pass@app.example/page?token=secret#part",
    body,
  });

  it("records fixed report fields without URL queries, text or samples", () => {
    vi.stubGlobal("ReportingObserver", ReportObserver);
    const ctx = context({ capture: { fullUrls: true, urlTransform: (url) => url } });
    const sut = new ReportCapture(ctx);
    sut.install();
    sut.install();
    expect(ReportObserver.latest.options).toEqual({
      types: ["deprecation", "intervention"],
      buffered: false,
    });
    expect(ReportObserver.latest.observe).toHaveBeenCalledOnce();
    ReportObserver.latest.emit(
      report({
        id: "OldAPI",
        sourceFile: "https://app.example/app.js?secret",
        lineNumber: 3,
        columnNumber: 4,
        message: "private",
        sample: "private",
      }),
    );
    ReportObserver.latest.emit({ ...report(), type: "intervention" });
    ReportObserver.latest.emit({ ...report(), type: "unknown" });
    expect(ctx.logger.warn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.logger.warn).mock.calls[0]).toEqual([
      "ui.report",
      {
        "report.type": "deprecation",
        "report.url": "https://app.example/page",
        "report.id": "OldAPI",
        "report.source": "https://app.example/app.js",
        "report.line": 3,
        "report.column": 4,
      },
    ]);
    sut.uninstall();
    expect(ReportObserver.latest.disconnect).toHaveBeenCalledOnce();
    ReportObserver.latest.emit(report());
    expect(ctx.logger.warn).toHaveBeenCalledTimes(2);
  });

  it("records CSP events when ReportingObserver is absent", () => {
    vi.stubGlobal("ReportingObserver", undefined);
    const ctx = context();
    const sut = new ReportCapture(ctx);
    sut.install();
    expect(ctx.diagnostics.snapshot()["capture.install_failed"]).toBe(1);
    const event = Object.assign(new Event("securitypolicyviolation"), {
      documentURI: "https://app.example/page?secret",
      sourceFile: "https://app.example/app.js#part",
      blockedURI: "https://blocked.example/script?secret",
      lineNumber: 1,
      columnNumber: 2,
      effectiveDirective: "script-src",
    });
    document.dispatchEvent(event);
    expect(ctx.logger.warn).toHaveBeenCalledWith("ui.report", {
      "report.type": "csp-violation",
      "report.url": "https://app.example/page",
      "report.source": "https://app.example/app.js",
      "report.blocked_url": "https://blocked.example/script",
      "report.line": 1,
      "report.column": 2,
      "report.directive": "script-src",
    });
    sut.uninstall();
    document.dispatchEvent(event);
    expect(ctx.logger.warn).toHaveBeenCalledOnce();
  });

  it("contains failed report reads and limits reports in each window", () => {
    vi.stubGlobal("ReportingObserver", ReportObserver);
    const ctx = context({ capturePolicy: { reportsPerWindow: 2 } });
    const sut = new ReportCapture(ctx);
    sut.install();
    ctx.isActive = () => false;
    ReportObserver.latest.emit(report());
    ctx.isActive = () => true;
    ReportObserver.latest.emit({
      get type() {
        throw new Error("blocked");
      },
    });
    ReportObserver.latest.emit(report(), report());
    expect(ctx.logger.warn).toHaveBeenCalledOnce();
    expect(ctx.diagnostics.snapshot()["capture.record_failed"]).toBe(1);
    expect(ctx.diagnostics.snapshot()["capture.rate_limited"]).toBe(1);
    sut.uninstall();
  });
});

describe("LifecycleCapture", () => {
  it("records each state with the time in the previous state", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const ctx = context();
    const sut = new LifecycleCapture(ctx);
    sut.install();
    sut.install();
    document.dispatchEvent(new Event("visibilitychange"));
    clock.mockReturnValue(10);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    clock.mockReturnValue(25);
    document.dispatchEvent(new Event("freeze"));
    clock.mockReturnValue(50);
    document.dispatchEvent(new Event("resume"));
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    clock.mockReturnValue(60);
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));

    expect(vi.mocked(ctx.logger.logEvent).mock.calls.map(([, attrs]) => attrs)).toEqual([
      { "lifecycle.state": "visible", "lifecycle.previous_state": "", "lifecycle.duration_ms": 0 },
      {
        "lifecycle.state": "hidden",
        "lifecycle.previous_state": "visible",
        "lifecycle.duration_ms": 10,
      },
      {
        "lifecycle.state": "frozen",
        "lifecycle.previous_state": "hidden",
        "lifecycle.duration_ms": 15,
      },
      {
        "lifecycle.state": "resumed",
        "lifecycle.previous_state": "frozen",
        "lifecycle.duration_ms": 25,
      },
      {
        "lifecycle.state": "restored",
        "lifecycle.previous_state": "resumed",
        "lifecycle.duration_ms": 10,
      },
    ]);
    sut.uninstall();
    document.dispatchEvent(new Event("freeze"));
    sut["transition"]("hidden");
    expect(ctx.logger.logEvent).toHaveBeenCalledTimes(5);
  });

  it("keeps the state and its start time across a reinstall", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const ctx = context();
    const first = new LifecycleCapture(ctx);
    first.install();
    first.uninstall();

    clock.mockReturnValue(30);
    const second = new LifecycleCapture(ctx);
    second.install();
    expect(ctx.logger.logEvent).toHaveBeenCalledOnce();

    clock.mockReturnValue(50);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.mocked(ctx.logger.logEvent).mock.calls[1][1]).toEqual({
      "lifecycle.state": "hidden",
      "lifecycle.previous_state": "visible",
      "lifecycle.duration_ms": 40,
    });
    second.uninstall();
  });

  it("updates state while inactive and while events exceed the limit", () => {
    const ctx = context({ capturePolicy: { lifecyclePerWindow: 1 } });
    ctx.isActive = () => false;
    const sut = new LifecycleCapture(ctx);
    sut.install();
    ctx.isActive = () => true;
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
    expect(ctx.logger.logEvent).toHaveBeenCalledOnce();
    expect(ctx.once.lifecycle?.state).toBe("resumed");
    expect(ctx.diagnostics.snapshot()["capture.rate_limited"]).toBe(1);
    sut.uninstall();
  });
});

describe("Phase C configuration", () => {
  it("keeps all new captures off and the remote allowlist empty by default", () => {
    expect(context().config.capture).toMatchObject({
      remoteToggles: [],
      serverTiming: false,
      reports: false,
      resourceTiming: false,
      lifecycle: false,
    });
  });

  it("refuses privacy controls and invalid resource settings", () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const base = resolveConfig(
      { endpoint: null, serviceName: "svc", capture: { resourceTiming: { slowMs: 25 } } },
      diagnostics,
    );
    const config = resolveConfig(
      { capture: { remoteToggles: ["fullUrls"] as never, resourceTiming: { slowMs: -1 } } },
      diagnostics,
      base,
    );
    expect(config.capture.remoteToggles).toEqual([]);
    expect(config.capture.resourceTiming).toEqual({ slowMs: 25 });
    expect(
      resolveConfig({ capture: { resourceTiming: "yes" as never } }, diagnostics, base).capture
        .resourceTiming,
    ).toEqual({ slowMs: 25 });
    expect(
      resolveConfig({ capture: { resourceTiming: {} } }, diagnostics, {
        ...base,
        capture: { ...base.capture, resourceTiming: {} },
      }).capture.resourceTiming,
    ).toEqual({ slowMs: 1000 });
  });

  it("loads the report, resource and lifecycle captures through the runtime", async () => {
    vi.stubGlobal("ReportingObserver", ReportObserver);
    vi.stubGlobal("PerformanceObserver", ResourceObserver);
    ResourceObserver.supportedEntryTypes = ["resource"];
    configure({
      endpoint: null,
      serviceName: "svc",
      bus: { mode: "off" },
      capture: {
        errors: false,
        rejections: false,
        reports: true,
        resourceTiming: true,
        lifecycle: true,
      },
    });
    await flush();
    await vi.waitFor(() => {
      expect(ObservabilityRuntime.current()!["captures"].map((capture) => capture.name)).toEqual([
        "reports",
        "resourceTiming",
        "lifecycle",
      ]);
      expect(ReportObserver.latest.observe).toHaveBeenCalled();
      expect(ResourceObserver.latest.observe).toHaveBeenCalled();
    });
  });
});

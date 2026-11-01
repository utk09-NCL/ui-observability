import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureContext, CaptureOnce } from "../src/capture/types";
import { UserTimingCapture } from "../src/capture/user-timing";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { configure, flush } from "../src/index";
import type { CaptureOptions } from "../src/models/config";
import { TraceEngine } from "../src/utils/tracing";

/** Stand-in for PerformanceObserver. A test calls emit() to deliver entries. */
class FakeObserver {
  static supportedEntryTypes: readonly string[] | undefined = ["mark", "measure"];

  static created: FakeObserver[] = [];

  observed: { type: string; buffered?: boolean }[] = [];

  disconnected = false;

  constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {
    FakeObserver.created.push(this);
  }

  observe(options: { type: string; buffered?: boolean }): void {
    this.observed.push(options);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(...entries: unknown[]): void {
    this.callback({ getEntries: () => entries });
  }
}

/** Returns the observer that the stub created last. */
const active = (): FakeObserver => FakeObserver.created.at(-1)!;

/** Entry types of a browser with User Timing. */
const USER_TIMING_TYPES = ["mark", "measure"];

/**
 * Stubs PerformanceObserver with a list of supported entry types.
 * @param types Supported entry types, or undefined for an old browser.
 */
function support(types: readonly string[] | undefined): void {
  FakeObserver.supportedEntryTypes = types;
  FakeObserver.created = [];
  vi.stubGlobal("PerformanceObserver", FakeObserver);
}

/** Builds the `once` flags of a new document. */
const freshOnce = (): CaptureOnce => ({
  webVitals: false,
  navigationTiming: false,
  longFrames: false,
  uncleanExit: false,
  userTiming: false,
});

/**
 * Builds a capture around a spy meter, with the diagnostics throttle off.
 * @param capture Capture settings over userTiming on.
 * @param once The `once` flags. Two captures with one object act as a reinstall in one document.
 * @returns The capture and its context.
 */
function setup(capture: Partial<CaptureOptions> = {}, once = freshOnce()) {
  const diagnostics = new Diagnostics(vi.fn(), 0);
  const ctx: CaptureContext = {
    config: resolveConfig(
      { endpoint: null, serviceName: "svc", capture: { userTiming: true, ...capture } },
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
    once,
    recordMetric: vi.fn(),
    recordSpan: vi.fn(),
    sessionId: () => "session",
  };

  return { sut: new UserTimingCapture(ctx), ctx };
}

const measure = (name: string, duration: number) => ({ entryType: "measure", name, duration });
const mark = (name: string) => ({ entryType: "mark", name, duration: 0 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UserTimingCapture", () => {
  it("records a measure in the histogram and a mark as a breadcrumb", () => {
    support(USER_TIMING_TYPES);
    const { sut, ctx } = setup();
    sut.install();

    active().emit(measure("app.grid.render", 12.5), mark("app.ready"));

    expect(ctx.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ui.user_timing.duration", kind: "histogram", unit: "ms" }),
      12.5,
      { "user_timing.name": "app.grid.render" },
    );
    expect(ctx.breadcrumbs.snapshot()).toMatchObject([{ category: "event", message: "app.ready" }]);
    sut.uninstall();
    expect(active().disconnected).toBe(true);
  });

  it("records only the names that userTimingInclude selects", () => {
    support(USER_TIMING_TYPES);
    const { sut, ctx } = setup({ userTimingInclude: [/^app\./, "checkout"] });
    sut.install();

    active().emit(
      measure("app.grid.render", 1),
      measure("Next.js-hydration", 2),
      measure("checkout.submit", 3),
      mark("⚛ framework mark"),
    );

    expect(vi.mocked(ctx.recordMetric).mock.calls.map(([, value]) => value)).toEqual([1, 3]);
    expect(ctx.breadcrumbs.snapshot()).toEqual([]);
    sut.uninstall();
  });

  it("reads buffered entries only at the first install of a document", () => {
    support(USER_TIMING_TYPES);
    const once = freshOnce();
    const first = setup({}, once).sut;
    first.install();
    first.install();
    expect(active().observed).toEqual([
      { type: "measure", buffered: true },
      { type: "mark", buffered: true },
    ]);
    first.uninstall();

    setup({}, once).sut.install();
    expect(active().observed).toEqual([
      { type: "measure", buffered: false },
      { type: "mark", buffered: false },
    ]);
  });

  it("observes measures only, when the browser has no mark entries", () => {
    support(["measure"]);
    const { sut } = setup();
    sut.install();

    expect(active().observed).toEqual([{ type: "measure", buffered: true }]);
    sut.uninstall();
  });

  it("reports a browser without User Timing entries one time", () => {
    const once = freshOnce();
    for (const types of [undefined, ["longtask"]]) {
      support(types);
      const { sut, ctx } = setup({}, once);
      sut.install();
      expect(FakeObserver.created).toEqual([]);
      expect(ctx.diagnostics.snapshot()["capture.install_failed"] ?? 0).toBe(
        types === undefined ? 1 : 0,
      );
    }

    vi.stubGlobal("PerformanceObserver", undefined);
    const { sut } = setup();
    sut.install();
    sut.uninstall();
  });

  it("records nothing while the runtime is inactive", () => {
    support(USER_TIMING_TYPES);
    const { sut, ctx } = setup();
    ctx.isActive = () => false;
    sut.install();

    active().emit(measure("app.grid.render", 1), mark("app.ready"));

    expect(ctx.recordMetric).not.toHaveBeenCalled();
    expect(ctx.breadcrumbs.snapshot()).toEqual([]);
    sut.uninstall();
  });
});

describe("capture.userTiming in the runtime", () => {
  it("installs the capture when the config turns it on", async () => {
    support(USER_TIMING_TYPES);
    configure({
      endpoint: null,
      serviceName: "svc",
      bus: { mode: "off" },
      capture: { errors: false, rejections: false, userTiming: true },
    });
    await flush();

    await vi.waitFor(() => {
      expect(FakeObserver.created).toHaveLength(1);
    });
  });
});

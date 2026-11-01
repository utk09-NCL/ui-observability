import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureContext, CaptureLogger } from "../src/capture/types";
import { UncleanExitCapture } from "../src/capture/unclean-exit";
import { ALIVE_KEY, ALIVE_UPDATE_MS } from "../src/constants";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { configure, createMemoryTransport, flush } from "../src/index";
import { TraceEngine } from "../src/utils/tracing";

/**
 * Builds a capture around a spy logger, with the diagnostics throttle off.
 * @returns The capture, its context and the spy for warnings.
 */
function setup() {
  const diagnostics = new Diagnostics(vi.fn(), 0);
  const warn = vi.fn<CaptureLogger["warn"]>();
  const ctx: CaptureContext = {
    config: resolveConfig({ endpoint: null, serviceName: "svc" }, diagnostics),
    diagnostics,
    logger: { error: vi.fn(), warn, logEvent: vi.fn(), logMetric: vi.fn(), debug: vi.fn() },
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
    sessionId: () => "session-now",
  };

  return { capture: new UncleanExitCapture(ctx), ctx, warn };
}

/** Reads the marker in sessionStorage. */
const marker = (): unknown => JSON.parse(sessionStorage.getItem(ALIVE_KEY) ?? "null");

/**
 * Builds a page transition event.
 * @param type Event type.
 * @param persisted True for a page in the back-forward cache.
 * @returns The event.
 */
const transition = (type: string, persisted: boolean): Event =>
  Object.assign(new Event(type), { persisted });

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("UncleanExitCapture", () => {
  it("reports the marker of the previous page, then writes its own marker", () => {
    sessionStorage.setItem(
      ALIVE_KEY,
      JSON.stringify({ sessionId: "session-old", at: 1000, visibility: "hidden" }),
    );
    const { capture, warn } = setup();

    capture.install();

    expect(warn).toHaveBeenCalledWith("ui.unclean_exit", {
      "exit.session_id": "session-old",
      "exit.last_seen_ms": 1000,
      "exit.visibility": "hidden",
      "exit.discarded": false,
    });
    expect(marker()).toMatchObject({ sessionId: "session-now", visibility: "visible" });
    capture.uninstall();
  });

  it("reports a page that the browser discarded", () => {
    sessionStorage.setItem(ALIVE_KEY, JSON.stringify({ sessionId: "a", at: 1, visibility: "x" }));
    Object.defineProperty(document, "wasDiscarded", { value: true, configurable: true });
    const { capture, warn } = setup();

    capture.install();

    expect(warn.mock.calls[0][1]).toMatchObject({ "exit.discarded": true });
    capture.uninstall();
    Reflect.deleteProperty(document, "wasDiscarded");
  });

  it("reports nothing without a marker or with a marker of another shape", () => {
    for (const stored of [
      null,
      "5",
      JSON.stringify({ sessionId: "a", at: "1", visibility: "x" }),
    ]) {
      if (stored !== null) {
        sessionStorage.setItem(ALIVE_KEY, stored);
      }
      const { capture, warn } = setup();
      capture.install();
      expect(warn).not.toHaveBeenCalled();
      capture.uninstall();
    }
  });

  it("reports a marker that is not JSON as a storage fault", () => {
    sessionStorage.setItem(ALIVE_KEY, "{");
    const { capture, ctx, warn } = setup();

    capture.install();

    expect(warn).not.toHaveBeenCalled();
    expect(ctx.diagnostics.snapshot()["storage.unavailable"]).toBe(1);
    capture.uninstall();
  });

  it("reads the previous marker one time for each document", () => {
    const { capture, warn } = setup();
    capture.install();
    capture.uninstall();

    sessionStorage.setItem(ALIVE_KEY, JSON.stringify({ sessionId: "a", at: 1, visibility: "x" }));
    capture.install();

    expect(warn).not.toHaveBeenCalled();
    capture.uninstall();
  });

  it("removes the marker on pagehide, and writes it again on a restore from the cache", () => {
    const { capture } = setup();
    capture.install();

    dispatchEvent(transition("pagehide", true));
    expect(marker()).toBeNull();

    dispatchEvent(transition("pageshow", false));
    expect(marker()).toBeNull();

    dispatchEvent(transition("pageshow", true));
    expect(marker()).toMatchObject({ sessionId: "session-now" });
    capture.uninstall();
  });

  it("updates the marker at each visibility change and at each interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { capture } = setup();
    capture.install();

    vi.advanceTimersByTime(ALIVE_UPDATE_MS);
    expect(marker()).toMatchObject({ at: 10_000 + ALIVE_UPDATE_MS });

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(marker()).toMatchObject({ visibility: "hidden" });
    capture.uninstall();
  });

  it("removes the marker, the listeners and the timer at uninstall", () => {
    vi.useFakeTimers();
    const { capture } = setup();
    capture.install();
    capture.uninstall();
    capture.uninstall();

    document.dispatchEvent(new Event("visibilitychange"));
    dispatchEvent(transition("pageshow", true));
    vi.advanceTimersByTime(ALIVE_UPDATE_MS);

    expect(marker()).toBeNull();
  });

  it("does nothing in a frame, in a realm without a document, or on a second install", () => {
    const { capture } = setup();
    vi.spyOn(window, "parent", "get").mockReturnValue({} as Window & typeof globalThis);
    capture.install();
    expect(marker()).toBeNull();
    vi.restoreAllMocks();

    vi.stubGlobal("document", undefined);
    capture.install();
    vi.unstubAllGlobals();
    expect(marker()).toBeNull();

    capture.install();
    sessionStorage.clear();
    capture.install();
    expect(marker()).toBeNull();
    capture.uninstall();
  });

  it("reports a sessionStorage that throws, and never throws itself", () => {
    const refuse = (): never => {
      throw new Error("SecurityError");
    };
    // clear() serves the afterEach hook. Vitest restores the global before the next test only.
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: refuse,
      removeItem: refuse,
      clear: () => undefined,
    });
    const { capture, ctx } = setup();

    capture.install();
    capture.uninstall();

    expect(ctx.diagnostics.snapshot()["storage.unavailable"]).toBe(2);
  });
});

describe("capture.uncleanExit in the runtime", () => {
  it("sends a WARN record for the previous page and keeps a marker for this page", async () => {
    sessionStorage.setItem(
      ALIVE_KEY,
      JSON.stringify({ sessionId: "session-old", at: 1000, visibility: "visible" }),
    );
    const memory = createMemoryTransport();
    configure({
      endpoint: null,
      serviceName: "svc",
      storage: "memory",
      identity: "memory",
      bus: { mode: "off" },
      transport: memory.transport,
      capture: { errors: false, rejections: false, uncleanExit: true },
    });

    // The capture loads later. It replaces the old marker with the marker of this page.
    await vi.waitFor(() => {
      expect(marker()).not.toMatchObject({ sessionId: "session-old" });
    });
    await flush();

    const [record] = memory.records();
    expect(record.severityText).toBe("WARN");
    expect(record.body).toBe("ui.unclean_exit");
    expect(record.attributes["exit.session_id"]).toBe("session-old");
  });
});

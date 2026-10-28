// tests/console-capture.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleCapture } from "../src/capture/console";
import { ErrorCapture } from "../src/capture/errors";
import type { CaptureContext, CaptureLogger } from "../src/capture/types";
import { BreadcrumbBuffer } from "../src/core/breadcrumbs";
import {
  CONSOLE_BREADCRUMB_MAX_CHARS,
  CONSOLE_DEFAULT_STYLES as STYLES,
  ERROR_STORM_MAX_PER_WINDOW,
} from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { CaptureOptions } from "../src/models/config";
import { ConsoleSink } from "../src/utils/console";
import { runAsLibraryConsole } from "../src/utils/library-console";
import { TraceEngine } from "../src/utils/tracing";

/** Console methods that the tests replace with spies. */
const METHODS = ["error", "warn", "info", "log"] as const;

/** Spies that stand in for the browser console. The capture wraps them. */
let base: Record<(typeof METHODS)[number], ReturnType<typeof vi.fn<(...data: unknown[]) => void>>>;

/** Captures that a test installed. afterEach uninstalls them. */
const installed: ConsoleCapture[] = [];

/**
 * Builds and installs a capture around a spy logger, with the diagnostics throttle off.
 * @param value Value of capture.console.
 * @returns The capture, its spy logger, its breadcrumbs, its diagnostics and its events.
 */
function setup(value: unknown = true) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const logger = {
    error: vi.fn<CaptureLogger["error"]>(),
    warn: vi.fn<CaptureLogger["warn"]>(),
    logEvent: vi.fn<CaptureLogger["logEvent"]>(),
    logMetric: vi.fn<CaptureLogger["logMetric"]>(),
    debug: vi.fn<CaptureLogger["debug"]>(),
  };
  const breadcrumbs = new BreadcrumbBuffer(50);
  const ctx: CaptureContext = {
    config: resolveConfig({ endpoint: null, serviceName: "svc" }, diagnostics),
    diagnostics,
    logger,
    breadcrumbs,
    tracing: new TraceEngine(diagnostics),
    once: { webVitals: false, navigationTiming: false, longFrames: false },
  };
  ctx.config.capture.console = value as CaptureOptions["console"];

  const sut = new ConsoleCapture(ctx);
  installed.push(sut);
  sut.install();

  return { sut, ctx, logger, breadcrumbs, diagnostics, events };
}

beforeEach(() => {
  base = {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
  };
});

afterEach(() => {
  for (const capture of installed.splice(0)) {
    capture.uninstall();
  }

  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConsoleCapture", () => {
  it("wraps error and warn for true, and calls the original first", () => {
    const { logger } = setup(true);
    const cause = new Error("grid failed");

    console.error("render failed", cause, { row: 7 });
    console.info("not wrapped");

    expect(base.error).toHaveBeenCalledWith("render failed", cause, { row: 7 });
    expect(base.error.mock.invocationCallOrder[0]).toBeLessThan(
      logger.error.mock.invocationCallOrder[0],
    );
    expect(logger.error).toHaveBeenCalledWith("render failed", cause, {
      "console.method": "error",
      "console.args": [{ row: 7 }],
      "error.captured_by": "console.error",
    });
    expect(console.info).toBe(base.info);
  });

  it("uses the error message, then the method name, when the call has no string", () => {
    const { logger } = setup(["error"]);

    console.error(new Error("from error"));
    console.error({ code: 3 });

    expect(logger.error.mock.calls[0]?.[0]).toBe("from error");
    expect(logger.error.mock.calls[0]?.[2]).not.toHaveProperty("console.args");
    expect(logger.error.mock.calls[1]).toEqual([
      "console.error",
      undefined,
      expect.objectContaining({ "console.args": [{ code: 3 }] }),
    ]);
  });

  it("records an error from another realm as the error of the record", () => {
    const { logger } = setup(["error"]);
    // An error from an iframe fails instanceof Error in this realm.
    const foreign = { name: "TypeError", message: "x is undefined", stack: "TypeError: x" };

    console.error(foreign);

    expect(logger.error).toHaveBeenCalledWith(
      "x is undefined",
      foreign,
      expect.not.objectContaining({ "console.args": expect.anything() as unknown }),
    );
  });

  it("records warn as a WARN record, and keeps its Error in the arguments", () => {
    const { logger } = setup(["warn"]);
    const cause = new Error("slow");

    console.warn("deprecated API", cause);

    expect(logger.warn).toHaveBeenCalledWith("deprecated API", {
      "console.method": "warn",
      "console.args": [cause],
    });
  });

  it("records info and log as breadcrumbs only, and shortens a long message", () => {
    const { logger, breadcrumbs } = setup(["info", "log"]);

    console.info("loaded");
    console.log("x".repeat(CONSOLE_BREADCRUMB_MAX_CHARS + 50));

    const crumbs = breadcrumbs.snapshot();
    expect(crumbs[0]).toMatchObject({
      category: "console",
      message: "loaded",
      data: { "console.method": "info" },
    });
    expect(crumbs[1]?.message).toContain("[truncated 50 chars]");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("wraps a method one time when the list has it two times, or when install runs again", () => {
    const { sut, logger } = setup(["error", "error"]);

    sut.install();
    console.error("once");

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("reports a value that is not usable, and wraps nothing", () => {
    const { events: text } = setup("error");
    const { events: unknown } = setup(["error", "trace"]);

    expect(console.error).toBe(base.error);
    expect([...text, ...unknown].map((event) => event.code)).toEqual([
      "config.invalid",
      "config.invalid",
    ]);
  });

  it("does nothing when the realm has no console", () => {
    vi.stubGlobal("console", undefined);
    const { sut } = setup(true);
    vi.unstubAllGlobals();

    sut.uninstall();

    expect(console.error).toBe(base.error);
  });

  it("skips each call inside the library console scope", () => {
    const { logger } = setup(true);

    runAsLibraryConsole(() => {
      console.error("mirrored");
    });

    expect(base.error).toHaveBeenCalledWith("mirrored");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not record a line that the console sink mirrors", () => {
    const { logger, diagnostics } = setup(true);
    const sink = new ConsoleSink({ level: "DEBUG", styles: STYLES }, diagnostics);

    sink.write("app", "ERROR", "mirrored");
    sink.write("app", "WARN", "mirrored");

    expect(base.error).toHaveBeenCalledTimes(1);
    expect(base.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not record the diagnostics fallback line", () => {
    const { logger } = setup(true);
    const diagnostics = new Diagnostics(() => {
      throw new Error("handler failed");
    }, 0);

    diagnostics.report("config.invalid", "Bad value.");

    expect(base.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("stops the loop of a host wrapper that calls the library logger", () => {
    const { logger, diagnostics } = setup(true);
    const sink = new ConsoleSink({ level: "DEBUG", styles: STYLES }, diagnostics);
    const library = console.error;

    // The host wraps console.error after the library. Its wrapper logs through the library.
    console.error = (...args: unknown[]) => {
      library(...args);
      sink.write("host", "ERROR", "host saw an error");
    };
    console.error("app failed");
    console.error = library;

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(base.error).toHaveBeenCalledTimes(2);
  });

  it("limits the console records in one window, and reports the limit", () => {
    const { logger, events } = setup(true);

    for (let i = 0; i < ERROR_STORM_MAX_PER_WINDOW + 5; i++) {
      console.error(`failure ${String(i)}`);
    }

    expect(logger.error).toHaveBeenCalledTimes(ERROR_STORM_MAX_PER_WINDOW);
    expect(events.map((event) => event.code)).toContain("capture.rate_limited");
  });

  it("does not use the allowance of the error capture", () => {
    const { ctx, logger } = setup(true);
    const errors = new ErrorCapture(ctx);
    errors.install();

    for (let i = 0; i < ERROR_STORM_MAX_PER_WINDOW + 5; i++) {
      console.warn(`deprecated ${String(i)}`);
    }
    dispatchEvent(new ErrorEvent("error", { message: "real", error: new Error("real") }));
    errors.uninstall();

    // Console noise from a third party must not hide an uncaught error.
    expect(logger.error).toHaveBeenCalledWith("real", expect.any(Error), expect.anything());
  });

  it("does not record a console line from the onDiagnostic handler", () => {
    const { logger } = setup(true);
    const diagnostics = new Diagnostics(() => {
      console.warn("handler saw an event");
    }, 0);

    diagnostics.report("config.invalid", "Bad value.");

    expect(base.warn).toHaveBeenCalledWith("handler saw an event");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports a record that throws, and still prints the line", () => {
    const { logger, events } = setup(true);
    logger.error.mockImplementation(() => {
      throw new Error("logger failed");
    });

    console.error("boom");

    expect(base.error).toHaveBeenCalledWith("boom");
    expect(events.map((event) => event.code)).toEqual(["capture.record_failed"]);
  });

  it("restores each method on uninstall", () => {
    const { sut } = setup(["error", "warn", "info", "log"]);

    sut.uninstall();
    sut.uninstall();

    for (const method of METHODS) {
      expect(console[method]).toBe(base[method]);
    }
  });

  it("leaves a later wrapper in place on uninstall, and stops recording", () => {
    const { sut, logger, events } = setup(["error"]);
    const library = console.error;
    const host = (...args: unknown[]): void => {
      library(...args);
    };
    console.error = host;

    sut.uninstall();
    console.error("after uninstall");

    expect(console.error).toBe(host);
    expect(base.error).toHaveBeenCalledWith("after uninstall");
    expect(logger.error).not.toHaveBeenCalled();
    expect(events.map((event) => event.code)).toEqual(["capture.install_failed"]);
    console.error = base.error;
  });
});

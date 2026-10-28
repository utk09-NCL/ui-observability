import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureLogger } from "../src/capture/types";
import { CONSOLE_DEFAULT_STYLES as STYLES } from "../src/constants";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { ConsoleStyles } from "../src/models/config";
import type { LogLevel } from "../src/models/log-record";
import { ConsoleSink } from "../src/utils/console";
import { timeAsync, timeSync } from "../src/utils/timer";

/**
 * Builds a logger whose every method is a spy.
 * @returns The spy logger.
 */
function logger(): {
  error: ReturnType<typeof vi.fn<CaptureLogger["error"]>>;
  warn: ReturnType<typeof vi.fn<CaptureLogger["warn"]>>;
  logEvent: ReturnType<typeof vi.fn<CaptureLogger["logEvent"]>>;
  logMetric: ReturnType<typeof vi.fn<CaptureLogger["logMetric"]>>;
  debug: ReturnType<typeof vi.fn<CaptureLogger["debug"]>>;
} {
  return {
    error: vi.fn<CaptureLogger["error"]>(),
    warn: vi.fn<CaptureLogger["warn"]>(),
    logEvent: vi.fn<CaptureLogger["logEvent"]>(),
    logMetric: vi.fn<CaptureLogger["logMetric"]>(),
    debug: vi.fn<CaptureLogger["debug"]>(),
  };
}

describe("timeSync", () => {
  it("returns the value and records a duration histogram", () => {
    const l = logger();

    expect(timeSync(l, "CALC", () => 42)).toBe(42);

    expect(l.logMetric).toHaveBeenCalledWith(
      "CALC.duration",
      expect.any(Number) as number,
      "ms",
      "histogram",
      expect.objectContaining({ status: "SUCCESS" }),
    );
  });

  it("carries the caller's attributes onto the metric", () => {
    const l = logger();

    timeSync(l, "CALC", () => 1, { "order.id": "ORD-1" });

    expect(l.logMetric.mock.calls[0][4]).toMatchObject({
      status: "SUCCESS",
      "order.id": "ORD-1",
    });
  });

  it("rethrows the original error rather than swallowing it", () => {
    const l = logger();
    const boom = new Error("calculation");

    expect(() =>
      timeSync(l, "CALC", () => {
        throw boom;
      }),
    ).toThrow(boom);

    expect(l.error).toHaveBeenCalledWith(
      "CALC failed",
      boom,
      expect.objectContaining({ status: "FAILURE", "action.duration_ms": expect.any(Number) }),
    );
  });

  it("records a FAILURE duration histogram when the function throws", () => {
    const l = logger();

    expect(() =>
      timeSync(l, "CALC", () => {
        throw new Error("calculation");
      }),
    ).toThrow();

    expect(l.logMetric).toHaveBeenCalledWith(
      "CALC.duration",
      expect.any(Number) as number,
      "ms",
      "histogram",
      expect.objectContaining({ status: "FAILURE" }),
    );
  });

  it("gives the error record and the FAILURE metric the same duration", () => {
    const l = logger();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 5));

    expect(() =>
      timeSync(l, "CALC", () => {
        throw new Error("calculation");
      }),
    ).toThrow();

    expect(l.error.mock.calls[0][2]).toMatchObject({ "action.duration_ms": 5 });
    expect(l.logMetric.mock.calls[0][1]).toBe(5);
  });

  it("carries the caller's attributes onto a failure", () => {
    const l = logger();

    expect(() =>
      timeSync(
        l,
        "CALC",
        () => {
          throw new Error("boom");
        },
        { "order.id": "ORD-2" },
      ),
    ).toThrow();

    expect(l.error.mock.calls[0][2]).toMatchObject({ "order.id": "ORD-2" });
  });
});

describe("timeAsync", () => {
  it("resolves to the value and records a duration histogram", async () => {
    const l = logger();

    await expect(timeAsync(l, "FETCH", () => Promise.resolve("ok"))).resolves.toBe("ok");

    expect(l.logMetric).toHaveBeenCalledWith(
      "FETCH.duration",
      expect.any(Number) as number,
      "ms",
      "histogram",
      expect.objectContaining({ status: "SUCCESS" }),
    );
  });

  it("rethrows the original error rather than swallowing it", async () => {
    const l = logger();
    const boom = new Error("network");

    await expect(timeAsync(l, "FETCH", () => Promise.reject(boom))).rejects.toBe(boom);

    expect(l.error).toHaveBeenCalledWith(
      "FETCH failed",
      boom,
      expect.objectContaining({ status: "FAILURE" }),
    );
  });

  it("records a FAILURE duration histogram when the promise rejects", async () => {
    const l = logger();

    await expect(
      timeAsync(l, "FETCH", () => Promise.reject(new Error("network")), {
        "http.route": "/orders",
      }),
    ).rejects.toThrow();

    expect(l.logMetric).toHaveBeenCalledWith(
      "FETCH.duration",
      expect.any(Number) as number,
      "ms",
      "histogram",
      expect.objectContaining({ status: "FAILURE", "http.route": "/orders" }),
    );
  });

  it("carries the caller's attributes onto both outcomes", async () => {
    const l = logger();

    await timeAsync(l, "FETCH", () => Promise.resolve(1), { "http.route": "/orders" });
    await expect(
      timeAsync(l, "FETCH", () => Promise.reject(new Error("boom")), { "http.route": "/orders" }),
    ).rejects.toThrow();

    expect(l.logMetric.mock.calls[0][4]).toMatchObject({ "http.route": "/orders" });
    expect(l.error.mock.calls[0][2]).toMatchObject({ "http.route": "/orders" });
  });
});

describe("ConsoleSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * A sink with the diagnostics throttle disabled, plus the events it reported.
   * @param level Mirroring threshold.
   * @param styles CSS styles of the prefix parts.
   * @returns The sink and its event list.
   */
  function sinkOf(
    level: LogLevel | null,
    styles: Required<ConsoleStyles> = STYLES,
  ): {
    sink: ConsoleSink;
    events: DiagnosticEvent[];
  } {
    const events: DiagnosticEvent[] = [];
    const diagnostics = new Diagnostics((event) => {
      events.push(event);
    }, 0);
    return { sink: new ConsoleSink({ level, styles }, diagnostics), events };
  }

  it("prints nothing at all when disabled", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    sinkOf(null).sink.write("app", "INFO", "hello");

    expect(spy).not.toHaveBeenCalled();
  });

  it("respects its own level independently of the pipeline level", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    sinkOf("WARN").sink.write("app", "DEBUG", "quiet");

    expect(spy).not.toHaveBeenCalled();
  });

  it("prints nothing when its level is not a log level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    sinkOf("toString" as LogLevel).sink.write("app", "FATAL", "unknown level");

    expect(spy).not.toHaveBeenCalled();
  });

  it("prints a message with no payload", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    sinkOf("TRACE").sink.write("board.hop", "INFO", "hello");

    // The namespace tells apart the logs of each part of the app.
    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[INFO]%c",
      STYLES.namespace,
      "board.hop",
      STYLES.INFO,
      "",
      "hello",
    );
  });

  it("appends the payload when there is one", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    sinkOf("TRACE").sink.write("app", "WARN", "careful", { orderId: "ORD-1" });

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[WARN]%c",
      STYLES.namespace,
      "app",
      STYLES.WARN,
      "",
      "careful",
      {
        orderId: "ORD-1",
      },
    );
  });

  it("passes the namespace as an argument, not as part of the format string", () => {
    // A %o or %c in a namespace must print as text.
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    sinkOf("TRACE").sink.write("a%ob", "INFO", "hello");

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[INFO]%c",
      STYLES.namespace,
      "a%ob",
      STYLES.INFO,
      "",
      "hello",
    );
  });

  it("styles the namespace and the level with the configured CSS", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const styles = { ...STYLES, namespace: "color:teal", INFO: "color:#0a7;font-weight:bold" };

    sinkOf("TRACE", styles).sink.write("app.puzzle-page", "INFO", "The puzzle page loaded");

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[INFO]%c",
      "color:teal",
      "app.puzzle-page",
      "color:#0a7;font-weight:bold",
      "",
      "The puzzle page loaded",
    );
  });

  it("prints the error and then the payload", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("boom");

    sinkOf("TRACE").sink.write("app", "ERROR", "failed", { orderId: "ORD-1" }, failure);

    expect(spy).toHaveBeenCalledWith(
      "%c[%s]%c[ERROR]%c",
      STYLES.namespace,
      "app",
      STYLES.ERROR,
      "",
      "failed",
      failure,
      {
        orderId: "ORD-1",
      },
    );
  });

  it("prints a sanitized copy of the payload, not the caller's object", () => {
    // Devtools keeps a reference to each logged object. A copy releases the caller's object.
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const payload: Record<string, unknown> = { orderId: "ORD-1" };
    payload.self = payload;

    sinkOf("TRACE").sink.write("app", "INFO", "hello", payload);

    const printed = spy.mock.calls[0][6] as Record<string, unknown>;
    expect(printed).not.toBe(payload);
    expect(printed.orderId).toBe("ORD-1");
  });

  it("routes each level to its console method", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sink } = sinkOf("TRACE");

    sink.write("app", "TRACE", "t");
    sink.write("app", "FATAL", "f");

    expect(debug).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("takes a changed configuration through update", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { sink } = sinkOf(null);

    sink.write("app", "INFO", "before");
    sink.update({ level: "INFO", styles: STYLES });
    sink.write("app", "INFO", "after");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][5]).toBe("after");
  });

  it("returns quietly in a realm with no console", () => {
    vi.stubGlobal("console", undefined);

    expect(() => {
      sinkOf("TRACE").sink.write("app", "INFO", "nowhere");
    }).not.toThrow();
  });

  it("reports a console method that throws instead of failing the log call", () => {
    // A host can instrument console. Its fault must not reach the caller's log call.
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("instrumented");
    });
    const { sink, events } = sinkOf("TRACE");

    expect(() => {
      sink.write("app", "INFO", "hello");
    }).not.toThrow();
    expect(events[0].code).toBe("handler.threw");
    expect(events[0].message).toContain("console.info");
  });
});

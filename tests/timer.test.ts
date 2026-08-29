import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureLogger } from "../src/capture/types";
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
    expect(l.logMetric).not.toHaveBeenCalled();
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

  it("prints nothing at all when disabled", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    new ConsoleSink(false, "TRACE").write("INFO", "hello");

    expect(spy).not.toHaveBeenCalled();
  });

  it("respects its own level independently of the pipeline level", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    new ConsoleSink(true, "WARN").write("DEBUG", "quiet");

    expect(spy).not.toHaveBeenCalled();
  });

  it("prints a message with no payload", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    new ConsoleSink(true, "TRACE").write("INFO", "hello");

    expect(spy).toHaveBeenCalledWith("%c[ui-observability]%c INFO", "color:#888", "", "hello");
  });

  it("appends the payload when there is one", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    new ConsoleSink(true, "TRACE").write("WARN", "careful", { orderId: "ORD-1" });

    expect(spy).toHaveBeenCalledWith("%c[ui-observability]%c WARN", "color:#888", "", "careful", {
      orderId: "ORD-1",
    });
  });

  it("routes each level to its console method", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = new ConsoleSink(true, "TRACE");

    sink.write("TRACE", "t");
    sink.write("FATAL", "f");

    expect(debug).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("takes a changed configuration through update", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sink = new ConsoleSink(false, "TRACE");

    sink.write("INFO", "before");
    sink.update(true, "INFO");
    sink.write("INFO", "after");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][3]).toBe("after");
  });

  it("returns quietly in a realm with no console", () => {
    vi.stubGlobal("console", undefined);

    expect(() => {
      new ConsoleSink(true, "TRACE").write("INFO", "nowhere");
    }).not.toThrow();
  });
});

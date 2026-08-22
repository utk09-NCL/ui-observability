// tests/diagnostics.test.ts
import { describe, expect, it, vi } from "vitest";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";

describe("Diagnostics", () => {
  it("counts every report but emits at most once per throttle window", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler, 1000);

    for (let i = 0; i < 50; i++) {
      d.report("storage.quota_exceeded", "full");
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(d.snapshot()["storage.quota_exceeded"]).toBe(50);
    expect(handler.mock.calls[0][0].count).toBe(1);
  });

  it("emits again once the throttle window elapses, with the true cumulative count", () => {
    vi.useFakeTimers();
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler, 1000);

    d.report("transport.http_error", "first");
    d.report("transport.http_error", "still inside the window");
    d.report("transport.http_error", "still inside the window");

    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    d.report("transport.http_error", "window has elapsed");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0].count).toBe(4);
    expect(d.snapshot()["transport.http_error"]).toBe(4);
  });

  it("applies the default one-second throttle window when constructed without one", () => {
    vi.useFakeTimers();
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler);

    d.report("journey.expired", "first");
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(999);
    d.report("journey.expired", "still inside the default window");
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    d.report("journey.expired", "default window has elapsed");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not throw and still counts when there is no handler at all", () => {
    const d = new Diagnostics();

    expect(() => {
      d.report("bus.no_owner", "nobody claimed the bus");
    }).not.toThrow();
    expect(d.snapshot()["bus.no_owner"]).toBe(1);
  });

  it("setHandler installs a handler, and setHandler(undefined) clears it so later reports count but do not emit", () => {
    const d = new Diagnostics(undefined, 0);

    d.report("capture.install_failed", "no handler yet");
    expect(d.snapshot()["capture.install_failed"]).toBe(1);

    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    d.setHandler(handler);
    d.report("capture.install_failed", "handler installed");
    expect(handler).toHaveBeenCalledTimes(1);

    d.setHandler(undefined);
    d.report("capture.install_failed", "handler cleared");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(d.snapshot()["capture.install_failed"]).toBe(3);
  });

  it("survives a consumer handler that throws, reporting it to console.warn without recursing", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>(() => {
      throw new Error("consumer bug");
    });
    const d = new Diagnostics(handler, 0);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => {
      d.report("pipeline.crashed", "boom");
    }).not.toThrow();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(d.snapshot()["handler.threw"]).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[ui-observability] onDiagnostic handler threw",
      expect.any(Error),
    );
  });

  it("survives a consumer handler that throws even when there is no console to report it to", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>(() => {
      throw new Error("consumer bug");
    });
    const d = new Diagnostics(handler, 0);

    vi.stubGlobal("console", undefined);
    let threw = false;
    try {
      d.report("pipeline.crashed", "boom");
    } catch {
      threw = true;
    }
    vi.unstubAllGlobals();

    expect(threw).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(d.snapshot()["handler.threw"]).toBe(1);
  });

  it("count returns the running total, for the default increment and an explicit one", () => {
    const d = new Diagnostics();

    expect(d.count("record.truncated")).toBe(1);
    expect(d.count("record.truncated", 5)).toBe(6);
    expect(d.count("record.truncated")).toBe(7);
    expect(d.snapshot()["record.truncated"]).toBe(7);
  });

  it("passes detail and cause through onto the event, and sets at to the emission time", () => {
    vi.useFakeTimers();
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler, 0);
    const detail = { attempt: 3 };
    const cause = new Error("root cause");
    const emittedAt = Date.now();

    d.report("record.sanitize_failed", "failed to sanitize", detail, cause);

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.detail).toBe(detail);
    expect(event.cause).toBe(cause);
    expect(event.at).toBe(emittedAt);
  });

  it("guard returns the function's value and reports nothing on success", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler);

    const result = d.guard("config.invalid", "should not happen", () => 42);

    expect(result).toBe(42);
    expect(handler).not.toHaveBeenCalled();
    expect(d.snapshot()).toEqual({});
  });

  it("guard swallows a throw, returns undefined, and reports the code, message and cause", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler, 0);
    const error = new Error("no localStorage");

    const result = d.guard("storage.unavailable", "storage is blocked", () => {
      throw error;
    });

    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.code).toBe("storage.unavailable");
    expect(event.message).toBe("storage is blocked");
    expect(event.cause).toBe(error);
  });

  it("guardAsync resolves to the function's value on success", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler);

    const result = await d.guardAsync("transport.timeout", "should not happen", () =>
      Promise.resolve(7),
    );

    expect(result).toBe(7);
    expect(handler).not.toHaveBeenCalled();
  });

  it("guardAsync swallows a rejected promise, returns undefined, and reports the error as cause", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler, 0);
    const error = new Error("network down");

    const result = await d.guardAsync("transport.http_error", "request failed", () =>
      Promise.reject(error),
    );

    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.code).toBe("transport.http_error");
    expect(event.cause).toBe(error);
  });

  it("guardAsync also swallows a synchronous throw from the function it was handed", async () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler, 0);
    const error = new Error("sync boom");

    const result = await d.guardAsync("bus.send_failed", "send failed", () => {
      throw error;
    });

    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.code).toBe("bus.send_failed");
    expect(event.cause).toBe(error);
  });

  it("snapshot on a fresh instance is an empty object", () => {
    const d = new Diagnostics();

    expect(d.snapshot()).toEqual({});
  });

  it("reset clears the counters and the throttle window, so the next report emits immediately with a count of 1", () => {
    const handler = vi.fn<(event: DiagnosticEvent) => void>();
    const d = new Diagnostics(handler, 1000);

    d.report("journey.expired", "before reset");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(d.snapshot()["journey.expired"]).toBe(1);

    d.reset();
    expect(d.snapshot()).toEqual({});

    d.report("journey.expired", "right after reset, well inside what was the throttle window");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0].count).toBe(1);
  });
});

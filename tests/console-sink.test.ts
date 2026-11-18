// tests/console-sink.test.ts
//
// The console sink prints styled log lines for the local developer. These tests were in
// timer.test.ts until measure() replaced timeSync() and timeAsync().

import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_DEFAULT_STYLES as STYLES } from "../src/constants";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { ConsoleStyles } from "../src/models/config";
import type { LogLevel } from "../src/models/log-record";
import { ConsoleSink } from "../src/utils/console";

describe("ConsoleSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * A sink with the diagnostics throttle disabled, plus the events it reported.
   * @param level Mirroring threshold.
   * @param styles CSS styles for the prefix parts.
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

    // The namespace shows which part of the app a log came from.
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
    // Devtools keeps a reference to every logged object, so a copy releases the caller's object.
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
    // A host can instrument console, and its fault must not reach the caller's log call.
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

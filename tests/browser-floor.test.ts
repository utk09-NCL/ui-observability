// tests/browser-floor.test.ts
//
// The library supports browsers older than ES2022 (Chrome 85, Firefox 79, Safari 14.1), so it
// must not call an ES2022 built-in. These tests delete one and check that logging still works.
import { describe, expect, it, vi } from "vitest";
import { Diagnostics, type DiagnosticEvent } from "../src/core/diagnostics";
import { parseRemoteRules } from "../src/core/remote-rules";
import { configure, createMemoryTransport, flush, info } from "../src/index";
import type { ObservabilityConfig } from "../src/models/config";
import { TransportError } from "../src/transport/errors";

const hasOwn = Object.hasOwn;

/**
 * Runs the code with no Object.hasOwn, as Chrome 92, Firefox 91 or Safari 15.3 would. We put it
 * back before Vitest runs again, because Vitest calls it too.
 * @param run Code under test.
 * @returns What the code returns or throws.
 */
async function withoutHasOwn<T>(run: () => T | Promise<T>): Promise<T> {
  Reflect.deleteProperty(Object, "hasOwn");
  try {
    return await run();
  } finally {
    Object.defineProperty(Object, "hasOwn", { value: hasOwn, writable: true, configurable: true });
  }
}

/**
 * Configures a runtime that sends through a memory transport.
 * @param over Config values that override the base.
 * @returns The memory transport.
 */
function start(over: Partial<ObservabilityConfig> = {}): ReturnType<typeof createMemoryTransport> {
  const memory = createMemoryTransport();
  configure({
    endpoint: "https://ingest.example/v1/logs",
    transport: memory.transport,
    serviceName: "svc",
    storage: { backend: "memory" },
    identity: "memory",
    bus: { mode: "off" },
    capture: { errors: false, rejections: false },
    ...over,
  });
  return memory;
}

describe("a browser without Object.hasOwn", () => {
  it("prints a log call to the console without throwing", async () => {
    const print = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await withoutHasOwn(() => {
      start({ consoleOutput: true });
      info("shown in devtools");
    });

    expect(print).toHaveBeenCalled();
  });

  it("sends a record that a processor saw", async () => {
    const memory = await withoutHasOwn(async () => {
      const started = start({ processors: [(record) => record] });
      info("kept");
      await flush();
      return started;
    });

    expect(memory.records().map((record) => record.body)).toContain("kept");
  });

  it("accepts a second configure() call that changes no startup setting", async () => {
    const events: DiagnosticEvent[] = [];
    const onDiagnostic = (event: DiagnosticEvent): void => {
      events.push(event);
    };

    await withoutHasOwn(() => {
      start({ onDiagnostic });
      configure({ serviceName: "svc-2" });
    });

    expect(events.filter((event) => event.code === "config.invalid")).toEqual([]);
  });

  it("reads the server's sampling rules with level names", async () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);

    const update = await withoutHasOwn(() =>
      parseRemoteRules(
        { v: 1, ttlMs: 1000, minLevel: "WARN", minLevels: { orders: "DEBUG" } },
        diagnostics,
      ),
    );

    expect(update?.rules).toMatchObject({ minLevel: "WARN", minLevels: { orders: "DEBUG" } });
  });
});

describe("TransportError on a browser without the ES2022 cause option", () => {
  it("keeps the cause as an own property that JSON and Object.keys don't show", () => {
    const cause = new Error("socket closed");

    const error = new TransportError("offline", "The request failed.", 0, 0, 0, cause);

    expect(Object.getOwnPropertyDescriptor(error, "cause")).toEqual({
      value: cause,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    expect(Object.keys(error)).not.toContain("cause");
    expect(JSON.stringify(error)).not.toContain("socket closed");
  });

  it("has no cause property without a cause", () => {
    const error = new TransportError("offline", "The request failed.");

    expect(Object.hasOwn(error, "cause")).toBe(false);
  });
});

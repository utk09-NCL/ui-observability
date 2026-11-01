import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import { configure, createMemoryTransport, flush } from "../src/index";

const base = {
  endpoint: null,
  serviceName: "svc",
  storage: "memory",
  identity: "memory",
  bus: { mode: "off" },
} as const;

const runtime = (): ObservabilityRuntime => ObservabilityRuntime.current()!;

describe("diagnostics.records config", () => {
  it("keeps true, false and a list, and reports a wrong value", () => {
    const handler = vi.fn();
    const diagnostics = new Diagnostics(handler, 0);
    const resolve = (records: unknown) =>
      resolveConfig({ ...base, diagnostics: { records } } as never, diagnostics).diagnostics
        .records;

    expect(resolve(true)).toBe(true);
    expect(resolve(false)).toBe(false);
    expect(resolve(["transport.http_error", 5])).toEqual(["transport.http_error"]);
    expect(resolve("yes")).toBe(false);
    expect(handler.mock.calls.map(([event]) => event.message)).toEqual([
      "The library ignores the diagnostics.records entry 5. diagnostics.records must be true, false or a list of diagnostic codes.",
      'diagnostics.records must be true, false or a list of diagnostic codes. The value is "yes". The library keeps the value in force.',
    ]);
  });
});

describe("diagnostics.records", () => {
  it("sends a fault as a WARN system record in the diagnostics namespace", async () => {
    const memory = createMemoryTransport();
    configure({ ...base, transport: memory.transport, diagnostics: { records: true } });

    configure({ minLevel: "verbose" as never });
    await flush();

    const record = memory
      .records()
      .find((one) => one.attributes["diagnostic.code"] === "config.invalid");
    expect(record?.severityText).toBe("WARN");
    expect(record?.body).toContain("minLevel must be a level name");
    expect(record?.attributes).toMatchObject({
      "app.namespace": "uiobs.diagnostics",
      "log.type": "system",
      "diagnostic.count": 1,
    });
  });

  it("sends only the listed codes, and gives a notice the level INFO", async () => {
    const memory = createMemoryTransport();
    configure({
      ...base,
      transport: memory.transport,
      diagnostics: { records: ["config.reconfigured"] },
    });

    configure({ minLevel: "verbose" as never });
    await flush();

    const codes = memory
      .records()
      .map((one) => [one.attributes["diagnostic.code"], one.severityText]);
    expect(codes).toEqual([["config.reconfigured", "INFO"]]);
  });

  it("gives no record for a diagnostic during the build of a diagnostic record", async () => {
    const memory = createMemoryTransport();
    configure({
      ...base,
      transport: memory.transport,
      diagnostics: { records: true, throttleMs: 0 },
      processors: [
        (record) => {
          if (record.attributes["diagnostic.code"] === "config.invalid") {
            runtime().diagnostics.report("storage.degraded", "A nested report.");
          }
          return record;
        },
      ],
    });

    configure({ minLevel: "verbose" as never });
    await flush();

    const codes = memory.records().map((one) => one.attributes["diagnostic.code"]);
    expect(codes).toContain("config.invalid");
    expect(codes).not.toContain("storage.degraded");
    expect(runtime().diagnostics.snapshot()["storage.degraded"]).toBe(1);
  });

  it("still gives each event to onDiagnostic", async () => {
    const onDiagnostic = vi.fn();
    configure({
      ...base,
      transport: createMemoryTransport().transport,
      diagnostics: { records: true },
      onDiagnostic,
    });

    configure({ minLevel: "verbose" as never });
    await flush();

    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "config.invalid" }));
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import { Sender } from "../src/core/sender";
import type { ObservabilityConfig, Transport } from "../src/models/config";
import {
  configure,
  createMemoryTransport,
  flush,
  getDiagnosticCounters,
  getLogger,
  rotateSecurityContext,
  shutdown,
} from "../src/index";

const base = {
  endpoint: null,
  serviceName: "svc",
  storage: { backend: "memory" },
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
      'diagnostics.records must be true, false or a list of diagnostic codes. The value is "yes". The library keeps the current value.',
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

  it("cuts the URL fields of a record and keeps them for onDiagnostic", async () => {
    const memory = createMemoryTransport();
    const onDiagnostic = vi.fn();
    configure({
      ...base,
      transport: memory.transport,
      onDiagnostic,
      diagnostics: { records: true },
    });
    await flush();

    const url = "https://api.example/x?token=K#part";
    runtime().diagnostics.report("capture.header_failed", "The header failed.", {
      url,
      endpoint: "https://user:pw@ingest.example/logs?key=K",
      status: 401,
    });
    await flush();

    const record = memory
      .records()
      .find((one) => one.attributes["diagnostic.code"] === "capture.header_failed");
    expect(record?.attributes["diagnostic.detail"]).toEqual({
      url: "https://api.example/x",
      endpoint: "https://ingest.example/logs",
      status: 401,
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ url }) }),
    );
  });

  it("sends the record of a finished rotation", async () => {
    const memory = createMemoryTransport();
    configure({
      ...base,
      transport: memory.transport,
      securityContext: { id: "old" },
      diagnostics: { records: ["security.rotated"] },
    });
    await flush();

    await rotateSecurityContext({ id: "new", routing: { transport: memory.transport } });
    await flush();

    expect(memory.records().map((one) => one.attributes["diagnostic.code"])).toContain(
      "security.rotated",
    );
  });

  it("builds a diagnostic record right away in defer mode", async () => {
    const memory = createMemoryTransport();
    configure({
      ...base,
      transport: memory.transport,
      payloadMode: "defer",
      diagnostics: { records: true },
    });
    await flush();

    const emit = vi.spyOn(runtime(), "emit");
    runtime().diagnostics.report("transport.http_error", "The send failed.");
    expect(emit).toHaveBeenCalledOnce();
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

  it("builds no record for a diagnostic raised while building a diagnostic record", async () => {
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

type Memory = ReturnType<typeof createMemoryTransport>;

/** Lists the code of each diagnostic record that a memory transport accepted. */
const diagnosticCodes = (memory: Memory): unknown[] =>
  memory
    .records()
    .map((one) => one.attributes["diagnostic.code"])
    .filter((code) => code !== undefined);

/** Returns the text of the config.invalid report for a relative URL, as the page resolves it. */
const relative = (key: string): string =>
  `${key} is relative. The library sends to ${new URL(document.baseURI).origin}.`;

/** Returns the text of the config.invalid report for a routing key that a rotation ignores. */
const ignored = (key: string): string =>
  `rotateSecurityContext() ignores routing.${key}. ` +
  "A rotation changes only the routing settings.";

/** Starts the runtime in context "old", with every diagnostic sent as a record and no throttle. */
async function startRecording(
  transport: Transport,
  extra: Partial<ObservabilityConfig> = {},
): Promise<void> {
  configure({
    ...base,
    transport,
    securityContext: { id: "old" },
    diagnostics: { records: true, throttleMs: 0 },
    ...extra,
  });
  await flush();
}

describe("diagnostics.records during a rotation", () => {
  it.each([
    ["endpoint", { endpoint: "/uilogs" }],
    ["metricsEndpoint", { metricsEndpoint: "/telemetry/v1/metrics" }],
    ["tracesEndpoint", { tracesEndpoint: "/telemetry/v1/traces" }],
  ] as const)(
    "delivers the config.invalid record of a relative %s in the new context",
    async (key, urls) => {
      const old = createMemoryTransport();
      const next = createMemoryTransport();
      await startRecording(old.transport);

      await rotateSecurityContext({ id: "new", routing: { transport: next.transport, ...urls } });
      await flush();

      const record = next
        .records()
        .find((one) => one.attributes["diagnostic.code"] === "config.invalid");
      expect(record?.body).toBe(relative(key));
      expect(record?.attributes).toMatchObject({
        "app.namespace": "uiobs.diagnostics",
        "diagnostic.code": "config.invalid",
      });
      expect(diagnosticCodes(old)).not.toContain("config.invalid");
      expect(getDiagnosticCounters()["record.dropped_during_rotation"]).toBeUndefined();
    },
  );

  it("delivers the record when diagnostics.records is a list with config.invalid", async () => {
    const next = createMemoryTransport();
    await startRecording(createMemoryTransport().transport, {
      diagnostics: { records: ["config.invalid"], throttleMs: 0 },
    });

    await rotateSecurityContext({
      id: "new",
      routing: { transport: next.transport, tracesEndpoint: "/telemetry/v1/traces" },
    });
    await flush();

    expect(diagnosticCodes(next)).toEqual(["config.invalid"]);
    expect(getDiagnosticCounters()["record.dropped_during_rotation"]).toBeUndefined();
  });

  it("sends no config.invalid record when the list leaves that code out", async () => {
    const next = createMemoryTransport();
    await startRecording(createMemoryTransport().transport, {
      diagnostics: { records: ["security.rotated"], throttleMs: 0 },
    });

    await rotateSecurityContext({
      id: "new",
      routing: { transport: next.transport, tracesEndpoint: "/telemetry/v1/traces" },
    });
    await flush();

    expect(diagnosticCodes(next)).toEqual(["security.rotated"]);
    expect(getDiagnosticCounters()["record.dropped_during_rotation"]).toBeUndefined();
  });

  it("still gives onDiagnostic and the counters the report while the rotation runs", async () => {
    const onDiagnostic = vi.fn();
    await startRecording(createMemoryTransport().transport, { onDiagnostic });
    // Holds the new context's sender load, so the rotation stops after it resolved the routing.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const create = Sender.create.bind(Sender);
    let loading = false;
    vi.spyOn(Sender, "create").mockImplementation(async (options) => {
      loading = true;
      await gate;
      return create(options);
    });

    const rotation = rotateSecurityContext({
      id: "new",
      routing: {
        transport: createMemoryTransport().transport,
        tracesEndpoint: "/telemetry/v1/traces",
      },
    });
    try {
      await vi.waitFor(() => {
        expect(loading).toBe(true);
      });

      // The app hears about the fault now, not when the rotation ends.
      expect(onDiagnostic).toHaveBeenCalledTimes(1);
      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "config.invalid",
          count: 1,
          message: relative("tracesEndpoint"),
        }),
      );
      expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
    } finally {
      open();
    }
    await rotation;

    expect(onDiagnostic.mock.calls.map(([event]) => event.code)).toEqual([
      "config.invalid",
      "security.rotated",
    ]);
    expect(getDiagnosticCounters()).toMatchObject({ "config.invalid": 1, "security.rotated": 1 });
  });

  it("drops and counts a diagnostic record that the old context's flush raises", async () => {
    const old = createMemoryTransport();
    // A batch of one record that the server refuses as too large is dropped, and the diagnostic
    // carries the record's body.
    old.respondWith(413);
    const next = createMemoryTransport();
    await startRecording(old.transport);
    getLogger("pay").info("user A secret");

    await rotateSecurityContext(
      { id: "new", routing: { transport: next.transport } },
      { pending: "flush" },
    );
    await flush();

    expect(diagnosticCodes(next)).toEqual(["security.rotated"]);
    expect(JSON.stringify(next.records())).not.toContain("user A secret");
    // Two reports came from the old flush: the permanent drop and the failed send.
    expect(getDiagnosticCounters()).toMatchObject({
      "transport.dropped_permanent": 1,
      "transport.http_error": 1,
      "record.dropped_during_rotation": 2,
    });
  });

  it("delivers the config.invalid record but not the old flush's diagnostic records", async () => {
    const old = createMemoryTransport();
    old.respondWith(413);
    const next = createMemoryTransport();
    await startRecording(old.transport);
    getLogger("pay").info("user A secret");

    await rotateSecurityContext(
      {
        id: "new",
        routing: { transport: next.transport, tracesEndpoint: "/telemetry/v1/traces" },
      },
      { pending: "flush" },
    );
    await flush();

    const codes = diagnosticCodes(next);
    expect(codes).toContain("config.invalid");
    expect(codes).not.toContain("transport.dropped_permanent");
    expect(codes).not.toContain("transport.http_error");
    expect(JSON.stringify(next.records())).not.toContain("user A secret");
    expect(getDiagnosticCounters()["record.dropped_during_rotation"]).toBe(2);
  });

  it("delivers no record of a rejected rotation, also after a later rotation", async () => {
    const next = createMemoryTransport();
    const onDiagnostic = vi.fn();
    await startRecording(createMemoryTransport().transport, { onDiagnostic });

    await expect(
      rotateSecurityContext({
        id: "failed",
        routing: { tracesEndpoint: "/telemetry/v1/traces", credentials: "bogus" as never },
      }),
    ).rejects.toThrow("Invalid routing settings");
    await rotateSecurityContext({ id: "new", routing: { transport: next.transport } });
    await flush();

    // The app still hears about the failed rotation's report.
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "config.invalid", message: relative("tracesEndpoint") }),
    );
    // The later rotation's own record proves that the new context sends diagnostics.
    const codes = diagnosticCodes(next);
    expect(codes).toContain("security.rotated");
    expect(codes).not.toContain("config.invalid");
  });

  it("delivers no record of a rotation that shutdown() stops", async () => {
    const old = createMemoryTransport();
    const next = createMemoryTransport();
    await startRecording(old.transport);
    // Holds the new context's sender load, so shutdown() lands inside the rotation.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const create = Sender.create.bind(Sender);
    let loading = false;
    vi.spyOn(Sender, "create").mockImplementation(async (options) => {
      loading = true;
      await gate;
      return create(options);
    });
    const outcome = rotateSecurityContext({
      id: "new",
      routing: { transport: next.transport, tracesEndpoint: "/telemetry/v1/traces" },
    }).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    try {
      await vi.waitFor(() => {
        expect(loading).toBe(true);
      });
    } finally {
      const stopping = shutdown();
      open();
      await stopping;
    }

    expect(await outcome).toBe("Error: The runtime has stopped.");
    expect([...diagnosticCodes(old), ...diagnosticCodes(next)]).not.toContain("config.invalid");
  });

  it("delivers only the record of the last of two queued rotations", async () => {
    const middle = createMemoryTransport();
    const next = createMemoryTransport();
    await startRecording(createMemoryTransport().transport);

    // The second call starts before the first one ends, so the flag stays up between them.
    const first = rotateSecurityContext({
      id: "middle",
      routing: { transport: middle.transport, tracesEndpoint: "/one/v1/traces" },
    });
    const second = rotateSecurityContext({
      id: "new",
      routing: { transport: next.transport, metricsEndpoint: "/two/v1/metrics" },
    });
    await first;
    await second;
    await flush();

    const bodies = next
      .records()
      .filter((one) => one.attributes["diagnostic.code"] === "config.invalid")
      .map((one) => one.body);
    expect(bodies).toEqual([relative("metricsEndpoint")]);
  });

  it("delivers the report of an ignored routing key in the new context", async () => {
    const next = createMemoryTransport();
    await startRecording(createMemoryTransport().transport);

    await rotateSecurityContext({
      id: "new",
      routing: { transport: next.transport, serviceName: "other" } as never,
    });
    await flush();

    const record = next
      .records()
      .find((one) => one.attributes["diagnostic.code"] === "config.invalid");
    expect(record?.body).toBe(ignored("serviceName"));
    expect(record?.attributes).toMatchObject({ "app.namespace": "uiobs.diagnostics" });
    expect(getDiagnosticCounters()["record.dropped_during_rotation"]).toBeUndefined();
  });

  it.each([
    [1, { credentials: "bogus" as never }],
    [2, { credentials: "bogus" as never, tracesEndpoint: "/telemetry/v1/traces" }],
  ])("counts the %i held record(s) of a rejected rotation as dropped", async (held, extra) => {
    const next = createMemoryTransport();
    // Only config.invalid becomes a record, so the failure report adds no other drop.
    await startRecording(createMemoryTransport().transport, {
      diagnostics: { records: ["config.invalid"], throttleMs: 0 },
    });

    // The transport keeps a signal endpoint from reporting that it has no way to send.
    await expect(
      rotateSecurityContext({ id: "failed", routing: { transport: next.transport, ...extra } }),
    ).rejects.toThrow("Invalid routing settings");
    const dropped = getDiagnosticCounters()["record.dropped_during_rotation"];
    await rotateSecurityContext({ id: "new", routing: { transport: next.transport } });
    await flush();

    expect(dropped).toBe(held);
    expect(getDiagnosticCounters()["record.dropped_during_rotation"]).toBe(held);
    expect(diagnosticCodes(next)).toEqual([]);
  });

  it("counts the held record of a rotation that shutdown() stops as dropped", async () => {
    const next = createMemoryTransport();
    await startRecording(createMemoryTransport().transport, {
      diagnostics: { records: ["config.invalid"], throttleMs: 0 },
    });
    // The counters outlive the stopped runtime, so a reference keeps them readable.
    const { diagnostics } = runtime();
    // Holds the new context's sender load, so shutdown() lands after the plan held its record.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const create = Sender.create.bind(Sender);
    let loading = false;
    vi.spyOn(Sender, "create").mockImplementation(async (options) => {
      loading = true;
      await gate;
      return create(options);
    });
    const outcome = rotateSecurityContext({
      id: "new",
      routing: { transport: next.transport, tracesEndpoint: "/telemetry/v1/traces" },
    }).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    try {
      await vi.waitFor(() => {
        expect(loading).toBe(true);
      });
    } finally {
      const stopping = shutdown();
      open();
      await stopping;
    }

    expect(await outcome).toBe("Error: The runtime has stopped.");
    expect(diagnostics.snapshot()["record.dropped_during_rotation"]).toBe(1);
    expect(diagnosticCodes(next)).toEqual([]);
  });

  it("counts the held record of the first of two queued rotations as dropped", async () => {
    const middle = createMemoryTransport();
    const next = createMemoryTransport();
    await startRecording(createMemoryTransport().transport, {
      diagnostics: { records: ["config.invalid"], throttleMs: 0 },
    });

    const first = rotateSecurityContext({
      id: "middle",
      routing: { transport: middle.transport, tracesEndpoint: "/one/v1/traces" },
    });
    const second = rotateSecurityContext({
      id: "new",
      routing: { transport: next.transport, metricsEndpoint: "/two/v1/metrics" },
    });
    await first;
    await second;
    await flush();

    // Only the first rotation's record is dropped. The second one's goes to the new context.
    expect(getDiagnosticCounters()["record.dropped_during_rotation"]).toBe(1);
    expect(next.records().map((one) => one.body)).toEqual([relative("metricsEndpoint")]);
  });

  it("writes the held records in the order they were raised, before security.rotated", async () => {
    const next = createMemoryTransport();
    await startRecording(createMemoryTransport().transport);

    await rotateSecurityContext({
      id: "new",
      routing: {
        transport: next.transport,
        serviceName: "other",
        tracesEndpoint: "/telemetry/v1/traces",
      } as never,
    });
    await flush();

    const records = next.records().filter((one) => one.attributes["diagnostic.code"]);
    expect(records.map((one) => one.attributes["diagnostic.code"])).toEqual([
      "config.invalid",
      "config.invalid",
      "security.rotated",
    ]);
    expect(records.map((one) => one.body)).toEqual([
      ignored("serviceName"),
      relative("tracesEndpoint"),
      "The runtime rotated its security context.",
    ]);
    const sequence = records.map((one) => one.attributes["log.seq"] as number);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });
});

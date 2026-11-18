// tests/config-shape.test.ts
//
// The config shape of 1.0: one interval for every metric point, separate windows for replay
// uploads and the error ceiling, strict bus checks only, a bus role that's fixed at startup,
// and a rotation that loads its own chunk.

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { Bus } from "../src/bus/bus";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import type { BusMessage } from "../src/models/bus";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import {
  configure,
  counter,
  createMemoryTransport,
  flush,
  getHealth,
  getLogger,
  profiler,
  rotateSecurityContext,
} from "../src/index";

/** A runtime config with no network, no captures and no bus. */
const base = {
  serviceName: "shape",
  identity: "memory",
  storage: { backend: "memory" },
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
  diagnostics: { throttleMs: 0 },
} as ObservabilityConfig;

/** A config that resolves cleanly, so a test can assert on silence. */
const valid = (): ObservabilityConfig => ({
  endpoint: "https://ingest.example/v1/logs",
  serviceName: "shape",
});

/** A diagnostics instance with no throttle, so a test sees every report of one resolve. */
function collect(): { events: DiagnosticEvent[]; diagnostics: Diagnostics } {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  return { events, diagnostics };
}

const messages = (events: DiagnosticEvent[]): string[] => events.map((event) => event.message);

const runtime = (): ObservabilityRuntime => ObservabilityRuntime.current()!;

describe("metrics.intervalMs", () => {
  it("sends counter points and probe points at the one metrics interval", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const memory = createMemoryTransport();
    configure({
      ...base,
      transport: memory.transport,
      metrics: { intervalMs: 2000 },
      profiler: { enabled: true },
    });
    await flush();

    counter("clicks").add(1);
    const probe = profiler.probe("render");
    probe.end(probe.begin());
    // One interval collects the points, and the metric batch waits one more.
    await vi.advanceTimersByTimeAsync(4000);

    const bodies = memory.records().map((record) => record.body);
    expect(bodies).toEqual(expect.arrayContaining(["clicks", "ui.profile.duration"]));
  });

  it("accepts 1000 to 600000 and reports the two old interval keys as unknown", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig(
      {
        ...valid(),
        metrics: { intervalMs: 999 },
        batching: { metricFlushIntervalMs: 5000 },
        profiler: { flushIntervalMs: 5000 },
      } as ObservabilityConfig,
      diagnostics,
    );

    expect(resolved.metrics.intervalMs).toBe(10_000);
    expect(messages(events)).toEqual([
      "metrics.intervalMs must be an integer from 1000 to 600000. The value is 999. The library keeps 10000.",
      'The library ignores the unknown config key "batching.metricFlushIntervalMs". Check the spelling.',
      'The library ignores the unknown config key "profiler.flushIntervalMs". Check the spelling.',
    ]);
  });
});

describe("the error ceiling's own window", () => {
  it("limits ERROR records with sampling.errorCeiling in sampling.errorCeilingWindowMs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const memory = createMemoryTransport();
    configure({
      ...base,
      transport: memory.transport,
      captureLimits: { windowMs: 60_000 },
      sampling: { errorCeiling: 1, errorCeilingWindowMs: 1000 },
    });
    // The ceiling counts when a record reaches the pipeline, so the stack must be loaded.
    await flush();
    const log = getLogger("app");

    log.error("first");
    log.error("second");
    // The capture window is a minute long, but the ceiling's own window has ended.
    vi.setSystemTime(Date.now() + 1001);
    log.error("third");
    await flush();

    expect(memory.records().map((record) => record.body)).toEqual(["first", "third"]);
  });

  it("checks the ceiling, its window and the replay upload window, and drops the old key", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig(
      {
        ...valid(),
        sampling: { errorCeiling: null, errorCeilingWindowMs: 0 },
        replay: { uploadWindowMs: 0 },
        capturePolicy: { errorCeiling: 1 },
      } as ObservabilityConfig,
      diagnostics,
    );

    expect(resolved.sampling).toMatchObject({ errorCeiling: null, errorCeilingWindowMs: 10_000 });
    expect(resolved.replay.uploadWindowMs).toBe(10_000);
    expect(messages(events)).toEqual([
      "replay.uploadWindowMs must be an integer from 1 to 2147483647. The value is 0. The library keeps 10000.",
      "sampling.errorCeilingWindowMs must be an integer from 1 to 2147483647. The value is 0. The library keeps 10000.",
      'The library ignores the unknown config key "capturePolicy". Check the spelling.',
    ]);
  });
});

describe("the engine settings that are constants now", () => {
  it.each([
    ["delivery", "retryIdleDelayMs"],
    ["delivery", "batchesPerDrain"],
    ["correlation", "sessionTouchMs"],
    ["bus", "maxTrackedSources"],
    ["captureLimits", "maxErrorSignatures"],
  ])("reports %s.%s as an unknown key", (section, key) => {
    const { events, diagnostics } = collect();

    resolveConfig({ ...valid(), [section]: { [key]: 1 } }, diagnostics);

    expect(messages(events)).toEqual([
      `The library ignores the unknown config key "${section}.${key}". Check the spelling.`,
    ]);
  });
});

describe("bus message checks", () => {
  it("refuses a malformed record message and reports bus.validation as unknown", () => {
    const { events, diagnostics } = collect();
    const config = resolveConfig(
      {
        ...valid(),
        bus: { mode: "sender", sourcePolicy: "trusted-origin", validation: "envelope" },
      } as ObservabilityConfig,
      diagnostics,
    );
    const onRecords = vi.fn();
    const bus = new Bus(
      config,
      diagnostics,
      { platform: "browser", isTopLevelDocument: true, isWorker: false, userAgent: "test" },
      "host",
      "tab",
      {
        onRecords,
        onJourney: vi.fn(),
        onJourneyRequest: () => null,
        onTabConflict: vi.fn(),
        remote: { sampling: null },
      },
    );
    const message: BusMessage = {
      t: "ui-observability.message.records",
      from: "child",
      records: [{} as LogRecord],
    };

    bus["receive"](message, { link: "children", origin: location.origin });

    expect(onRecords).not.toHaveBeenCalled();
    expect(messages(events)).toContain(
      'The library ignores the unknown config key "bus.validation". Check the spelling.',
    );
    bus.destroy();
  });
});

describe("bus settings fixed at startup", () => {
  it.each([
    ["mode", "sender"],
    ["openFinRole", "client"],
  ] as const)("keeps bus.%s and reports a later change", (key, later) => {
    const events: DiagnosticEvent[] = [];
    configure({
      ...base,
      endpoint: null,
      onDiagnostic: (event) => {
        events.push(event);
      },
    });
    const before = runtime().config.bus[key];

    configure({ bus: { [key]: later } });

    expect(runtime().config.bus[key]).toBe(before);
    expect(messages(events)).toContain(
      `bus.${key} cannot change after startup. The library keeps "${before}".`,
    );
  });
});

describe("the rotation chunk", () => {
  it("rejects the rotation, closes delivery and reports it when the chunk fails to load", async () => {
    vi.doMock("../src/core/rotation", () => {
      throw new Error("The rotation chunk did not load.");
    });
    onTestFinished(() => {
      vi.doUnmock("../src/core/rotation");
    });
    const memory = createMemoryTransport();
    const events: DiagnosticEvent[] = [];
    configure({
      ...base,
      transport: memory.transport,
      securityContext: { id: "A" },
      onDiagnostic: (event) => {
        events.push(event);
      },
    });
    await flush();

    const rejection: unknown = await rotateSecurityContext({
      id: "B",
      routing: { transport: memory.transport },
    }).catch((error: unknown) => error);
    getLogger("app").info("after the failed rotation");
    await flush();

    expect(rejection).toBeInstanceOf(Error);
    expect(memory.records()).toEqual([]);
    expect(await getHealth()).toMatchObject({
      senderReady: false,
      issues: ["security.rotation_failed"],
    });
    expect(messages(events)).toEqual(
      expect.arrayContaining([
        "The library could not load the security-context rotation.",
        "The security-context rotation failed. The library sends no record until a rotation succeeds.",
      ]),
    );
  });
});

// tests/config-rules.test.ts
//
// The rules every configure() call follows: an omitted key or undefined keeps the current value,
// null clears a hook or turns a limit or an endpoint off, and a value of the wrong type keeps the
// current value with a report.

import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { ObservabilityRuntime } from "../src/core/runtime";
import type { DropSummary } from "../src/models/drop";
import type { ObservabilityConfig, ResolvedConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import {
  collectDebugBundle,
  configure,
  createMemoryTransport,
  flush,
  getDiagnosticCounters,
  getHealth,
  getLogger,
  histogram,
  rotateSecurityContext,
} from "../src/index";

const ENDPOINT = "https://ingest.example/v1/logs";

/** A diagnostics instance with no throttle, so a test sees every report of one resolve. */
function collect(): { events: DiagnosticEvent[]; diagnostics: Diagnostics } {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  return { events, diagnostics };
}

const messages = (events: DiagnosticEvent[]): string[] => events.map((event) => event.message);

/** A config that resolves cleanly, so a test can assert on silence. */
const valid = (): Partial<ObservabilityConfig> => ({ endpoint: ENDPOINT, serviceName: "checkout" });

/** One hook: its key, the input that sets it, and a reader for the resolved value. */
interface Hook {
  key: string;
  input: (value: unknown) => Partial<ObservabilityConfig>;
  read: (config: ResolvedConfig) => unknown;
  /** Settings the hook needs to have an effect. */
  needs?: Partial<ObservabilityConfig>;
}

const HOOKS: Hook[] = [
  { key: "redact", input: (value) => ({ redact: value as never }), read: (c) => c.redact },
  { key: "onDrop", input: (value) => ({ onDrop: value as never }), read: (c) => c.onDrop },
  {
    key: "onDiagnostic",
    input: (value) => ({ onDiagnostic: value as never }),
    read: (c) => c.onDiagnostic,
  },
  {
    key: "contextProvider",
    input: (value) => ({ contextProvider: value as never }),
    read: (c) => c.contextProvider,
  },
  {
    key: "otelLoader",
    input: (value) => ({ otelLoader: value as never }),
    read: (c) => c.otelLoader,
  },
  { key: "transport", input: (value) => ({ transport: value as never }), read: (c) => c.transport },
  {
    key: "transportOnExit",
    input: (value) => ({ transportOnExit: value as never }),
    read: (c) => c.transportOnExit,
    needs: { transport: () => Promise.resolve({ status: 200 }) },
  },
  {
    key: "transportWorker",
    input: (value) => ({ transportWorker: value as never }),
    read: (c) => c.transportWorker,
  },
  {
    key: "capture.urlTransform",
    input: (value) => ({ capture: { urlTransform: value as never } }),
    read: (c) => c.capture.urlTransform,
  },
  {
    key: "capture.webVitals.loader",
    input: (value) => ({ capture: { webVitals: { loader: value as never } } }),
    read: (c) => (c.capture.webVitals as { loader?: unknown }).loader,
  },
];

describe("undefined keeps the current value", () => {
  it("keeps redact on a record after configure() passes redact: undefined", () => {
    const redact = vi.fn((record: LogRecord) => ({ ...record, body: "[redacted]" }));
    configure({ ...valid(), consoleOutput: "DEBUG", redact });
    configure({ redact: undefined });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    getLogger("pay").info("card 4111");

    // A dropped redact would print the raw body, and a host can record console arguments.
    expect(redact).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(" ")).toContain("[redacted]");
    expect(spy.mock.calls[0].join(" ")).not.toContain("4111");
    spy.mockRestore();
  });

  it.each(HOOKS)("keeps $key when the next call passes undefined", ({ input, read, needs }) => {
    const { events, diagnostics } = collect();
    const hook = vi.fn();
    const live = resolveConfig({ ...valid(), ...needs, ...input(hook) }, diagnostics);

    const next = resolveConfig({ ...input(undefined) }, diagnostics, live);

    expect(read(next)).toBe(hook);
    expect(messages(events)).toEqual([]);
  });

  it("keeps the headers when the next call passes headers: undefined", () => {
    const { events, diagnostics } = collect();
    const headers = { authorization: "Bearer one" };
    const live = resolveConfig({ ...valid(), headers }, diagnostics);

    expect(resolveConfig({ headers: undefined }, diagnostics, live).headers).toBe(headers);
    expect(messages(events)).toEqual([]);
  });
});

describe("null clears a hook", () => {
  it.each(HOOKS)("clears $key when the next call passes null", ({ input, read, needs }) => {
    const { events, diagnostics } = collect();
    const live = resolveConfig({ ...valid(), ...needs, ...input(vi.fn()) }, diagnostics);

    const next = resolveConfig({ ...input(null) }, diagnostics, live);

    expect(read(next)).toBeUndefined();
    expect(messages(events)).toEqual([]);
  });

  it("clears the headers when the next call passes headers: null", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), headers: { authorization: "Bearer one" } },
      diagnostics,
    );

    expect(resolveConfig({ headers: null }, diagnostics, live).headers).toBeUndefined();
    expect(messages(events)).toEqual([]);
  });
});

describe("a hook that isn't a function", () => {
  it.each(HOOKS)("keeps the current $key and reports a value that isn't a function", (hook) => {
    const { key, input, read, needs } = hook;
    const { events, diagnostics } = collect();
    const current = vi.fn();
    const live = resolveConfig({ ...valid(), ...needs, ...input(current) }, diagnostics);

    const next = resolveConfig({ ...input("nope") }, diagnostics, live);

    expect(read(next)).toBe(current);
    expect(messages(events)).toEqual([
      `${key} must be a function or null. The value is a string. The library keeps the current value.`,
    ]);
  });
});

/** Reads one key of one section of a resolved config. */
const valueAt = (config: ResolvedConfig, section: string, key: string): unknown =>
  (config[section as keyof ResolvedConfig] as Record<string, unknown>)[key];

/** Builds the input that sets one key of one section. */
const inputAt = (section: string, key: string, value: unknown): Partial<ObservabilityConfig> => ({
  [section]: { [key]: value },
});

/** Limit keys where 0 means zero, so nothing is allowed. */
const ZERO_MEANS_ZERO = [
  ["captureLimits", "errorsPerWindow"],
  ["captureLimits", "consolePerWindow"],
  ["captureLimits", "longFramesPerWindow"],
  ["captureLimits", "webSocketPerWindow"],
  ["captureLimits", "reportsPerWindow"],
  ["captureLimits", "resourcesPerWindow"],
  ["captureLimits", "lifecyclePerWindow"],
  ["sampling", "errorCeiling"],
  ["metrics", "maxSeries"],
  ["metrics", "maxInstruments"],
  ["metrics", "maxHistogramBoundaries"],
  ["replay", "uploadsPerWindow"],
] as const;

/** Limit keys where zero capacity makes no sense, with the lowest value and the default. */
const ZERO_REFUSED = [
  ["correlation", "sessionIdleMs", "1 to 2147483647", 1_800_000],
  ["correlation", "traceMaxAgeMs", "1 to 2147483647", 300_000],
  ["buffering", "maxPendingRecords", "1 to 9007199254740991", 10_000],
  ["buffering", "maxPendingBytes", "1 to 9007199254740991", 16_777_216],
  ["debugBuffer", "maxAgeMs", "1 to 2147483647", 60_000],
  ["bus", "maxMessageBytes", "1 to 9007199254740991", 262_144],
  ["bus", "maxRecordsPerMessage", "1 to 9007199254740991", 100],
  ["bus", "maxMessagesPerSecond", "1 to 9007199254740991", 100],
  ["retention", "maxAgeMs", "60000 to 604800000", 86_400_000],
  ["retention", "maxAttempts", "1 to 20", 5],
] as const;

/** Every key that takes null for no limit, as a section and a key. */
const NULLABLE: (readonly [string, string])[] = [
  ...ZERO_MEANS_ZERO,
  ...ZERO_REFUSED.map(([section, key]) => [section, key] as const),
];

describe("null means no limit, and 0 means zero", () => {
  it.each(NULLABLE)("takes null for %s.%s", (section, key) => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ ...valid(), ...inputAt(section, key, null) }, diagnostics);

    expect(valueAt(resolved, section, key)).toBeNull();
    expect(messages(events)).toEqual([]);
  });

  it.each(ZERO_MEANS_ZERO)("takes 0 for %s.%s as a limit of zero", (section, key) => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ ...valid(), ...inputAt(section, key, 0) }, diagnostics);

    expect(valueAt(resolved, section, key)).toBe(0);
    expect(messages(events)).toEqual([]);
  });

  it.each(ZERO_REFUSED)(
    "refuses 0 for %s.%s and keeps the current value",
    (section, key, range, kept) => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig({ ...valid(), ...inputAt(section, key, 0) }, diagnostics);

      expect(valueAt(resolved, section, key)).toBe(kept);
      expect(messages(events)).toEqual([
        `${section}.${key} must be an integer from ${range}, or null for no limit. The value is 0. The library keeps ${String(kept)}.`,
      ]);
    },
  );

  it("keeps a null limit when the next call passes undefined", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig({ ...valid(), bus: { maxMessageBytes: null } }, diagnostics);

    const next = resolveConfig({ bus: { maxMessageBytes: undefined } }, diagnostics, live);

    expect(next.bus.maxMessageBytes).toBeNull();
    expect(messages(events)).toEqual([]);
  });

  it("refuses a window of 0 ms and null, because only the limits can turn rate limiting off", () => {
    const { events, diagnostics } = collect();

    const zero = resolveConfig({ ...valid(), captureLimits: { windowMs: 0 } }, diagnostics);
    const none = resolveConfig(
      { ...valid(), captureLimits: { windowMs: null as unknown as number } },
      diagnostics,
    );

    expect(zero.captureLimits.windowMs).toBe(10_000);
    expect(none.captureLimits.windowMs).toBe(10_000);
    expect(messages(events)).toEqual([
      "captureLimits.windowMs must be an integer from 1 to 2147483647. The value is 0. The library keeps 10000.",
      "captureLimits.windowMs must be an integer from 1 to 2147483647. The value is null. The library keeps 10000.",
    ]);
  });

  it("keeps every default limit above zero", () => {
    const resolved = resolveConfig(valid(), collect().diagnostics);

    for (const [section, key] of NULLABLE) {
      expect(valueAt(resolved, section, key)).toBeGreaterThan(0);
    }
  });
});

/** The four endpoints, the input that sets each one and a reader for the resolved value. */
const ENDPOINTS: [
  string,
  (value: unknown) => Partial<ObservabilityConfig>,
  (c: ResolvedConfig) => unknown,
][] = [
  ["endpoint", (value) => ({ endpoint: value as never }), (c) => c.endpoint],
  ["metricsEndpoint", (value) => ({ metricsEndpoint: value as never }), (c) => c.metricsEndpoint],
  ["tracesEndpoint", (value) => ({ tracesEndpoint: value as never }), (c) => c.tracesEndpoint],
  [
    "replay.endpoint",
    (value) => ({ replay: { endpoint: value as never } }),
    (c) => c.replay.endpoint,
  ],
];

describe("null turns an endpoint off", () => {
  it("turns every endpoint but the log endpoint off by default", () => {
    const resolved = resolveConfig(valid(), collect().diagnostics);

    expect(resolved.metricsEndpoint).toBeNull();
    expect(resolved.tracesEndpoint).toBeNull();
    expect(resolved.replay.endpoint).toBeNull();
  });

  it.each(ENDPOINTS)("turns %s off with null", (_key, input, read) => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), ...input("https://ingest.example/v1/other") },
      diagnostics,
    );

    // A custom transport keeps the delivery stack, so null on endpoint reports nothing.
    const next = resolveConfig(
      { transport: () => Promise.resolve({ status: 200 }), ...input(null) },
      diagnostics,
      live,
    );

    expect(read(next)).toBeNull();
    expect(next.capture.ignoreUrls).not.toContain("https://ingest.example/v1/other");
    expect(messages(events)).toEqual([]);
  });

  it.each(ENDPOINTS.slice(1))(
    "turns %s off with an empty string, and says to use null",
    (key, input, read) => {
      const { events, diagnostics } = collect();
      const live = resolveConfig(
        { ...valid(), ...input("https://ingest.example/v1/other") },
        diagnostics,
      );

      const next = resolveConfig(input(""), diagnostics, live);

      // An empty environment variable must not leave the records going to the old destination.
      expect(read(next)).toBeNull();
      expect(messages(events)).toEqual([
        `${key} is empty. The library turns it off. Use null to turn it off.`,
      ]);
    },
  );

  it("treats an empty endpoint as a missing endpoint", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ endpoint: "", serviceName: "checkout" }, diagnostics);

    expect(resolved.endpoint).toBe("");
    expect(messages(events)).toEqual([
      "endpoint is missing. The library drops each record. Set endpoint: null for console-only mode.",
    ]);
  });

  it("refuses an endpoint that isn't a string or null, and prints only its type", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(valid(), diagnostics);

    const next = resolveConfig({ endpoint: 8080 as unknown as string }, diagnostics, live);
    const urls = resolveConfig(
      { metricsEndpoint: ["https://user:pw@x"] as unknown as string },
      diagnostics,
      live,
    );

    expect(next.endpoint).toBe(ENDPOINT);
    expect(urls.metricsEndpoint).toBeNull();
    expect(messages(events)).toEqual([
      "endpoint must be a URL string or null. The value is a number. The library keeps the current value.",
      "metricsEndpoint must be a URL string or null. The value is a list. The library keeps the current value.",
    ]);
  });

  it("keeps the text of an invalid URL out of the message", () => {
    const { events, diagnostics } = collect();

    resolveConfig({ ...valid(), tracesEndpoint: "http://[token-abc" }, diagnostics);

    expect(messages(events)).toEqual([
      "tracesEndpoint is not a valid URL. The library keeps the current value.",
    ]);
  });

  it.each(ENDPOINTS.slice(1))("turns %s off with a blank string", (key, input, read) => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), ...input("https://ingest.example/v1/other") },
      diagnostics,
    );

    expect(read(resolveConfig(input("   "), diagnostics, live))).toBeNull();
    expect(messages(events)).toEqual([
      `${key} is empty. The library turns it off. Use null to turn it off.`,
    ]);
  });

  it("refuses a blank endpoint and keeps the current one", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(valid(), diagnostics);

    expect(resolveConfig({ endpoint: "   " }, diagnostics, live).endpoint).toBe(ENDPOINT);
    expect(messages(events)).toEqual(["endpoint is blank. The library keeps the current value."]);
  });

  it.each(ENDPOINTS)("refuses a %s with a user name or a password", (key, input, read) => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(valid(), diagnostics);

    const next = resolveConfig(input("https://user:pw@ingest.example/v1"), diagnostics, live);

    expect(read(next)).toBe(read(live));
    expect(messages(events)).toEqual([
      `${key} has a user name or a password. The library keeps the current value.`,
    ]);
  });

  it.each(ENDPOINTS)(
    "resolves a relative %s against the page, and names the origin",
    (key, input, read) => {
      const { events, diagnostics } = collect();

      const relative = resolveConfig({ ...valid(), ...input("/v1/other") }, diagnostics);
      const schemeless = resolveConfig(
        { ...valid(), ...input("//evil.example/ingest") },
        diagnostics,
      );

      expect(read(relative)).toBe(new URL("/v1/other", document.baseURI).href);
      expect(read(schemeless)).toBe("http://evil.example/ingest");
      expect(messages(events)).toEqual([
        `${key} is relative. The library sends to ${new URL(document.baseURI).origin}.`,
        `${key} is relative. The library sends to http://evil.example.`,
      ]);
    },
  );

  it("resolves a relative endpoint against the location when there is no document", () => {
    const { events, diagnostics } = collect();
    vi.stubGlobal("document", undefined);

    const resolved = resolveConfig({ ...valid(), endpoint: "/v1/worker" }, diagnostics);

    expect(resolved.endpoint).toBe(new URL("/v1/worker", location.href).href);
    expect(messages(events)).toEqual([
      `endpoint is relative. The library sends to ${location.origin}.`,
    ]);
    vi.unstubAllGlobals();
  });

  it("refuses a relative endpoint when the scope has no document and no location", () => {
    const { events, diagnostics } = collect();
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("location", undefined);

    const resolved = resolveConfig({ ...valid(), endpoint: "/v1/worker" }, diagnostics);

    vi.unstubAllGlobals();
    expect(resolved.endpoint).toBe("");
    expect(messages(events)).toEqual([
      "endpoint is not a valid URL. The library keeps the current value.",
      "endpoint is missing. The library drops each record. Set endpoint: null for console-only mode.",
    ]);
  });
});

describe("a new sampling.rates map replaces the current one", () => {
  it("drops a namespace that the new map leaves out", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), sampling: { rates: { "app.blotter": 0.5, "app.ticket": 0.1 } } },
      diagnostics,
    );

    const next = resolveConfig({ sampling: { rates: { "app.ticket": 0.2 } } }, diagnostics, live);

    expect(next.sampling.rates).toEqual({ "app.ticket": 0.2 });
    expect(messages(events)).toEqual([]);
  });

  it("keeps the map on undefined, and clears it with an empty map", () => {
    const { diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), sampling: { rates: { "app.blotter": 0.5 } } },
      diagnostics,
    );

    expect(
      resolveConfig({ sampling: { rates: undefined } }, diagnostics, live).sampling.rates,
    ).toEqual({ "app.blotter": 0.5 });
    expect(resolveConfig({ sampling: { rates: {} } }, diagnostics, live).sampling.rates).toEqual(
      {},
    );
  });

  it("refuses a rates value that isn't an object and keeps the current map", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), sampling: { rates: { "app.blotter": 0.5 } } },
      diagnostics,
    );
    const notAMap = null as unknown as Record<string, number>;

    const next = resolveConfig({ sampling: { rates: notAMap } }, diagnostics, live);

    expect(next.sampling.rates).toEqual({ "app.blotter": 0.5 });
    expect(messages(events)).toEqual([
      "sampling.rates must be an object of rates. The value is null. The library keeps the current value.",
    ]);
  });
});

describe("undefined and null on the sampling rates", () => {
  it("keeps the current defaultRate and remoteMaxRate when the next call passes undefined", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), sampling: { defaultRate: 0.5, remoteMaxRate: 0.25 } },
      diagnostics,
    );

    const next = resolveConfig(
      { sampling: { defaultRate: undefined, remoteMaxRate: undefined } },
      diagnostics,
      live,
    );

    expect(next.sampling.defaultRate).toBe(0.5);
    expect(next.sampling.remoteMaxRate).toBe(0.25);
    expect(messages(events)).toEqual([]);
  });

  it("refuses null for defaultRate and keeps the current rate", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig({ ...valid(), sampling: { defaultRate: 0.5 } }, diagnostics);

    const next = resolveConfig(
      { sampling: { defaultRate: null as unknown as number } },
      diagnostics,
      live,
    );

    expect(next.sampling.defaultRate).toBe(0.5);
    expect(messages(events)).toEqual([
      "sampling.defaultRate must be 0..1. The value is null. The library keeps 0.5.",
    ]);
  });
});

describe("sampling.alwaysSampleTypes", () => {
  it("keeps each known log type and reports an unknown one", () => {
    const { events, diagnostics } = collect();
    const types = [
      "action",
      "evnt",
      "metric",
    ] as unknown as ResolvedConfig["sampling"]["alwaysSampleTypes"];

    const resolved = resolveConfig(
      { ...valid(), sampling: { alwaysSampleTypes: types } },
      diagnostics,
    );

    expect(resolved.sampling.alwaysSampleTypes).toEqual(["action", "metric"]);
    expect(messages(events)).toEqual([
      'The library ignores the sampling.alwaysSampleTypes entry "evnt". sampling.alwaysSampleTypes must be a list of log types: "action", "event", "metric", "log", "system" or "span".',
    ]);
  });
});

describe("a value of the wrong type keeps the current value", () => {
  it.each([
    [
      "serviceName",
      { serviceName: 5 },
      "serviceName must be a string. The value is 5. The library keeps the current value.",
    ],
    [
      "serviceVersion",
      { serviceVersion: null },
      "serviceVersion must be a string. The value is null. The library keeps the current value.",
    ],
    [
      "environment",
      { environment: {} },
      "environment must be a string. The value is an object. The library keeps the current value.",
    ],
    [
      "securityContext.id",
      { securityContext: { id: null } },
      "securityContext.id must be a string. The value is null. The library keeps the current value.",
    ],
  ])("refuses %s and keeps the current value", (_key, input, text) => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      {
        ...valid(),
        serviceVersion: "1.0.0",
        environment: "prod",
        securityContext: { id: "ctx-1" },
      },
      diagnostics,
    );

    const next = resolveConfig(input as Partial<ObservabilityConfig>, diagnostics, live);

    expect(next.serviceName).toBe("checkout");
    expect(next.serviceVersion).toBe("1.0.0");
    expect(next.environment).toBe("prod");
    expect(next.securityContext.id).toBe("ctx-1");
    expect(messages(events)).toEqual([text]);
  });

  it("keeps the current serializer when the next value isn't one", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig({ ...valid(), serializer: "ecs" }, diagnostics);
    const nothing = null as unknown as ObservabilityConfig["serializer"];

    expect(resolveConfig({ serializer: nothing }, diagnostics, live).serializer).toBe("ecs");
    expect(messages(events)).toEqual([
      'serializer must be "otlp", "ecs" or an implementation. The library keeps the current serializer.',
    ]);
  });

  it("drops a key the schema doesn't know instead of copying it into the config", () => {
    const { diagnostics } = collect();
    const input = { ...valid(), remoteUrl: "https://typo.example" } as Partial<ObservabilityConfig>;

    expect(resolveConfig(input, diagnostics)).not.toHaveProperty("remoteUrl");
  });
});

describe("settings that do nothing together", () => {
  const transport = (): Promise<{ status: number }> => Promise.resolve({ status: 200 });

  it("reports transport with transportWorker once, and keeps both", () => {
    const { events, diagnostics } = collect();
    const transportWorker = (): Worker => ({}) as Worker;

    const resolved = resolveConfig({ ...valid(), transport, transportWorker }, diagnostics);
    const later = resolveConfig({ minLevel: "WARN" }, diagnostics, resolved);

    expect(later.transport).toBe(transport);
    expect(later.transportWorker).toBe(transportWorker);
    expect(messages(events)).toEqual([
      "transportWorker has no effect with transport. The value stays.",
    ]);
  });

  it("reports transportOnExit without transport, and keeps it", () => {
    const { events, diagnostics } = collect();
    const transportOnExit = (): boolean => true;

    const resolved = resolveConfig({ ...valid(), transportOnExit }, diagnostics);

    expect(resolved.transportOnExit).toBe(transportOnExit);
    expect(messages(events)).toEqual([
      "transportOnExit has no effect without transport. The value stays.",
    ]);
  });

  it("reports capture.remoteToggles without sampling.remote, and stays quiet with it", () => {
    const { events, diagnostics } = collect();

    const alone = resolveConfig({ ...valid(), capture: { remoteToggles: ["fetch"] } }, diagnostics);
    resolveConfig({ sampling: { remote: true } }, diagnostics, alone);

    expect(alone.capture.remoteToggles).toEqual(["fetch"]);
    expect(messages(events)).toEqual([
      "capture.remoteToggles has no effect without sampling.remote. The value stays.",
    ]);
  });

  it("reports trace header targets without fetch or xhr capture", () => {
    const { events, diagnostics } = collect();
    const capture = { propagateTraceHeaderTo: ["https://api.example"] };

    const alone = resolveConfig({ ...valid(), capture }, diagnostics);
    resolveConfig({ capture: { ...capture, xhr: true } }, diagnostics, alone);
    resolveConfig({ capture: { ...capture, fetch: true } }, diagnostics, alone);

    expect(alone.capture.propagateTraceHeaderTo).toEqual(["https://api.example"]);
    expect(messages(events)).toEqual([
      "capture.propagateTraceHeaderTo has no effect without capture.fetch or capture.xhr. The value stays.",
    ]);
  });

  it.each([["fetch"], ["xhr"]] as const)(
    "accepts trace header targets when a remote rule can turn on %s capture",
    (toggle) => {
      const { events, diagnostics } = collect();

      resolveConfig(
        {
          ...valid(),
          sampling: { remote: true },
          capture: { remoteToggles: [toggle], propagateTraceHeaderTo: ["https://api.example"] },
        },
        diagnostics,
      );

      expect(messages(events)).toEqual([]);
    },
  );
});

describe("undefined inside the console styles", () => {
  it("keeps a style when the next call passes undefined for it, and reports nothing", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), consoleOutput: { styles: { INFO: "color:#0a7" } } },
      diagnostics,
    );

    const next = resolveConfig(
      { consoleOutput: { styles: { INFO: undefined, WARN: "color:#f80" } } },
      diagnostics,
      live,
    );

    expect(next.consoleOutput.styles.INFO).toBe("color:#0a7");
    expect(next.consoleOutput.styles.WARN).toBe("color:#f80");
    expect(messages(events)).toEqual([]);
  });
});

/** A runtime config that sends nothing to the network and stores nothing on the device. */
const quiet = {
  serviceName: "rules",
  storage: { backend: "memory" },
  identity: "memory",
  capture: { errors: false, rejections: false },
  bus: { mode: "off" },
} as const;

const rt = (): ObservabilityRuntime => ObservabilityRuntime.current()!;

/** Builds a record the way the builder would, for the paths that take a built record. */
const built = (body: string): LogRecord => ({
  timeUnixNano: "1",
  traceId: "0".repeat(32),
  spanId: "0".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes: { "log.type": "log", "app.namespace": "rules" },
  resource: {},
});

describe("a redact value that isn't a function fails closed", () => {
  it("drops every record on each path until a later call sets a function", async () => {
    const memory = createMemoryTransport();
    const notAHook = { default: (record: LogRecord) => record } as never;
    configure({ ...quiet, consoleOutput: "DEBUG", transport: memory.transport, redact: notAHook });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    getLogger("pay").info("card 4111");
    await flush();

    // The console, the transport and a record from a child frame see nothing.
    expect(spy).not.toHaveBeenCalled();
    expect(memory.records()).toEqual([]);
    expect(rt().builder.redactForwarded(built("child 4111"))).toBeNull();
    expect(getDiagnosticCounters()["record.dropped_by_redact"]).toBeGreaterThan(0);

    const redact = vi.fn((record: LogRecord) => ({ ...record, body: "[redacted]" }));
    configure({ redact });
    getLogger("pay").info("card 4111");
    await flush();

    expect(memory.records().map((record) => record.body)).toEqual(["[redacted]"]);
    spy.mockRestore();
  });

  it("sends records again after a later call sets redact to null", async () => {
    const memory = createMemoryTransport();
    configure({ ...quiet, transport: memory.transport, redact: "redact" as never });

    configure({ redact: null });
    getLogger("pay").info("plain");
    await flush();

    expect(memory.records().map((record) => record.body)).toEqual(["plain"]);
  });

  it("reports why each record drops", () => {
    const { events, diagnostics } = collect();

    resolveConfig({ ...valid(), redact: "redact" as never }, diagnostics);

    expect(messages(events)).toEqual([
      "redact must be a function or null. The value is a string. The library drops each record until redact is a function or null.",
    ]);
  });

  it("drops every record when the first processors list has an entry that isn't a function", async () => {
    const memory = createMemoryTransport();
    const mask = (record: LogRecord): LogRecord => ({ ...record, body: "[masked]" });
    configure({ ...quiet, transport: memory.transport, processors: [mask, false] as never });

    getLogger("pay").info("card 4111");
    await flush();
    expect(memory.records()).toEqual([]);

    configure({ processors: [mask] });
    getLogger("pay").info("card 4111");
    await flush();
    expect(memory.records().map((record) => record.body)).toEqual(["[masked]"]);
  });

  it("refuses a processors list with one entry that isn't a function, and keeps the current list", () => {
    const { events, diagnostics } = collect();
    const processor = (record: LogRecord): LogRecord => record;
    const live = resolveConfig({ ...valid(), processors: [processor] }, diagnostics);
    const mixed = [processor, "mask"] as never;

    const next = resolveConfig({ processors: mixed }, diagnostics, live);

    expect(next.processors).toEqual([processor]);
    expect(messages(events)).toEqual([
      "processors must be a list of functions. The value is a list. The library keeps the current list.",
    ]);
  });
});

describe("a security-context rotation", () => {
  const transport = () => createMemoryTransport();

  it("accepts a combination that only warns, and ignores a key that isn't a routing setting", async () => {
    const before = transport();
    const after = transport();
    const redact = (record: LogRecord): LogRecord => ({ ...record, body: "[redacted]" });
    const reports: string[] = [];
    configure({
      ...quiet,
      transport: before.transport,
      redact,
      securityContext: { id: "A" },
      diagnostics: { throttleMs: 0 },
      onDiagnostic: (event) => {
        if (event.code === "config.invalid") reports.push(event.message);
      },
    });
    await flush();

    await rotateSecurityContext({
      id: "B",
      routing: {
        transport: after.transport,
        transportWorker: () => ({}) as Worker,
        redact: null,
        capture: { fullUrls: true },
      } as never,
    });

    expect(rt().config.securityContext.id).toBe("B");
    expect(rt().config.redact).toBe(redact);
    expect(rt().config.capture.fullUrls).toBe(false);
    expect(reports).toEqual([
      "rotateSecurityContext() ignores routing.redact. A rotation changes only the routing settings.",
      "rotateSecurityContext() ignores routing.capture. A rotation changes only the routing settings.",
      "transportWorker has no effect with transport. The value stays.",
    ]);
    getLogger("pay").info("card 4111");
    await flush();
    expect(after.records().map((record) => record.body)).toEqual(["[redacted]"]);
  });

  it("removes the old token when the update passes headers: undefined", async () => {
    configure({
      ...quiet,
      endpoint: ENDPOINT,
      headers: { authorization: "Bearer A" },
      securityContext: { id: "A" },
    });
    await flush();

    await rotateSecurityContext({ id: "B", routing: { endpoint: ENDPOINT, headers: undefined } });

    expect(rt().config.headers).toBeUndefined();
  });

  it("fails closed after a rejection, until a later rotation succeeds", async () => {
    const before = transport();
    const after = transport();
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    configure({ ...quiet, transport: before.transport, onDrop, securityContext: { id: "A" } });
    await flush();

    const rejected = rotateSecurityContext({
      id: "B",
      routing: { transport: before.transport, credentials: "all" as never },
    });
    // A record that arrives during the rotation belongs to the context the app leaves.
    rt().emit(built("during"));
    await expect(rejected).rejects.toThrow("Invalid routing settings");

    getLogger("pay").info("after the rejection");
    await flush();

    // Nothing goes out with the old context's transport, and onDrop names each loss.
    expect(before.records()).toEqual([]);
    // The record from the rotation and the record after it are lost in two separate tasks.
    expect(onDrop.mock.calls.map(([summary]) => [summary.reason, summary.records])).toEqual([
      ["security_context", 1],
      ["security_context", 1],
    ]);
    expect(await getHealth()).toMatchObject({
      status: "degraded",
      issues: ["security.rotation_failed"],
    });

    await rotateSecurityContext({ id: "C", routing: { transport: after.transport } });
    getLogger("pay").info("new context");
    await flush();

    expect(after.records().map((record) => record.body)).toEqual(["new context"]);
    expect((await getHealth()).issues).toEqual([]);
  });
});

describe("console styles with the console off", () => {
  it("keeps the console off when the next call sets only the styles", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig({ ...valid(), consoleOutput: false }, diagnostics);

    const next = resolveConfig(
      { consoleOutput: { styles: { INFO: "color:#0a7" } } },
      diagnostics,
      live,
    );

    expect(next.consoleOutput.level).toBeNull();
    expect(next.consoleOutput.styles.INFO).toBe("color:#0a7");
    expect(messages(events)).toEqual([]);
  });
});

describe("metrics.maxHistogramBoundaries", () => {
  it("applies only to the boundaries the app gives", async () => {
    const memory = createMemoryTransport();
    const reports: string[] = [];
    configure({
      ...quiet,
      transport: memory.transport,
      metrics: { maxHistogramBoundaries: 0 },
      diagnostics: { throttleMs: 0 },
      onDiagnostic: (event) => {
        if (event.code === "config.invalid") reports.push(event.message);
      },
    });
    reports.length = 0;

    histogram("plain").record(12);
    histogram("custom", { boundaries: [10, 20] }).record(12);
    await flush();

    const bounds = (name: string): unknown =>
      memory.records().find((record) => record.attributes["metric.name"] === name)?.attributes[
        "metric.bounds"
      ];
    expect(bounds("plain")).toHaveLength(15);
    expect(bounds("custom")).toHaveLength(15);
    expect(reports).toEqual([
      "The boundaries of the metric custom must meet metrics.maxHistogramBoundaries and contain finite numbers in ascending order. The library uses the default boundaries.",
    ]);
  });
});

describe("a section that can't change after startup", () => {
  it("doesn't report an undefined key as a change, and never writes to the app's object", async () => {
    configure({ ...quiet, endpoint: null });
    await flush();
    const before = getDiagnosticCounters()["config.invalid"] ?? 0;
    const input = { correlation: { sessionIdleMs: undefined } };
    const changed = { correlation: { sessionIdleMs: 5000 } };

    configure(input);
    expect(getDiagnosticCounters()["config.invalid"] ?? 0).toBe(before);

    configure(changed);
    expect(getDiagnosticCounters()["config.invalid"]).toBe(before + 1);
    expect(changed).toEqual({ correlation: { sessionIdleMs: 5000 } });
  });
});

describe("configure() with input it can't read", () => {
  it("doesn't throw on a getter that throws, reports it and keeps the current settings", () => {
    configure({ ...quiet, endpoint: null, minLevel: "WARN" });
    const hostile = Object.defineProperty({}, "minLevel", {
      enumerable: true,
      get(): never {
        throw new Error("getter failed");
      },
    });

    expect(() => {
      configure(hostile);
    }).not.toThrow();
    expect(rt().config.minLevel).toBe("WARN");
    expect(getDiagnosticCounters()["config.invalid"]).toBe(1);
  });

  it("refuses each record and installs no capture after a failed first call, until a call works", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const memory = createMemoryTransport();

    expect(() => {
      configure(null as never);
    }).not.toThrow();
    getLogger("pay").error("card 4111");
    await flush();

    expect(warn.mock.calls[0][0]).toBe(
      "[ui-observability] configure() could not read its options. The library drops each record and installs no capture until a configure() call sets redact to a function or null.",
    );
    expect(rt()["captures"]).toEqual([]);
    expect(getDiagnosticCounters()["record.dropped_by_redact"]).toBeGreaterThan(0);
    // The runtime stays unconfigured until a call works, and it starts nothing.
    expect(await getHealth()).toMatchObject({
      status: "unconfigured",
      issues: ["records.refused"],
    });

    // A call that works but leaves redact out can't tell the library which redact the app
    // meant, so the refusal stays.
    configure({ ...quiet, transport: memory.transport, capture: { errors: true } });
    getLogger("pay").info("still refused");
    await flush();

    expect(memory.records()).toEqual([]);
    expect((await getHealth()).issues).toEqual(["records.refused"]);

    // Only a call that sets redact itself, here to null, ends the refusal.
    configure({ redact: null });
    getLogger("pay").info("plain");
    await flush();

    expect(memory.records().map((record) => record.body)).toEqual(["plain"]);
    // The capture modules load in their own chunk, so the install finishes a little later.
    await vi.waitFor(() => {
      expect(rt()["captures"]).not.toEqual([]);
    });
    expect((await getHealth()).issues).toEqual([]);
    warn.mockRestore();
  });

  it("keeps a redact hook that the first working call after a failed one sets", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const memory = createMemoryTransport();
    configure(null as never);

    const redact = (record: LogRecord): LogRecord => ({ ...record, body: "[redacted]" });
    configure({ ...quiet, transport: memory.transport, redact });
    getLogger("pay").info("card 4111");
    await flush();

    expect(memory.records().map((record) => record.body)).toEqual(["[redacted]"]);
    vi.restoreAllMocks();
  });
});

describe("the refused state in health and in a debug bundle", () => {
  it("shows a stand-in as refused, never by its function name", async () => {
    const processor = (record: LogRecord): LogRecord => record;
    configure({ ...quiet, endpoint: null, redact: "x" as never, processors: [processor] });

    const first = (await collectDebugBundle()).config;
    expect(first.redact).toBe("refused");
    expect(first.processors).toEqual(["[Function processor]"]);
    expect((await getHealth()).issues).toEqual(["records.refused"]);
  });

  it("shows a processors stand-in as refused", async () => {
    configure({ ...quiet, endpoint: null, processors: [false] as never });

    expect((await collectDebugBundle()).config.processors).toEqual(["refused"]);
    expect((await getHealth()).issues).toEqual(["records.refused"]);
  });
});

describe("a choice key with a wrong value", () => {
  it("lists the allowed values and never prints the value", () => {
    const { events, diagnostics } = collect();

    resolveConfig({ ...valid(), credentials: "Bearer tok" as never }, diagnostics);

    expect(messages(events)).toEqual([
      'credentials must be "omit", "same-origin" or "include". The library keeps "omit".',
    ]);
  });
});

describe("the same destination again", () => {
  it("keeps a signal endpoint that the next call repeats, with no report", () => {
    const { events, diagnostics } = collect();
    const metrics = "/v1/metrics";
    const live = resolveConfig({ ...valid(), metricsEndpoint: metrics }, diagnostics);
    events.length = 0;

    const next = resolveConfig({ metricsEndpoint: live.metricsEndpoint }, diagnostics, live);

    expect(next.metricsEndpoint).toBe(live.metricsEndpoint);
    expect(messages(events)).toEqual([]);
  });
});

describe("null and an empty string in a rotation", () => {
  it("accepts a value that turns a setting off, and rejects one the setting doesn't take", async () => {
    const before = createMemoryTransport();
    const after = createMemoryTransport();
    configure({
      ...quiet,
      transport: before.transport,
      transportOnExit: () => true,
      metricsEndpoint: "https://ingest.example/v1/metrics",
      securityContext: { id: "A" },
    });
    await flush();

    await rotateSecurityContext({
      id: "B",
      routing: { transport: after.transport, transportOnExit: null, metricsEndpoint: "" },
    });

    expect(rt().config.transportOnExit).toBeUndefined();
    expect(rt().config.metricsEndpoint).toBeNull();
    for (const credentials of [null, ""]) {
      await expect(
        rotateSecurityContext({
          id: "C",
          routing: { transport: after.transport, credentials: credentials as never },
        }),
      ).rejects.toThrow("Invalid routing settings");
    }
  });

  it("names a null processors value by its type, and drops each record without a current list", () => {
    const { events, diagnostics } = collect();

    resolveConfig({ ...valid(), processors: null as never }, diagnostics);

    expect(messages(events)).toEqual([
      "processors must be a list of functions. The value is null. The library drops each record until processors is a list of functions or [].",
    ]);
  });
});

describe("console.styles that isn't an object", () => {
  it("reports null and keeps the current styles", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), consoleOutput: { level: "INFO", styles: { INFO: "color:#0a7" } } },
      diagnostics,
    );

    const next = resolveConfig({ consoleOutput: { styles: null as never } }, diagnostics, live);

    expect(next.consoleOutput.styles.INFO).toBe("color:#0a7");
    expect(messages(events)).toEqual([
      "consoleOutput.styles must be an object of CSS strings. The value is null. The library keeps the styles.",
    ]);
  });
});

describe("records built during a rotation", () => {
  it("reports a record that the full hold buffer of a failed rotation drops", async () => {
    const onDrop = vi.fn<(summary: DropSummary) => void>();
    const memory = createMemoryTransport();
    configure({
      ...quiet,
      transport: memory.transport,
      onDrop,
      buffering: { maxHeldRecords: 200 },
      securityContext: { id: "A" },
    });
    await flush();

    const rejected = rotateSecurityContext({ id: "A", routing: { transport: memory.transport } });
    for (let i = 0; i <= 200; i++) {
      rt().emit(built(`during ${String(i)}`));
    }
    await expect(rejected).rejects.toThrow("different security-context id");
    await flush();

    const lost = onDrop.mock.calls.reduce((sum, [summary]) => sum + summary.records, 0);
    expect(lost).toBe(201);
  });
});

// tests/config.test.ts
import { describe, expect, it } from "vitest";
import { applyResolvedConfig, resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { CONSOLE_DEFAULT_STYLES } from "../src/constants";
import type { ConsoleStyles, ObservabilityConfig, SamplingOptions } from "../src/models/config";

const ENDPOINT = "https://ingest.example/v1/logs";
const OTHER_ENDPOINT = "https://ingest-two.example/v1/logs";

/**
 * A diagnostics instance with no throttle.
 *
 * The default window of one second hides each message after the first. One resolve can report many
 * different problems. The diagnostics tests cover the throttle. Here, the throttle hides the
 * subject of the test.
 */
function collect(): { events: DiagnosticEvent[]; diagnostics: Diagnostics } {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  return { events, diagnostics };
}

const messages = (events: DiagnosticEvent[]): string[] => events.map((event) => event.message);

/** A config that resolves cleanly, so a test can assert on silence. */
const valid = (): Partial<ObservabilityConfig> => ({
  endpoint: ENDPOINT,
  serviceName: "checkout",
});

describe("resolveConfig", () => {
  it("fills every section from the defaults when given only an endpoint", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ endpoint: ENDPOINT }, diagnostics);

    expect(resolved.endpoint).toBe(ENDPOINT);
    expect(resolved.enabled).toBe(true);
    expect(resolved.minLevel).toBe("INFO");
    expect(resolved.compression).toBe("gzip");
    expect(resolved.credentials).toBe("omit");
    expect(resolved.storage).toBe("auto");
    expect(resolved.sampling.defaultRate).toBe(1);
    expect(resolved.sampling.alwaysSampleTypes).toEqual(["action"]);
    expect(resolved.bus.mode).toBe("auto");
    expect(resolved.capture.errors).toBe(true);
    expect(resolved.capture.fullUrls).toBe(false);
    expect(resolved.console.level).toBeNull();

    // The only problem must be the absent serviceName.
    expect(messages(events)).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
  });

  it("reads the console option as off, on, or an explicit level", () => {
    const { diagnostics } = collect();

    expect(resolveConfig({ ...valid(), console: true }, diagnostics).console.level).toBe("DEBUG");
    expect(resolveConfig({ ...valid(), console: "WARN" }, diagnostics).console.level).toBe("WARN");

    // false has to turn off a level already in force, not fall through to it.
    const live = resolveConfig({ ...valid(), console: "WARN" }, diagnostics);
    expect(resolveConfig({ console: false }, diagnostics, live).console.level).toBeNull();
  });

  it("reads the object form of console and merges its styles onto the defaults", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig(
      { ...valid(), console: { styles: { INFO: "color:#0a7" } } },
      diagnostics,
    );

    // An object with no level turns the console on, as true does.
    expect(resolved.console.level).toBe("DEBUG");
    expect(resolved.console.styles.INFO).toBe("color:#0a7");
    expect(resolved.console.styles.WARN).toBe(CONSOLE_DEFAULT_STYLES.WARN);
    expect(events).toEqual([]);
  });

  it("keeps the level and the styles in force on a later partial console change", () => {
    const { diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), console: { level: "WARN", styles: { WARN: "color:orange" } } },
      diagnostics,
    );

    const restyled = resolveConfig(
      { console: { styles: { ERROR: "color:red" } } },
      diagnostics,
      live,
    );
    const relevelled = resolveConfig({ console: "INFO" }, diagnostics, restyled);

    expect(restyled.console.level).toBe("WARN");
    expect(relevelled.console.level).toBe("INFO");
    expect(relevelled.console.styles.WARN).toBe("color:orange");
    expect(relevelled.console.styles.ERROR).toBe("color:red");
  });

  it("reads a console object that sets the level only, and keeps the default styles", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ ...valid(), console: { level: "WARN" } }, diagnostics);

    expect(resolved.console.level).toBe("WARN");
    expect(resolved.console.styles).toEqual(CONSOLE_DEFAULT_STYLES);
    expect(events).toEqual([]);
  });

  it("does not report a missing endpoint when a custom transport sends", () => {
    const { events, diagnostics } = collect();

    resolveConfig(
      { serviceName: "checkout", transport: () => Promise.resolve({ status: 200 }) },
      diagnostics,
    );

    expect(events).toEqual([]);
  });

  it("accepts transport and transportOnExit as known keys", () => {
    const { events, diagnostics } = collect();

    resolveConfig(
      {
        ...valid(),
        transport: () => Promise.resolve({ status: 200 }),
        transportOnExit: () => true,
      },
      diagnostics,
    );

    expect(events).toEqual([]);
  });

  it("reports a transport or transportOnExit that is not a function, and ignores it", () => {
    const { events, diagnostics } = collect();
    const notAFunction = "https://x" as unknown as ObservabilityConfig["transport"];
    const notAHook = true as unknown as ObservabilityConfig["transportOnExit"];

    const resolved = resolveConfig(
      { ...valid(), transport: notAFunction, transportOnExit: notAHook },
      diagnostics,
    );

    expect(resolved.transport).toBeUndefined();
    expect(resolved.transportOnExit).toBeUndefined();
    expect(messages(events)).toEqual([
      expect.stringContaining("transport must be a function"),
      expect.stringContaining("transportOnExit must be a function"),
    ]);
  });

  it("reports an onDrop that is not a function, and keeps the hook in force", () => {
    const { events, diagnostics } = collect();
    const onDrop = (): void => undefined;
    const first = resolveConfig({ ...valid(), onDrop }, diagnostics);
    const notAHook = "log it" as unknown as ObservabilityConfig["onDrop"];

    const next = resolveConfig({ onDrop: notAHook }, diagnostics, first);

    expect(next.onDrop).toBe(onDrop);
    expect(messages(events)).toEqual(["onDrop must be a function. The library ignores the value."]);
  });

  it("keeps the transport and the exit hook in force when a new value is not a function", () => {
    const { events, diagnostics } = collect();
    const transport = () => Promise.resolve({ status: 200 });
    const transportOnExit = () => true;
    const live = resolveConfig({ ...valid(), transport, transportOnExit }, diagnostics);
    const nothing = null as unknown as ObservabilityConfig["transport"];
    const notAHook = false as unknown as ObservabilityConfig["transportOnExit"];

    const resolved = resolveConfig(
      { transport: nothing, transportOnExit: notAHook },
      diagnostics,
      live,
    );

    expect(resolved.transport).toBe(transport);
    expect(resolved.transportOnExit).toBe(transportOnExit);
    expect(messages(events)).toHaveLength(2);
  });

  it("reports a null console value and keeps the console settings in force", () => {
    const { events, diagnostics } = collect();
    const live = resolveConfig({ ...valid(), console: "WARN" }, diagnostics);
    const nothing = null as unknown as ObservabilityConfig["console"];

    const number = 42 as unknown as ObservabilityConfig["console"];

    const resolved = resolveConfig({ console: nothing }, diagnostics, live);
    const fromNumber = resolveConfig({ console: number }, diagnostics, live);

    expect(resolved.console).toBe(live.console);
    expect(fromNumber.console).toBe(live.console);
    expect(messages(events)).toHaveLength(2);
    expect(messages(events)[0]).toContain("console must be a boolean, a level or an object");
  });

  it("accepts a style that sets both the text color and the background", () => {
    const { diagnostics } = collect();
    const badge = "color:#fff;background:#1e6fd9;padding:0 4px;border-radius:3px";

    const resolved = resolveConfig(
      { ...valid(), console: { styles: { INFO: badge } } },
      diagnostics,
    );

    expect(resolved.console.styles.INFO).toBe(badge);
  });

  it("reports an unknown console style key and a style that is not a string", () => {
    const { events, diagnostics } = collect();
    const styles = { NOTICE: "color:blue", INFO: 42 } as unknown as ConsoleStyles;

    const resolved = resolveConfig({ ...valid(), console: { styles } }, diagnostics);

    expect(messages(events)).toEqual([
      expect.stringContaining('console.styles key "NOTICE"'),
      expect.stringContaining("console.styles.INFO must be a string"),
    ]);
    expect(resolved.console.styles.INFO).toBe(CONSOLE_DEFAULT_STYLES.INFO);
  });

  it("reports a missing endpoint and still returns a usable config", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({}, diagnostics);

    expect(resolved.endpoint).toBe("");
    expect(resolved.enabled).toBe(true);
    expect(events.map((event) => event.code)).toEqual(["config.invalid", "config.invalid"]);
    expect(messages(events)[0]).toContain("endpoint is missing");
    // With no endpoint there is nothing to protect the network capture from.
    expect(resolved.capture.ignoreUrls).toEqual([]);
  });

  it("accepts endpoint: null as console-only mode, with no diagnostic", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ endpoint: null, serviceName: "checkout" }, diagnostics);

    // Console-only mode is valid. There is no diagnostic and no URL to ignore.
    expect(events).toEqual([]);
    expect(resolved.endpoint).toBeNull();
    expect(resolved.capture.ignoreUrls).toEqual([]);
  });

  it("defaults identity to storage, and accepts memory as a known key", () => {
    const { events, diagnostics } = collect();

    expect(resolveConfig(valid(), diagnostics).identity).toBe("storage");
    expect(resolveConfig({ ...valid(), identity: "memory" }, diagnostics).identity).toBe("memory");
    expect(events).toEqual([]);
  });

  it("keeps the endpoint in force when a reconfigure passes endpoint: undefined", () => {
    const { diagnostics } = collect();
    const first = resolveConfig(valid(), diagnostics);

    // An unset environment variable gives undefined. The live endpoint must not change.
    const second = resolveConfig({ endpoint: undefined }, diagnostics, first);

    expect(second.endpoint).toBe(ENDPOINT);
  });

  it("reports an endpoint that is not an absolute URL, and passes the parse error as the cause", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ endpoint: "/v1/logs", serviceName: "checkout" }, diagnostics);

    expect(messages(events)[0]).toContain("not a valid absolute URL");
    expect(events[0].cause).toBeInstanceOf(Error);
    // It is still returned, because configuration never throws into the caller.
    expect(resolved.endpoint).toBe("/v1/logs");
  });

  it("substitutes unknown-service for a missing serviceName and says so", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ endpoint: ENDPOINT }, diagnostics);

    expect(resolved.serviceName).toBe("unknown-service");
    expect(messages(events)[0]).toContain("serviceName is missing");
  });

  it("keeps a provided serviceName and reports nothing at all", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig(valid(), diagnostics);

    expect(resolved.serviceName).toBe("checkout");
    expect(events).toEqual([]);
  });

  it("keeps a consumer's credentials, so sending cookies stays opt-in", () => {
    const { events, diagnostics } = collect();

    const resolved = resolveConfig({ ...valid(), credentials: "include" }, diagnostics);

    expect(resolved.credentials).toBe("include");
    expect(events).toEqual([]);
  });

  describe("sampling.remoteMaxRate", () => {
    it("defaults to 1 with remote sampling off", () => {
      const resolved = resolveConfig(valid(), collect().diagnostics);

      expect(resolved.sampling.remote).toBe(false);
      expect(resolved.sampling.remoteMaxRate).toBe(1);
    });

    it.each([["high"], [-0.1], [1.5], [Number.NaN]])("falls back to 1 for %s", (value) => {
      const { events, diagnostics } = collect();
      const input: Partial<ObservabilityConfig> = { ...valid() };
      input.sampling = { remoteMaxRate: value } as unknown as Partial<SamplingOptions>;

      const resolved = resolveConfig(input, diagnostics);

      expect(resolved.sampling.remoteMaxRate).toBe(1);
      expect(messages(events)[0]).toContain("sampling.remoteMaxRate must be 0..1.");
    });
  });

  describe("sampling.defaultRate", () => {
    it("accepts a rate inside the range and reports nothing", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig({ ...valid(), sampling: { defaultRate: 0.25 } }, diagnostics);

      expect(resolved.sampling.defaultRate).toBe(0.25);
      expect(events).toEqual([]);
    });

    it("falls back to 1 when the rate is not a number at all", () => {
      const { events, diagnostics } = collect();
      const input: Partial<ObservabilityConfig> = { ...valid() };
      // A JavaScript consumer can pass any value. This guard is for that case. No other part of the
      // library sees the problem.
      input.sampling = { defaultRate: "high" } as unknown as Partial<SamplingOptions>;

      const resolved = resolveConfig(input, diagnostics);

      expect(resolved.sampling.defaultRate).toBe(1);
      expect(messages(events)[0]).toContain(
        "sampling.defaultRate must be 0..1. The value is high.",
      );
    });

    it("falls back to 1 when the rate is below zero", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig({ ...valid(), sampling: { defaultRate: -1 } }, diagnostics);

      expect(resolved.sampling.defaultRate).toBe(1);
      expect(messages(events)[0]).toContain("The value is -1.");
    });

    it("falls back to 1 when the rate is above one", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig({ ...valid(), sampling: { defaultRate: 2 } }, diagnostics);

      expect(resolved.sampling.defaultRate).toBe(1);
      expect(messages(events)[0]).toContain("The value is 2.");
    });
  });

  describe("sampling.rates", () => {
    it("accepts per-namespace rates inside the range and reports nothing", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig(
        { ...valid(), sampling: { rates: { "app.blotter": 0.5 } } },
        diagnostics,
      );

      expect(resolved.sampling.rates).toEqual({ "app.blotter": 0.5 });
      expect(events).toEqual([]);
    });

    it("clamps an out-of-range namespace rate to 1 and names the namespace", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig(
        { ...valid(), sampling: { rates: { "app.blotter": 5 } } },
        diagnostics,
      );

      expect(resolved.sampling.rates["app.blotter"]).toBe(1);
      expect(messages(events)[0]).toContain(
        'sampling.rates["app.blotter"] must be 0..1. The value is 5.',
      );
    });

    it("clamps a namespace rate that is not a number", () => {
      const { events, diagnostics } = collect();
      const input: Partial<ObservabilityConfig> = { ...valid() };
      input.sampling = {
        rates: { "app.ticket": null },
      } as unknown as Partial<SamplingOptions>;

      const resolved = resolveConfig(input, diagnostics);

      expect(resolved.sampling.rates["app.ticket"]).toBe(1);
      expect(messages(events)[0]).toContain("The value is null.");
    });

    it("does not mutate the caller's rates object while clamping", () => {
      const { diagnostics } = collect();
      const rates = { "app.blotter": 5 };

      const resolved = resolveConfig({ ...valid(), sampling: { rates } }, diagnostics);

      expect(rates["app.blotter"]).toBe(5);
      expect(resolved.sampling.rates["app.blotter"]).toBe(1);
    });
  });

  describe("minLevels", () => {
    it("is empty by default, and keeps each valid prefix", () => {
      const { events, diagnostics } = collect();

      expect(resolveConfig(valid(), diagnostics).minLevels).toEqual({});
      expect(
        resolveConfig({ ...valid(), minLevels: { trading: "DEBUG", pricing: "WARN" } }, diagnostics)
          .minLevels,
      ).toEqual({ trading: "DEBUG", pricing: "WARN" });
      expect(events).toEqual([]);
    });

    it("reports and drops an entry with a bad level or an empty prefix", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig(
        { ...valid(), minLevels: { trading: "LOUD", "": "DEBUG", pricing: "WARN" } as never },
        diagnostics,
      );

      expect(resolved.minLevels).toEqual({ pricing: "WARN" });
      expect(messages(events)).toEqual([
        expect.stringContaining('minLevels["trading"] must be a level name'),
        expect.stringContaining('minLevels[""] must be a level name'),
      ]);
    });

    it("keeps the map in force for a value that is not an object", () => {
      const { events, diagnostics } = collect();
      const first = resolveConfig({ ...valid(), minLevels: { trading: "DEBUG" } }, diagnostics);

      const second = resolveConfig({ minLevels: "DEBUG" as never }, diagnostics, first);

      expect(second.minLevels).toEqual({ trading: "DEBUG" });
      expect(messages(events)[0]).toContain("minLevels must be an object of level names");
    });

    it("replaces the map in force with a new map", () => {
      const { diagnostics } = collect();
      const first = resolveConfig({ ...valid(), minLevels: { trading: "DEBUG" } }, diagnostics);

      const second = resolveConfig({ minLevels: { pricing: "WARN" } }, diagnostics, first);

      expect(second.minLevels).toEqual({ pricing: "WARN" });
    });
  });

  describe("contextProvider", () => {
    it("keeps a function and reports nothing", () => {
      const { events, diagnostics } = collect();
      const provider = () => ({ route: "/" });

      expect(
        resolveConfig({ ...valid(), contextProvider: provider }, diagnostics).contextProvider,
      ).toBe(provider);
      expect(events).toEqual([]);
    });

    it("reports a value that is not a function, and keeps the provider in force", () => {
      const { events, diagnostics } = collect();
      const provider = () => ({ route: "/" });
      const first = resolveConfig({ ...valid(), contextProvider: provider }, diagnostics);

      const second = resolveConfig({ contextProvider: "route" as never }, diagnostics, first);

      expect(second.contextProvider).toBe(provider);
      expect(messages(events)).toEqual([
        "contextProvider must be a function. The library ignores the value.",
      ]);
    });
  });

  describe("metricsEndpoint", () => {
    const METRICS = "https://ingest.example/v1/metrics";

    it("is off by default", () => {
      expect(resolveConfig(valid(), collect().diagnostics).metricsEndpoint).toBe("");
    });

    it("keeps an absolute URL and reports nothing", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig({ ...valid(), metricsEndpoint: METRICS }, diagnostics);

      expect(resolved.metricsEndpoint).toBe(METRICS);
      expect(events).toEqual([]);
    });

    it("reports a value that is not an absolute URL and keeps the value in force", () => {
      const { events, diagnostics } = collect();
      const first = resolveConfig({ ...valid(), metricsEndpoint: METRICS }, diagnostics);

      const second = resolveConfig({ metricsEndpoint: "/v1/metrics" }, diagnostics, first);

      expect(second.metricsEndpoint).toBe(METRICS);
      expect(messages(events)[0]).toContain("metricsEndpoint is not a valid absolute URL");
      expect(events[0].cause).toBeInstanceOf(Error);
    });

    it("reports a value that is not a string and keeps the value in force", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig(
        { ...valid(), metricsEndpoint: 42 as unknown as string },
        diagnostics,
      );

      expect(resolved.metricsEndpoint).toBe("");
      expect(messages(events)[0]).toContain("metricsEndpoint must be a URL string");
    });

    it("turns off with an empty string", () => {
      const { diagnostics } = collect();
      const first = resolveConfig({ ...valid(), metricsEndpoint: METRICS }, diagnostics);

      expect(resolveConfig({ metricsEndpoint: "" }, diagnostics, first).metricsEndpoint).toBe("");
    });

    it("turns off with a serializer that has no metrics format, and says so", () => {
      const { events, diagnostics } = collect();
      const first = resolveConfig({ ...valid(), metricsEndpoint: METRICS }, diagnostics);

      const second = resolveConfig({ serializer: "ecs" }, diagnostics, first);

      expect(second.metricsEndpoint).toBe("");
      expect(messages(events)[0]).toContain('metricsEndpoint needs serializer "otlp"');
    });

    it("joins ignoreUrls and leaves it on a change", () => {
      const { diagnostics } = collect();
      const first = resolveConfig({ ...valid(), metricsEndpoint: METRICS }, diagnostics);
      expect(first.capture.ignoreUrls).toEqual([ENDPOINT, METRICS]);

      const second = resolveConfig({ metricsEndpoint: "" }, diagnostics, first);

      // A request of the library must not give a record. That record gives a new request.
      expect(second.capture.ignoreUrls).toEqual([ENDPOINT]);
    });

    it("reports a metricsEndpoint with no endpoint and no transport", () => {
      // Only the delivery stack sends. It does not load without endpoint or transport.
      const { events, diagnostics } = collect();

      resolveConfig({ ...valid(), endpoint: null, metricsEndpoint: METRICS }, diagnostics);

      expect(messages(events)).toEqual([
        "metricsEndpoint needs endpoint or transport. The library sends nothing to metricsEndpoint.",
      ]);
    });

    it("accepts a metricsEndpoint with a custom transport and no endpoint", () => {
      const { events, diagnostics } = collect();
      const transport = () => Promise.resolve({ status: 204 });

      resolveConfig(
        { ...valid(), endpoint: null, transport, metricsEndpoint: METRICS },
        diagnostics,
      );

      expect(events).toEqual([]);
    });
  });

  it("records the HTTP client histogram by default", () => {
    const resolved = resolveConfig(valid(), collect().diagnostics);

    expect(resolved.capture.httpMetrics).toBe(true);
  });

  describe("the endpoint is kept out of network capture", () => {
    it("adds the endpoint to ignoreUrls so one failed POST cannot log forever", () => {
      const { diagnostics } = collect();

      const resolved = resolveConfig(valid(), diagnostics);

      expect(resolved.capture.ignoreUrls).toEqual([ENDPOINT]);
    });

    it("keeps the consumer's own entries alongside it", () => {
      const { diagnostics } = collect();

      const resolved = resolveConfig(
        { ...valid(), capture: { ignoreUrls: ["/health"] } },
        diagnostics,
      );

      expect(resolved.capture.ignoreUrls).toEqual(["/health", ENDPOINT]);
    });

    it("does not add the endpoint twice when it is already listed", () => {
      const { diagnostics } = collect();

      const resolved = resolveConfig(
        { ...valid(), capture: { ignoreUrls: [ENDPOINT] } },
        diagnostics,
      );

      expect(resolved.capture.ignoreUrls).toEqual([ENDPOINT]);
    });

    it("swaps the old endpoint for the new one on a reconfigure, keeping other entries", () => {
      const { diagnostics } = collect();
      const first = resolveConfig(
        { ...valid(), capture: { ignoreUrls: ["/health"] } },
        diagnostics,
      );
      expect(first.capture.ignoreUrls).toEqual(["/health", ENDPOINT]);

      const second = resolveConfig({ endpoint: OTHER_ENDPOINT }, diagnostics, first);

      // The old entry is gone. The test now covers the live endpoint.
      expect(second.capture.ignoreUrls).toEqual(["/health", OTHER_ENDPOINT]);
    });
  });

  it("merges a reconfigure onto the config already in force, not onto the defaults", () => {
    const { diagnostics } = collect();
    const first = resolveConfig(
      { ...valid(), minLevel: "TRACE", capture: { fetch: true } },
      diagnostics,
    );

    const second = resolveConfig({ enabled: false }, diagnostics, first);

    // A call with one key must not discard all other settings.
    expect(second.enabled).toBe(false);
    expect(second.endpoint).toBe(ENDPOINT);
    expect(second.serviceName).toBe("checkout");
    expect(second.minLevel).toBe("TRACE");
    expect(second.capture.fetch).toBe(true);
  });

  describe("unknown keys", () => {
    it("reports an unknown key by name rather than ignoring it silently", () => {
      const { events, diagnostics } = collect();
      // This test finds this failure. Each type is correct, because the argument is a Partial. The
      // library sends nothing.
      const input: Partial<ObservabilityConfig> & Record<string, unknown> = {
        ...valid(),
        remoteUrl: "https://typo.example",
      };

      resolveConfig(input, diagnostics);

      expect(messages(events)[0]).toContain('unknown config key "remoteUrl"');
    });

    it("treats redact, onDiagnostic and headers as known despite being absent from the defaults", () => {
      const { events, diagnostics } = collect();

      resolveConfig(
        {
          ...valid(),
          redact: (record) => record,
          onDiagnostic: () => undefined,
          headers: { "x-tenant": "acme" },
        },
        diagnostics,
      );

      expect(events).toEqual([]);
    });

    it("reports a typo inside a section, which the top-level guard cannot see", () => {
      const { events, diagnostics } = collect();
      // capture.webVitals is the real key. The typo type-checks and does nothing.
      const input = { ...valid(), capture: { webVital: true } } as Partial<ObservabilityConfig>;

      resolveConfig(input, diagnostics);

      expect(messages(events)[0]).toContain('unknown config key "capture.webVital"');
    });

    it("treats capture.webVitalsLoader as known despite being absent from the defaults", () => {
      const { events, diagnostics } = collect();
      const input = {
        ...valid(),
        capture: { webVitalsLoader: () => Promise.resolve({}) },
      } as unknown as Partial<ObservabilityConfig>;

      resolveConfig(input, diagnostics);

      expect(events).toEqual([]);
    });

    it("leaves the free-form namespace map under sampling.rates alone", () => {
      const { events, diagnostics } = collect();
      const sampling: Partial<SamplingOptions> = { rates: { "checkout.cart": 0.5 } };

      resolveConfig({ ...valid(), sampling }, diagnostics);

      expect(events).toEqual([]);
    });

    it("ignores a section that is absent or not an object", () => {
      const { events, diagnostics } = collect();
      const input = { ...valid(), bus: undefined, capture: null } as unknown;

      resolveConfig(input as Partial<ObservabilityConfig>, diagnostics);

      expect(events).toEqual([]);
    });
  });

  describe("serializer", () => {
    it("defaults to OTLP, which is what a collector expects", () => {
      const { diagnostics } = collect();

      expect(resolveConfig(valid(), diagnostics).serializer).toBe("otlp");
    });

    it("keeps a known name, so config.ts imports no serializer", () => {
      const { events, diagnostics } = collect();
      const ecs = resolveConfig({ ...valid(), serializer: "ecs" }, diagnostics);
      const otlp = resolveConfig({ ...valid(), serializer: "otlp" }, diagnostics);

      expect(ecs.serializer).toBe("ecs");
      expect(otlp.serializer).toBe("otlp");
      expect(events).toEqual([]);
    });

    it("takes an implementation of the consumer's own", () => {
      const { diagnostics } = collect();
      const mine = { name: "mine", serialize: () => ({ body: "", contentType: "text/plain" }) };

      expect(resolveConfig({ ...valid(), serializer: mine }, diagnostics).serializer).toBe(mine);
    });

    it("keeps the serializer already in force across a reconfigure", () => {
      const { diagnostics } = collect();
      const live = resolveConfig({ ...valid(), serializer: "ecs" }, diagnostics);

      expect(resolveConfig({ minLevel: "ERROR" }, diagnostics, live).serializer).toBe("ecs");
    });

    it("reports a name it does not know and falls back, rather than sending nothing", () => {
      const { events, diagnostics } = collect();
      const named = "xml" as unknown as ObservabilityConfig["serializer"];

      expect(resolveConfig({ ...valid(), serializer: named }, diagnostics).serializer).toBe("otlp");
      expect(messages(events)[0]).toContain("serializer must be");
    });

    it("rejects a null and an object that cannot serialize", () => {
      const { events, diagnostics } = collect();
      const nothing = null as unknown as ObservabilityConfig["serializer"];
      const halfBuilt = { name: "half-built" } as unknown as ObservabilityConfig["serializer"];

      const fromNull = resolveConfig({ ...valid(), serializer: nothing }, diagnostics);
      const fromHalfBuilt = resolveConfig({ ...valid(), serializer: halfBuilt }, diagnostics);

      expect(fromNull.serializer).toBe("otlp");
      expect(fromHalfBuilt.serializer).toBe("otlp");
      expect(events).toHaveLength(2);
    });
  });

  describe("value checks", () => {
    /**
     * Resolves a config with values that the type does not accept.
     * @param input Values to put over the valid config.
     * @returns The resolved config and the diagnostic messages.
     */
    function resolveLoose(input: Record<string, unknown>) {
      const { events, diagnostics } = collect();
      const config = resolveConfig({ ...valid(), ...input }, diagnostics);
      return { config, texts: messages(events) };
    }

    it("reads a level name in any case", () => {
      const { config, texts } = resolveLoose({ minLevel: "warn", console: "debug" });

      expect(config.minLevel).toBe("WARN");
      expect(config.console.level).toBe("DEBUG");
      expect(texts).toEqual([]);
    });

    it("reports an unknown minLevel and keeps the level in force", () => {
      const { config, texts } = resolveLoose({ minLevel: "verbose" });

      expect(config.minLevel).toBe("INFO");
      expect(texts).toEqual([
        'minLevel must be a level name: "TRACE", "DEBUG", "INFO", "WARN", "ERROR" or "FATAL". The value is "verbose". The library keeps "INFO".',
      ]);
    });

    it("keeps the minLevel of the config in force on a later bad value", () => {
      const { diagnostics } = collect();
      const first = resolveConfig({ ...valid(), minLevel: "WARN" }, diagnostics);

      const next = resolveConfig(
        { minLevel: "loud" } as unknown as Partial<ObservabilityConfig>,
        diagnostics,
        first,
      );

      expect(next.minLevel).toBe("WARN");
    });

    it("reports an unknown console level and keeps the console settings in force", () => {
      const asString = resolveLoose({ console: "loud" });
      const asObject = resolveLoose({ console: { level: 3 } });

      expect(asString.config.console.level).toBeNull();
      expect(asObject.config.console.level).toBeNull();
      expect(asString.texts[0]).toContain("console must be a level name");
      expect(asObject.texts[0]).toContain("console.level must be a level name");
    });

    it("reports each top-level value outside its choices and keeps the default", () => {
      const { config, texts } = resolveLoose({
        enabled: "yes",
        compression: "brotli",
        credentials: "all",
        storage: "session",
        identity: "cookie",
        headers: 42,
      });

      expect(config).toMatchObject({
        enabled: true,
        compression: "gzip",
        credentials: "omit",
        storage: "auto",
        identity: "storage",
      });
      expect(config.headers).toBeUndefined();
      expect(texts).toEqual([
        'enabled must be true or false. The value is "yes". The library keeps true.',
        'compression must be "gzip" or "none". The value is "brotli". The library keeps "gzip".',
        'credentials must be "omit", "same-origin" or "include". The value is "all". The library keeps "omit".',
        "headers must be an object of strings or a function. The value is 42. The library keeps the headers in force.",
        'storage must be "auto", "indexeddb", "localstorage", "memory" or "none". The value is "session". The library keeps "auto".',
        'identity must be "storage" or "memory". The value is "cookie". The library keeps "storage".',
      ]);
    });

    it("clears the headers on an explicit undefined, and keeps them on a missing key", () => {
      // On logout, the old Authorization header must not go on the next send.
      const { diagnostics } = collect();
      const first = resolveConfig(
        { ...valid(), headers: { authorization: "Bearer t" } },
        diagnostics,
      );

      expect(resolveConfig({}, diagnostics, first).headers).toEqual({ authorization: "Bearer t" });
      expect(resolveConfig({ headers: undefined }, diagnostics, first).headers).toBeUndefined();
    });

    it("reads each propagateTraceHeaderTo string as its origin, and keeps each RegExp", () => {
      const pattern = /\/api\//;
      const { config, texts } = resolveLoose({
        capture: { propagateTraceHeaderTo: ["https://api.example/v1/", pattern, "/api/", 5] },
      });

      expect(config.capture.propagateTraceHeaderTo).toEqual(["https://api.example", pattern]);
      expect(texts).toEqual([
        'The library ignores the capture.propagateTraceHeaderTo entry "/api/". capture.propagateTraceHeaderTo must be a list of origin URLs such as "https://api.example" and RegExp patterns.',
        'The library ignores the capture.propagateTraceHeaderTo entry 5. capture.propagateTraceHeaderTo must be a list of origin URLs such as "https://api.example" and RegExp patterns.',
      ]);
    });

    it("accepts headers as an object of strings or as a function", () => {
      const fn = () => ({ authorization: "Bearer t" });

      expect(resolveLoose({ headers: { "x-app": "a" } }).config.headers).toEqual({ "x-app": "a" });
      expect(resolveLoose({ headers: fn }).config.headers).toBe(fn);
      expect(resolveLoose({ headers: { "x-app": 1 } }).texts).toHaveLength(1);
    });

    it("reads each trusted origin as its origin, and drops an entry that is not an origin", () => {
      const { config, texts } = resolveLoose({
        bus: {
          trustedOrigins: [
            "https://parent.example/app/",
            "null",
            "not a url",
            5,
            "data:text/plain,x",
          ],
        },
      });

      // One "null" entry trusts each sandboxed and data: document, for example a frame in an ad.
      expect(config.bus.trustedOrigins).toEqual(["https://parent.example"]);
      expect(texts).toHaveLength(4);
      expect(texts[0]).toBe(
        'The library ignores the bus.trustedOrigins entry "null". bus.trustedOrigins must be a list of origin URLs such as "https://app.example". For a sandboxed frame, set bus.mode: "sender" in the frame.',
      );
    });

    it("reports a bus value outside its choices, and a list that is not a list", () => {
      const { config, texts } = resolveLoose({
        bus: { mode: "leader", openFinRole: "host", trustedOrigins: "https://a.example" },
      });

      expect(config.bus).toEqual({ mode: "auto", trustedOrigins: [], openFinRole: "auto" });
      expect(texts).toHaveLength(3);
      expect(texts[1]).toBe(
        'bus.trustedOrigins must be a list of origin URLs such as "https://app.example". For a sandboxed frame, set bus.mode: "sender" in the frame. The value is "https://a.example". The library keeps the list in force.',
      );
    });

    it("defaults journey.scope to auto, accepts each scope and reports another value", () => {
      expect(resolveLoose({}).config.journey).toEqual({ scope: "auto", maxAgeMs: 1_800_000 });
      expect(resolveLoose({ journey: { scope: "tab" } }).config.journey.scope).toBe("tab");

      const { config, texts } = resolveLoose({ journey: { scope: "window", maxAge: 1 } });

      expect(config.journey.scope).toBe("auto");
      expect(texts).toEqual([
        'journey.scope must be "auto", "context", "tab" or "origin". The value is "window". The library keeps "auto".',
        'The library ignores the unknown config key "journey.maxAge". Check the spelling.',
      ]);
    });

    it("reports each capture value of the wrong type and keeps the default", () => {
      const { config, texts } = resolveLoose({
        capture: {
          fetch: "yes",
          console: "error",
          longFrameThresholdMs: -1,
          propagateTraceHeaderTo: "https://api.internal",
        },
      });

      expect(config.capture).toMatchObject({
        fetch: false,
        console: false,
        longFrameThresholdMs: 100,
        propagateTraceHeaderTo: [],
      });
      expect(texts).toHaveLength(4);
      expect(texts).toContain(
        'capture.fetch must be true or false. The value is "yes". The library keeps false.',
      );
      expect(texts).toContain(
        "capture.longFrameThresholdMs must be a finite number of 0 or more. The value is -1. The library keeps 100.",
      );
    });

    it("keeps the valid entries of each capture list and reports the others", () => {
      const pattern = /internal/;
      const { config, texts } = resolveLoose({
        capture: { console: ["error", "debug"], ignoreUrls: [pattern, "health", 5] },
      });

      expect(config.capture.console).toEqual(["error"]);
      expect(config.capture.ignoreUrls).toEqual([pattern, "health", ENDPOINT]);
      expect(texts).toEqual([
        'The library ignores the capture.console entry "debug". capture.console must be true, false or a list of "error", "warn", "info" or "log".',
        "The library ignores the capture.ignoreUrls entry 5. capture.ignoreUrls must be a list of strings and RegExp patterns.",
      ]);
    });

    it("reports a sampling list entry and a remote flag of the wrong type", () => {
      const { config, texts } = resolveLoose({
        sampling: { alwaysSampleTypes: ["action", { type: "metric" }], remote: "true" },
      });

      expect(config.sampling.alwaysSampleTypes).toEqual(["action"]);
      expect(config.sampling.remote).toBe(false);
      expect(texts).toEqual([
        "The library ignores the sampling.alwaysSampleTypes entry an object. sampling.alwaysSampleTypes must be a list of strings.",
        'sampling.remote must be true or false. The value is "true". The library keeps false.',
      ]);
    });

    it("names a function and null in a message", () => {
      const { texts } = resolveLoose({ enabled: () => true, compression: null });

      expect(texts).toEqual([
        "enabled must be true or false. The value is a function. The library keeps true.",
        'compression must be "gzip" or "none". The value is null. The library keeps "gzip".',
      ]);
    });
  });
});

describe("tunable sections", () => {
  /**
   * Resolves a config with tunable values that the type does not accept.
   * @param input Values to put over the valid config.
   * @returns The resolved config and the diagnostic messages.
   */
  function resolveTunables(input: Record<string, unknown>) {
    const { events, diagnostics } = collect();
    const config = resolveConfig({ ...valid(), ...input }, diagnostics);
    return { config, texts: messages(events) };
  }

  it("gives the default batching, retention, limits and journey age", () => {
    const { config, texts } = resolveTunables({});

    expect(config.batching).toEqual({
      logFlushIntervalMs: 2000,
      logBatchSize: 100,
      metricFlushIntervalMs: 10_000,
      metricBatchSize: 500,
    });
    expect(config.retention).toEqual({
      mode: "limited",
      maxBatches: 500,
      maxAgeMs: 86_400_000,
      maxAttempts: 5,
    });
    expect(config.limits).toEqual({
      maxBodyChars: 4096,
      maxAttributeChars: 8192,
      maxAttributeCount: 128,
      maxStackChars: 8192,
      maxDepth: 6,
      maxArrayLength: 100,
      maxNodes: 10_000,
      maxRecordBytes: 32_768,
    });
    expect(config.journey).toEqual({ scope: "auto", maxAgeMs: 1_800_000 });
    expect(texts).toEqual([]);
  });

  it("accepts each bound of a range and merges a partial section", () => {
    const { config, texts } = resolveTunables({
      batching: { logBatchSize: 1, metricBatchSize: 1000 },
      retention: { mode: "until-delivered", maxAttempts: 20 },
      limits: { maxRecordBytes: 60_000, maxDepth: 1 },
      journey: { maxAgeMs: 60_000 },
    });

    expect(config.batching).toEqual({
      logFlushIntervalMs: 2000,
      logBatchSize: 1,
      metricFlushIntervalMs: 10_000,
      metricBatchSize: 1000,
    });
    expect(config.retention).toEqual({
      mode: "until-delivered",
      maxBatches: 500,
      maxAgeMs: 86_400_000,
      maxAttempts: 20,
    });
    expect(config.limits.maxRecordBytes).toBe(60_000);
    expect(config.limits.maxDepth).toBe(1);
    expect(config.journey).toEqual({ scope: "auto", maxAgeMs: 60_000 });
    expect(texts).toEqual([]);
  });

  it("reports a value outside its range and keeps the value in force", () => {
    const { config, texts } = resolveTunables({
      batching: { logBatchSize: 0, logFlushIntervalMs: 1.5 },
      retention: { maxAttempts: 21, mode: "forever" },
      limits: { maxRecordBytes: 60_001 },
      journey: { maxAgeMs: "60000" },
    });

    expect(config.batching.logBatchSize).toBe(100);
    expect(config.batching.logFlushIntervalMs).toBe(2000);
    expect(config.retention).toEqual({
      mode: "limited",
      maxBatches: 500,
      maxAgeMs: 86_400_000,
      maxAttempts: 5,
    });
    expect(config.limits.maxRecordBytes).toBe(32_768);
    expect(config.journey.maxAgeMs).toBe(1_800_000);
    expect(texts).toEqual([
      "batching.logFlushIntervalMs must be an integer from 100 to 60000. The value is 1.5. The library keeps 2000.",
      "batching.logBatchSize must be an integer from 1 to 1000. The value is 0. The library keeps 100.",
      'retention.mode must be "limited" or "until-delivered". The value is "forever". The library keeps "limited".',
      "retention.maxAttempts must be an integer from 1 to 20. The value is 21. The library keeps 5.",
      "limits.maxRecordBytes must be an integer from 1024 to 60000. The value is 60001. The library keeps 32768.",
      'journey.maxAgeMs must be an integer from 60000 to 86400000. The value is "60000". The library keeps 1800000.',
    ]);
  });

  it("reports an unknown key in each new section", () => {
    const { texts } = resolveTunables({
      batching: { logBatchSzie: 10 },
      retention: { maxAge: 1 },
      limits: { maxBody: 1 },
    });

    expect(texts).toEqual([
      'The library ignores the unknown config key "batching.logBatchSzie". Check the spelling.',
      'The library ignores the unknown config key "retention.maxAge". Check the spelling.',
      'The library ignores the unknown config key "limits.maxBody". Check the spelling.',
    ]);
  });
});

describe("applyResolvedConfig", () => {
  it("copies scalars in place and merges sections into the objects already there", () => {
    const { diagnostics } = collect();
    const live = resolveConfig({ ...valid(), capture: { fetch: false } }, diagnostics);
    // Many parts of the library keep these references from construction. They do not read them
    // again. The identity of each reference is the subject of this test.
    const capture = live.capture;
    const sampling = live.sampling;
    const bus = live.bus;

    const next = resolveConfig(
      { endpoint: OTHER_ENDPOINT, enabled: false, capture: { fetch: true } },
      diagnostics,
      live,
    );
    applyResolvedConfig(live, next);

    expect(live.endpoint).toBe(OTHER_ENDPOINT);
    expect(live.enabled).toBe(false);

    expect(live.capture).toBe(capture);
    expect(live.sampling).toBe(sampling);
    expect(live.bus).toBe(bus);

    // Merged in place, so a component holding `config.capture` sees the change.
    expect(capture.fetch).toBe(true);
    expect(capture.ignoreUrls).toEqual([OTHER_ENDPOINT]);
  });

  it("leaves sections that the reconfigure did not mention at their current values", () => {
    const { diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), sampling: { defaultRate: 0.25 }, console: "WARN" },
      diagnostics,
    );

    const next = resolveConfig({ minLevel: "ERROR" }, diagnostics, live);
    applyResolvedConfig(live, next);

    expect(live.minLevel).toBe("ERROR");
    expect(live.sampling.defaultRate).toBe(0.25);
    expect(live.console.level).toBe("WARN");
  });
});

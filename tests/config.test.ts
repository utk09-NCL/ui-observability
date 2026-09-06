// tests/config.test.ts
import { describe, expect, it } from "vitest";
import { applyResolvedConfig, resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { ObservabilityConfig, SamplingOptions } from "../src/models/config";

const ENDPOINT = "https://ingest.example/v1/logs";
const OTHER_ENDPOINT = "https://ingest-two.example/v1/logs";

/**
 * A diagnostics instance with the throttle disabled.
 *
 * The default one-second window would hide every message after the first, and
 * a single resolve can legitimately report several distinct problems. Throttling
 * is covered by the diagnostics tests; here it would only obscure the subject.
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
    expect(resolved.credentials).toBe("include");
    expect(resolved.storage).toBe("auto");
    expect(resolved.sampling.defaultRate).toBe(1);
    expect(resolved.sampling.alwaysSampleTypes).toEqual(["action"]);
    expect(resolved.bus.mode).toBe("auto");
    expect(resolved.capture.errors).toBe(true);
    expect(resolved.console).toBeNull();

    // The only complaint should be the absent serviceName.
    expect(messages(events)).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
  });

  it("reads the console option as off, on, or an explicit level", () => {
    const { diagnostics } = collect();

    expect(resolveConfig({ ...valid(), console: true }, diagnostics).console).toBe("DEBUG");
    expect(resolveConfig({ ...valid(), console: "WARN" }, diagnostics).console).toBe("WARN");

    // false has to turn off a level already in force, not fall through to it.
    const live = resolveConfig({ ...valid(), console: "WARN" }, diagnostics);
    expect(resolveConfig({ console: false }, diagnostics, live).console).toBeNull();
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
      // A JavaScript consumer can pass anything, which is the case this guard
      // exists for and the only place in the library that will ever notice.
      input.sampling = { defaultRate: "high" } as unknown as Partial<SamplingOptions>;

      const resolved = resolveConfig(input, diagnostics);

      expect(resolved.sampling.defaultRate).toBe(1);
      expect(messages(events)[0]).toContain("sampling.defaultRate must be 0..1, got high");
    });

    it("falls back to 1 when the rate is below zero", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig({ ...valid(), sampling: { defaultRate: -1 } }, diagnostics);

      expect(resolved.sampling.defaultRate).toBe(1);
      expect(messages(events)[0]).toContain("got -1");
    });

    it("falls back to 1 when the rate is above one", () => {
      const { events, diagnostics } = collect();

      const resolved = resolveConfig({ ...valid(), sampling: { defaultRate: 2 } }, diagnostics);

      expect(resolved.sampling.defaultRate).toBe(1);
      expect(messages(events)[0]).toContain("got 2");
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
      expect(messages(events)[0]).toContain('sampling.rates["app.blotter"] must be 0..1, got 5');
    });

    it("clamps a namespace rate that is not a number", () => {
      const { events, diagnostics } = collect();
      const input: Partial<ObservabilityConfig> = { ...valid() };
      input.sampling = {
        rates: { "app.ticket": null },
      } as unknown as Partial<SamplingOptions>;

      const resolved = resolveConfig(input, diagnostics);

      expect(resolved.sampling.rates["app.ticket"]).toBe(1);
      expect(messages(events)[0]).toContain("got null");
    });

    it("does not mutate the caller's rates object while clamping", () => {
      const { diagnostics } = collect();
      const rates = { "app.blotter": 5 };

      const resolved = resolveConfig({ ...valid(), sampling: { rates } }, diagnostics);

      expect(rates["app.blotter"]).toBe(5);
      expect(resolved.sampling.rates["app.blotter"]).toBe(1);
    });
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

      // The stale entry is gone, so the live endpoint is the one that is covered.
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

    // A one-key kill switch must not throw away everything else.
    expect(second.enabled).toBe(false);
    expect(second.endpoint).toBe(ENDPOINT);
    expect(second.serviceName).toBe("checkout");
    expect(second.minLevel).toBe("TRACE");
    expect(second.capture.fetch).toBe(true);
  });

  describe("unknown keys", () => {
    it("reports an unknown key by name rather than ignoring it silently", () => {
      const { events, diagnostics } = collect();
      // The failure this catches: every type checks out, because the argument
      // is a Partial, and nothing is ever sent.
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
  });

  describe("serializer", () => {
    it("defaults to OTLP, which is what a collector expects", () => {
      const { diagnostics } = collect();

      expect(resolveConfig(valid(), diagnostics).serializer.name).toBe("otlp");
    });

    it("resolves a name to the implementation that ships with it", () => {
      const { events, diagnostics } = collect();
      const ecs = resolveConfig({ ...valid(), serializer: "ecs" }, diagnostics);
      const otlp = resolveConfig({ ...valid(), serializer: "otlp" }, diagnostics);

      expect(ecs.serializer.name).toBe("ecs");
      expect(otlp.serializer.name).toBe("otlp");
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

      expect(resolveConfig({ minLevel: "ERROR" }, diagnostics, live).serializer.name).toBe("ecs");
    });

    it("reports a name it does not know and falls back, rather than sending nothing", () => {
      const { events, diagnostics } = collect();
      const named = "xml" as unknown as ObservabilityConfig["serializer"];

      expect(resolveConfig({ ...valid(), serializer: named }, diagnostics).serializer.name).toBe(
        "otlp",
      );
      expect(messages(events)[0]).toContain("serializer must be");
    });

    it("rejects a null and an object that cannot serialize", () => {
      const { events, diagnostics } = collect();
      const nothing = null as unknown as ObservabilityConfig["serializer"];
      const halfBuilt = { name: "half-built" } as unknown as ObservabilityConfig["serializer"];

      const fromNull = resolveConfig({ ...valid(), serializer: nothing }, diagnostics);
      const fromHalfBuilt = resolveConfig({ ...valid(), serializer: halfBuilt }, diagnostics);

      expect(fromNull.serializer.name).toBe("otlp");
      expect(fromHalfBuilt.serializer.name).toBe("otlp");
      expect(events).toHaveLength(2);
    });
  });
});

describe("applyResolvedConfig", () => {
  it("copies scalars in place and merges sections into the objects already there", () => {
    const { diagnostics } = collect();
    const live = resolveConfig({ ...valid(), capture: { fetch: false } }, diagnostics);
    // Half the library captures these references once at construction and never
    // looks them up again, so their identity is the thing under test.
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
    expect(live.console).toBe("WARN");
  });
});

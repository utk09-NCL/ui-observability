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
    expect(resolved.streams.logs).toEqual({ flushIntervalMs: 2000, batchSize: 100 });
    expect(resolved.streams.metrics).toEqual({ flushIntervalMs: 10_000, batchSize: 500 });
    expect(resolved.maxConcurrentRequests).toBe(2);
    expect(resolved.compression).toBe("gzip");
    expect(resolved.credentials).toBe("include");
    expect(resolved.storage.strategy).toBe("auto");
    expect(resolved.retry.baseDelayMs).toBe(2000);
    expect(resolved.sampling.defaultRate).toBe(1);
    expect(resolved.journey.urlParam).toBe("__uiobs_journey");
    expect(resolved.bus.mode).toBe("auto");
    expect(resolved.limits.maxDepth).toBe(6);
    expect(resolved.console.enabled).toBe(false);

    // The only complaint should be the absent serviceName.
    expect(messages(events)).toHaveLength(1);
    expect(events[0].code).toBe("config.invalid");
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

  it("merges a partial stream policy onto the default for that stream only", () => {
    const { diagnostics } = collect();

    const resolved = resolveConfig(
      { ...valid(), streams: { logs: { batchSize: 5 } } },
      diagnostics,
    );

    expect(resolved.streams.logs).toEqual({ flushIntervalMs: 2000, batchSize: 5 });
    expect(resolved.streams.metrics).toEqual({ flushIntervalMs: 10_000, batchSize: 500 });
  });

  it("merges a partial metrics policy without disturbing the logs policy", () => {
    const { diagnostics } = collect();

    const resolved = resolveConfig(
      { ...valid(), streams: { metrics: { flushIntervalMs: 1 } } },
      diagnostics,
    );

    expect(resolved.streams.metrics).toEqual({ flushIntervalMs: 1, batchSize: 500 });
    expect(resolved.streams.logs).toEqual({ flushIntervalMs: 2000, batchSize: 100 });
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
});

describe("applyResolvedConfig", () => {
  it("copies scalars in place and merges sections into the objects already there", () => {
    const { diagnostics } = collect();
    const live = resolveConfig({ ...valid(), capture: { fetch: false } }, diagnostics);
    // Half the library captures these references once at construction and never
    // looks them up again, so their identity is the thing under test.
    const capture = live.capture;
    const journey = live.journey;
    const streams = live.streams;

    const next = resolveConfig(
      { endpoint: OTHER_ENDPOINT, enabled: false, capture: { fetch: true } },
      diagnostics,
      live,
    );
    applyResolvedConfig(live, next);

    expect(live.endpoint).toBe(OTHER_ENDPOINT);
    expect(live.enabled).toBe(false);

    expect(live.capture).toBe(capture);
    expect(live.journey).toBe(journey);
    expect(live.streams).toBe(streams);

    // Merged in place, so a component holding `config.capture` sees the change.
    expect(capture.fetch).toBe(true);
    expect(capture.ignoreUrls).toEqual([OTHER_ENDPOINT]);
  });

  it("leaves sections that the reconfigure did not mention at their current values", () => {
    const { diagnostics } = collect();
    const live = resolveConfig(
      { ...valid(), limits: { maxDepth: 2 }, console: { enabled: true } },
      diagnostics,
    );

    const next = resolveConfig({ minLevel: "ERROR" }, diagnostics, live);
    applyResolvedConfig(live, next);

    expect(live.minLevel).toBe("ERROR");
    expect(live.limits.maxDepth).toBe(2);
    expect(live.console.enabled).toBe(true);
  });
});

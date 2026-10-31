import { describe, expect, it, vi } from "vitest";
import { RECORD_LIMITS } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { ContextStore } from "../src/core/context";
import { Diagnostics } from "../src/core/diagnostics";
import { JOURNEY_OPTIONS, JourneyEngine } from "../src/core/journey";
import { RemoteSampling } from "../src/core/remote-sampling";
import {
  type BuildInput,
  RecordBuilder,
  type RecordBuilderDeps,
  type RecordLimits,
} from "../src/core/record";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";
import type { PlatformMetadata } from "../src/utils/platform";
import { Sequence } from "../src/utils/sequence";
import { TraceEngine } from "../src/utils/tracing";

const browser: PlatformMetadata = {
  platform: "browser",
  userAgent: "test-agent",
  isWorker: false,
  isTopLevelDocument: true,
};

const openfin: PlatformMetadata = {
  platform: "openfin",
  openfinUuid: "app-uuid",
  openfinName: "blotter-window",
  userAgent: "test-agent",
  isWorker: false,
  isTopLevelDocument: true,
};

/**
 * A builder with real collaborators, not mocks.
 *
 * The builder combines what those collaborators give. Stubs of them leave the combination untested.
 * The test replaces only the parts that it cannot reach in other ways. An example is a context
 * store that throws.
 */
function makeBuilder(
  overrides: Partial<ObservabilityConfig> = {},
  platform = browser,
  limits: RecordLimits = RECORD_LIMITS,
) {
  const diagnostics = new Diagnostics(vi.fn(), 0);
  const config = resolveConfig(
    {
      endpoint: "https://collector.test/v1/logs",
      serviceName: "svc",
      serviceVersion: "2.1.0",
      environment: "test",
      minLevel: "INFO",
      ...overrides,
    },
    diagnostics,
  );
  const journey = new JourneyEngine(JOURNEY_OPTIONS, diagnostics, "ctx-1", vi.fn());
  const context = new ContextStore();
  const deps: RecordBuilderDeps = {
    config,
    limits,
    diagnostics,
    context,
    journey,
    tracing: new TraceEngine(diagnostics),
    sequence: new Sequence(),
    identity: { sessionId: "s1", tabId: "t1", contextId: "c1" },
    platform,
    remote: { sampling: null },
  };
  return { builder: new RecordBuilder(deps), config, context, deps, diagnostics, journey };
}

const input: BuildInput = { level: "INFO", type: "event", body: "hello", namespace: "test" };

/** Builds a record and asserts that it exists. Each test can then read fields with no check. */
const built = (builder: RecordBuilder, overrides: Partial<BuildInput> = {}): LogRecord => {
  const { record } = builder.build({ ...input, ...overrides });
  expect(record).not.toBeNull();
  return record!;
};

describe("minLevels", () => {
  it("applies the level of the longest matching prefix, and minLevel to the rest", () => {
    const { builder } = makeBuilder({
      minLevel: "WARN",
      minLevels: { trading: "INFO", "trading.ticks": "DEBUG" },
    });

    expect(builder.isEnabled("DEBUG", "trading.ticks.fx")).toBe(true);
    expect(builder.isEnabled("DEBUG", "trading.orders")).toBe(false);
    expect(builder.isEnabled("INFO", "trading.orders")).toBe(true);
    // A prefix matches only at a dot. tradingdesk is not a child of trading.
    expect(builder.isEnabled("INFO", "tradingdesk")).toBe(false);
    expect(built(builder, { namespace: "trading.ticks", level: "DEBUG" }).severityText).toBe(
      "DEBUG",
    );
  });

  it("lets a remote prefix lower the level of a namespace", () => {
    const { builder, deps, config } = makeBuilder({ sampling: { remote: true } });
    const sampling = new RemoteSampling(config);
    deps.remote.sampling = sampling;

    sampling.apply({ rules: { rates: {}, minLevels: { pricing: "TRACE" } }, ttlMs: 60_000 });

    expect(builder.isEnabled("TRACE", "pricing.grid")).toBe(true);
    expect(builder.isEnabled("DEBUG", "trading")).toBe(false);
  });
});

describe("contextProvider", () => {
  it("adds its attributes over the context and under the scope and the payload", () => {
    const { builder, deps } = makeBuilder({
      contextProvider: () => ({ route: "/blotter", a: "provider", b: "provider", c: "provider" }),
    });
    deps.context.set("a", "context");
    deps.context.set("user", "u1");

    const record = built(builder, { scoped: { b: "scope" }, payload: { c: "payload" } });

    expect(record.attributes).toMatchObject({
      user: "u1",
      route: "/blotter",
      a: "provider",
      b: "scope",
      c: "payload",
    });
  });

  it("is not called for a record that sampling drops", () => {
    const provider = vi.fn(() => ({ route: "/blotter" }));
    const { builder } = makeBuilder({ contextProvider: provider, sampling: { defaultRate: 0 } });

    builder.build(input);

    expect(provider).not.toHaveBeenCalled();
  });

  it("adds nothing for undefined, and reports nothing", () => {
    const { builder, diagnostics } = makeBuilder({ contextProvider: () => undefined });

    expect(built(builder).attributes).not.toHaveProperty("route");
    expect(diagnostics.snapshot()["config.invalid"]).toBeUndefined();
  });

  it("reports a provider that throws, and still builds the record", () => {
    const { builder, diagnostics } = makeBuilder({
      contextProvider: () => {
        throw new Error("store gone");
      },
    });

    expect(built(builder).body).toBe("hello");
    expect(diagnostics.snapshot()["handler.threw"]).toBe(1);
  });

  it.each([
    ["a string", "route"],
    ["a promise", Promise.resolve({ route: "/blotter" })],
    ["an array", ["route"]],
  ])("reports %s, and adds nothing", (_name, value) => {
    const { builder, diagnostics } = makeBuilder({
      contextProvider: () => value as unknown as Record<string, unknown>,
    });

    expect(built(builder).attributes).not.toHaveProperty("route");
    expect(diagnostics.snapshot()["config.invalid"]).toBe(1);
  });
});

describe("the level gate", () => {
  it("drops a record below the configured minimum and counts the drop", () => {
    const { builder, diagnostics } = makeBuilder();

    expect(builder.build({ ...input, level: "DEBUG" })).toEqual({
      record: null,
      dropped: "level",
    });
    expect(diagnostics.snapshot()["record.dropped_by_level"]).toBe(1);
  });

  it("keeps a record at exactly the minimum level", () => {
    // The comparison is `>=`. An off-by-one error here discards all records of one level with no
    // message.
    const { builder } = makeBuilder({ minLevel: "WARN" });

    expect(builder.isEnabled("WARN", "test")).toBe(true);
    expect(built(builder, { level: "WARN" }).severityText).toBe("WARN");
  });

  it("builds nothing at all when logging is disabled, whatever the level", () => {
    const { builder } = makeBuilder({ enabled: false });

    expect(builder.isEnabled("FATAL", "test")).toBe(false);
    expect(builder.build({ ...input, level: "FATAL" }).record).toBeNull();
  });

  it("keeps an action and a metric below minLevel, and drops a log record", () => {
    const { builder } = makeBuilder({ minLevel: "ERROR" });

    expect(builder.isEnabled("INFO", "test", "action")).toBe(true);
    expect(built(builder, { type: "action" }).attributes["log.type"]).toBe("action");
    expect(built(builder, { type: "metric" }).attributes["log.type"]).toBe("metric");
    expect(builder.build({ ...input, type: "log" }).dropped).toBe("level");
  });

  it("drops an action when logging is disabled", () => {
    const { builder } = makeBuilder({ enabled: false });

    expect(builder.build({ ...input, type: "action" }).record).toBeNull();
  });

  it("rejects before allocating, which is what makes a hot-loop debug call cheap", () => {
    // Only a record that passes the gate advances the sequence. A gap in it shows that the gate
    // built a record before it rejected it.
    const { builder } = makeBuilder();

    builder.build({ ...input, level: "DEBUG" });

    expect(built(builder).attributes["log.seq"]).toBe(1);
  });

  it("applies the remote rules to the level gate and to sampling", () => {
    const { builder, deps, config } = makeBuilder({ sampling: { defaultRate: 0, remote: true } });
    const sampling = new RemoteSampling(config);
    deps.remote.sampling = sampling;

    sampling.apply({ rules: { rates: { test: 1 }, minLevel: "DEBUG" }, ttlMs: 60_000 });

    expect(builder.isEnabled("DEBUG", "test")).toBe(true);
    expect(built(builder, { level: "DEBUG" }).severityText).toBe("DEBUG");
  });

  it("drops a sampled-out record before it walks the payload", () => {
    // This gate prevents the cost of a sanitize pass for a record that the library does not send.
    // The getter must never run.
    const { builder, diagnostics } = makeBuilder({ sampling: { defaultRate: 0 } });
    let reads = 0;
    const payload = {
      get orderId() {
        reads += 1;
        return "o-1";
      },
    };

    expect(builder.build({ ...input, payload })).toEqual({
      record: null,
      dropped: "sampling",
    });

    expect(reads).toBe(0);
    expect(diagnostics.snapshot()["record.dropped_by_sampling"]).toBe(1);
    expect(built(builder, { namespace: "kept", type: "action" }).attributes["log.seq"]).toBe(1);
  });
});

describe("attributes", () => {
  it("layers the runtime context under the scoped context under the payload", () => {
    const { builder, context } = makeBuilder();
    context.setMany({ desk: "eq-flow", region: "emea" });

    const record = built(builder, {
      scoped: { region: "apac", widget: "blotter" },
      payload: { widget: "grid" },
    });

    expect(record.attributes.desk).toBe("eq-flow");
    expect(record.attributes.region).toBe("apac");
    expect(record.attributes.widget).toBe("grid");
  });

  it("writes the reserved keys after the payload, so a caller cannot spoof them", () => {
    const { builder, journey } = makeBuilder();
    journey.start("real");

    const record = built(builder, {
      payload: { "journey.id": "spoofed", "log.type": "action", "app.namespace": "elsewhere" },
    });

    expect(record.attributes["journey.id"]).not.toBe("spoofed");
    expect(record.attributes["log.type"]).toBe("event");
    expect(record.attributes["app.namespace"]).toBe("test");
  });

  it("numbers records within the context, in order", () => {
    const { builder } = makeBuilder();

    expect(built(builder).attributes["log.seq"]).toBe(1);
    expect(built(builder).attributes["log.seq"]).toBe(2);
  });

  it("stamps the active journey on every record", () => {
    const { builder, journey } = makeBuilder();
    const started = journey.start("order-lifecycle");

    const record = built(builder);

    expect(record.attributes["journey.id"]).toBe(started.id);
    expect(record.attributes["journey.name"]).toBe("order-lifecycle");
    expect(record.attributes["journey.parent_id"]).toBeUndefined();
  });

  it("carries no journey keys at all when no journey is running", () => {
    const { builder } = makeBuilder();

    expect("journey.id" in built(builder).attributes).toBe(false);
  });

  it("stamps the parent link only on a journey started as a child", () => {
    const { builder, journey } = makeBuilder();
    const parent = journey.start("checkout");
    journey.start("payment", { parent: true });

    expect(built(builder).attributes["journey.parent_id"]).toBe(parent.id);
  });

  it("stamps the document URL as page.url and leaves url.full to whoever owns the request", () => {
    // `url.full` names the target of the request that a record tells about. If the builder writes
    // the page URL there, each captured request shows the page as its target. The real target is
    // then only in the body string.
    const { builder } = makeBuilder();

    const record = built(builder, { payload: { "url.full": "https://api.internal/orders" } });

    expect(record.attributes["url.full"]).toBe("https://api.internal/orders");
    expect(record.attributes["page.url"]).toBeTypeOf("string");
  });

  it("stamps page.url without its query string, which carries tokens and user input", () => {
    vi.stubGlobal("location", { href: "https://app.test/checkout?token=secret#step2" });
    const { builder } = makeBuilder();

    expect(built(builder).attributes["page.url"]).toBe("https://app.test/checkout");
  });

  it("keeps the whole page URL when the consumer asks for it", () => {
    vi.stubGlobal("location", { href: "https://app.test/checkout?token=secret#step2" });
    const { builder } = makeBuilder({ capture: { fullUrls: true } });

    expect(built(builder).attributes["page.url"]).toBe(
      "https://app.test/checkout?token=secret#step2",
    );
  });

  it("builds a serializable record from a circular payload instead of throwing", () => {
    const { builder } = makeBuilder();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const record = built(builder, { payload: circular });

    expect(() => JSON.stringify(record)).not.toThrow();
    expect(record.attributes.self).toBe("[Circular]");
  });

  it("marks the record and reports when the attributes cannot be read at all", () => {
    // The sanitizer itself cannot throw. A read of the attributes from an injected dependency can
    // throw before the sanitizer sees them. That throw must cost the attributes of this record. It
    // must not go back into the logging call of the consumer.
    const { deps, diagnostics } = makeBuilder();
    const unreadable = {
      getAll: (): Record<string, unknown> => {
        throw new Error("the store is gone");
      },
    } as unknown as ContextStore;

    const record = built(new RecordBuilder({ ...deps, context: unreadable }));

    expect(record.attributes["uiobs.sanitize_failed"]).toBe(true);
    expect(record.attributes["log.type"]).toBe("event");
    expect(diagnostics.snapshot()["record.sanitize_failed"]).toBe(1);
  });
});

describe("the body", () => {
  it("truncates an overlong body and counts it", () => {
    const { builder, diagnostics } = makeBuilder({}, browser, {
      ...RECORD_LIMITS,
      maxBodyChars: 10,
    });

    const record = built(builder, { body: "x".repeat(50) });

    expect(record.body).toContain("truncated");
    expect(diagnostics.snapshot()["record.truncated"]).toBe(1);
  });

  it("leaves a body inside the limit untouched and counts nothing", () => {
    const { builder, diagnostics } = makeBuilder();

    expect(built(builder).body).toBe("hello");
    expect(diagnostics.snapshot()["record.truncated"]).toBeUndefined();
  });
});

describe("the redact hook", () => {
  it("lets the hook drop a record entirely", () => {
    const { builder, diagnostics } = makeBuilder({ redact: () => null });

    expect(builder.build(input)).toEqual({ record: null, dropped: "redact" });
    expect(diagnostics.snapshot()["record.dropped_by_redact"]).toBe(1);
  });

  it("keeps the record when the hook edits it in place", () => {
    const { builder } = makeBuilder({
      redact: (record) => {
        record.attributes.masked = true;
        return record;
      },
    });

    expect(built(builder).attributes.masked).toBe(true);
  });

  it("drops the record when the hook throws, because the record is not redacted", () => {
    const { builder, diagnostics } = makeBuilder({
      redact: () => {
        throw new Error("consumer bug");
      },
    });

    expect(builder.build(input)).toEqual({ record: null, dropped: "redact" });
    expect(diagnostics.snapshot()["record.dropped_by_redact"]).toBe(1);
  });

  it("keeps the record when the hook edits it in place and returns nothing", () => {
    const { builder } = makeBuilder({
      redact: ((record: LogRecord) => {
        record.attributes.masked = true;
      }) as unknown as ObservabilityConfig["redact"],
    });

    expect(built(builder).attributes.masked).toBe(true);
  });

  it("sanitizes attributes a hook substituted, so one hook cannot poison a batch", () => {
    // The hook can return any value. The sanitizer did not see its result. An unserializable value
    // here gets to the transport. The transport then classifies the whole batch as unserializable.
    // The batch then loses a hundred good records from other loggers.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { builder } = makeBuilder({
      redact: (record) => ({ ...record, attributes: { circular } }),
    });

    const record = built(builder);

    expect(() => JSON.stringify(record)).not.toThrow();
    expect((record.attributes.circular as Record<string, unknown>).self).toBe("[Circular]");
  });

  it("re-measures a record the hook replaced, rather than trusting the old total", () => {
    // The byte total is for the record that the builder made. It is not for the value that the hook
    // returned.
    const { builder } = makeBuilder(
      { redact: (record) => ({ ...record, attributes: { huge: "x".repeat(5000) } }) },
      browser,
      { ...RECORD_LIMITS, maxRecordBytes: 200 },
    );

    const record = built(builder);

    expect(record.attributes["uiobs.attributes_dropped"]).toBe(true);
    expect(record.attributes.huge).toBeUndefined();
  });

  it("drops the record when the hook returns something that is not a record", () => {
    // A plain JavaScript hook can return a string or a Promise. The original record
    // did not pass redact and must not leave the page.
    const { builder, diagnostics } = makeBuilder({
      redact: (() => Promise.resolve(null)) as unknown as ObservabilityConfig["redact"],
    });

    expect(builder.build(input)).toEqual({ record: null, dropped: "redact" });
    expect(diagnostics.snapshot()["record.dropped_by_redact"]).toBe(1);
  });

  it("drops a record that the hook changed in place to a broken shape", () => {
    const { builder, diagnostics } = makeBuilder({
      redact: (record) => {
        (record as unknown as Record<string, unknown>).attributes = null;
        return record;
      },
    });

    expect(builder.build(input)).toEqual({ record: null, dropped: "malformed" });
    expect(diagnostics.snapshot()["record.dropped_malformed"]).toBe(1);
  });

  it("drops a record whose hook sets a severityText that is not a level", () => {
    const { builder, diagnostics } = makeBuilder({
      redact: (record) => ({ ...record, severityText: "LOUD" as LogRecord["severityText"] }),
    });

    expect(builder.build(input)).toEqual({ record: null, dropped: "malformed" });
    expect(diagnostics.snapshot()["record.dropped_malformed"]).toBe(1);
  });

  it("sets severityNumber from the severityText that the hook set", () => {
    const replaced = makeBuilder({ redact: (record) => ({ ...record, severityText: "ERROR" }) });
    const inPlace = makeBuilder({
      redact: (record) => {
        record.severityText = "WARN";
        return record;
      },
    });

    expect(built(replaced.builder).severityNumber).toBe(17);
    expect(built(inPlace.builder).severityNumber).toBe(13);
  });
});

describe("the size budget", () => {
  it("keeps the keys that make a record findable when oversized attributes are dropped", () => {
    // If the builder drops the journey here, the record with the most value for a search has no key
    // for the search.
    const { builder, journey, diagnostics } = makeBuilder({}, browser, {
      ...RECORD_LIMITS,
      maxRecordBytes: 200,
    });
    const started = journey.start("order-lifecycle");

    const record = built(builder, { payload: { blob: "x".repeat(50_000) } });

    expect(record.attributes["uiobs.attributes_dropped"]).toBe(true);
    expect(record.attributes["uiobs.attributes_bytes"]).toBeGreaterThan(200);
    expect(record.attributes.blob).toBeUndefined();
    expect(record.attributes["journey.id"]).toBe(started.id);
    expect(record.attributes["journey.name"]).toBe("order-lifecycle");
    expect(record.attributes["log.seq"]).toBe(1);
    expect(record.attributes["page.url"]).toBeTypeOf("string");
    expect(record.traceId).toHaveLength(32);
    expect(diagnostics.snapshot()["record.truncated"]).toBe(1);
  });

  it("keeps page.url and the journey keys after redact when it drops the attributes", () => {
    vi.stubGlobal("location", { href: "https://app.test/checkout?token=secret" });
    const { builder, journey } = makeBuilder(
      {
        capture: { fullUrls: true },
        redact: (record) => {
          record.attributes["page.url"] = "https://app.test/checkout";
          delete record.attributes["journey.name"];
          return record;
        },
      },
      browser,
      { ...RECORD_LIMITS, maxRecordBytes: 200 },
    );
    const started = journey.start("order-lifecycle");

    const record = built(builder, { payload: { blob: "x".repeat(50_000) } });

    expect(record.attributes["uiobs.attributes_dropped"]).toBe(true);
    expect(record.attributes["page.url"]).toBe("https://app.test/checkout");
    expect(record.attributes["journey.id"]).toBe(started.id);
    expect(record.attributes).not.toHaveProperty("journey.name");
  });

  it("drops oversized attributes with no journey running, keeping the rest", () => {
    const { builder } = makeBuilder({}, browser, { ...RECORD_LIMITS, maxRecordBytes: 200 });

    const record = built(builder, { payload: { blob: "x".repeat(50_000) } });

    expect(record.attributes["uiobs.attributes_dropped"]).toBe(true);
    expect("journey.id" in record.attributes).toBe(false);
    expect(record.attributes["app.namespace"]).toBe("test");
  });

  it("keeps each error field and the breadcrumbs that fit when it drops the caller attributes", () => {
    const { builder } = makeBuilder({}, browser, { ...RECORD_LIMITS, maxRecordBytes: 2000 });
    const breadcrumbs = [{ t: 1, category: "log", message: "clicked save" }];

    const record = built(builder, {
      level: "ERROR",
      payload: {
        blob: "x".repeat(50_000),
        "error.type": "TypeError",
        "error.message": "boom",
        breadcrumbs,
      },
    });

    expect(record.attributes.blob).toBeUndefined();
    expect(record.attributes["error.type"]).toBe("TypeError");
    expect(record.attributes["error.message"]).toBe("boom");
    expect(record.attributes.breadcrumbs).toEqual(breadcrumbs);
  });

  it("drops error.data, then the breadcrumbs, when the error fields are too large", () => {
    const { builder } = makeBuilder({}, browser, { ...RECORD_LIMITS, maxRecordBytes: 2000 });

    const record = built(builder, {
      level: "ERROR",
      payload: {
        blob: "x".repeat(50_000),
        "error.type": "TypeError",
        "error.data": { dump: "y".repeat(5000) },
        breadcrumbs: [{ t: 1, category: "log", message: "z".repeat(3000) }],
      },
    });

    expect(record.attributes["error.type"]).toBe("TypeError");
    expect(record.attributes["error.data"]).toBeUndefined();
    expect(record.attributes.breadcrumbs).toBeUndefined();
  });

  it("leaves a record inside the budget completely alone", () => {
    const { builder } = makeBuilder();

    const record = built(builder, { payload: { orderId: "A-1" } });

    expect(record.attributes.orderId).toBe("A-1");
    expect("uiobs.attributes_dropped" in record.attributes).toBe(false);
  });
});

describe("the resource block", () => {
  it("carries the identity and service fields every record is grouped by", () => {
    const { builder } = makeBuilder();

    const { resource } = built(builder);

    expect(resource["service.name"]).toBe("svc");
    expect(resource["service.version"]).toBe("2.1.0");
    expect(resource["deployment.environment"]).toBe("test");
    expect(resource["telemetry.sdk.name"]).toBe("@utk09/ui-observability");
    expect(resource["telemetry.sdk.language"]).toBe("webjs");
    expect(resource["session.id"]).toBe("s1");
    expect(resource["tab.id"]).toBe("t1");
    expect(resource["context.id"]).toBe("c1");
    expect(resource["host.platform"]).toBe("browser");
    expect(resource["browser.user_agent"]).toBe("test-agent");
  });

  it("is the same object on every record until it is invalidated", () => {
    // The resource cannot change between two records from one context. It is the largest part of a
    // record. A rebuild for each record is the largest waste on this hot path.
    const { builder } = makeBuilder();
    const first = built(builder).resource;

    expect(built(builder).resource).toBe(first);

    builder.invalidateResource();

    expect(built(builder).resource).not.toBe(first);
  });

  it("carries the OpenFin identifiers only on a desktop runtime", () => {
    const { builder } = makeBuilder({}, openfin);
    const { builder: inBrowser } = makeBuilder();

    expect(built(builder).resource["openfin.uuid"]).toBe("app-uuid");
    expect(built(builder).resource["openfin.name"]).toBe("blotter-window");
    expect("openfin.uuid" in built(inBrowser).resource).toBe(false);
    expect("openfin.name" in built(inBrowser).resource).toBe(false);
  });
});

describe("the record itself", () => {
  it("carries the trace of the context it was built in, shared with the next record", () => {
    const { builder } = makeBuilder();

    const first = built(builder);
    const second = built(builder);

    expect(first.traceId).toBe(second.traceId);
    expect(first.traceId).toHaveLength(32);
    expect(first.spanId).toHaveLength(16);
  });

  it("numbers the severity as OpenTelemetry does, alongside the text", () => {
    const { builder } = makeBuilder({ minLevel: "TRACE" });

    expect(built(builder, { level: "ERROR" }).severityNumber).toBe(17);
    expect(built(builder, { level: "ERROR" }).severityText).toBe("ERROR");
  });

  it("timestamps in nanoseconds and leaves the observed time to whoever sends it", () => {
    // Those two fields have different values on a forwarded record. Their difference is the only
    // measure of the forward lag. If the builder sets both here, the second one gives no
    // information.
    const { builder } = makeBuilder();

    const record = built(builder);

    expect(record.timeUnixNano).toMatch(/^\d+000000$/);
    expect(record.observedTimeUnixNano).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { ContextStore } from "../src/core/context";
import { Diagnostics } from "../src/core/diagnostics";
import { JourneyEngine } from "../src/core/journey";
import { type BuildInput, RecordBuilder, type RecordBuilderDeps } from "../src/core/record";
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
 * A builder wired to real collaborators rather than mocks.
 *
 * The record builder's whole job is to combine what those collaborators say, so
 * stubbing them would leave the combining untested. Only the pieces a test
 * cannot otherwise reach, such as a context store that throws, get replaced.
 */
function makeBuilder(overrides: Partial<ObservabilityConfig> = {}, platform = browser) {
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
  const journey = new JourneyEngine(config.journey, diagnostics, "ctx-1", vi.fn());
  const context = new ContextStore();
  const deps: RecordBuilderDeps = {
    config,
    diagnostics,
    context,
    journey,
    tracing: new TraceEngine(diagnostics),
    sequence: new Sequence(),
    identity: { sessionId: "s1", tabId: "t1", contextId: "c1" },
    platform,
  };
  return { builder: new RecordBuilder(deps), config, context, deps, diagnostics, journey };
}

const input: BuildInput = { level: "INFO", type: "event", body: "hello", namespace: "test" };

/** Build and assert a record came back, so each test can read fields without repeating the check. */
const built = (builder: RecordBuilder, overrides: Partial<BuildInput> = {}): LogRecord => {
  const record = builder.build({ ...input, ...overrides });
  expect(record).not.toBeNull();
  return record!;
};

describe("the level gate", () => {
  it("drops a record below the configured minimum and counts the drop", () => {
    const { builder, diagnostics } = makeBuilder();

    expect(builder.build({ ...input, level: "DEBUG" })).toBeNull();
    expect(diagnostics.snapshot()["record.dropped_by_level"]).toBe(1);
  });

  it("keeps a record at exactly the minimum level", () => {
    // The comparison is `>=`, and an off-by-one here would silently discard an
    // entire level's worth of records.
    const { builder } = makeBuilder({ minLevel: "WARN" });

    expect(builder.isEnabled("WARN")).toBe(true);
    expect(built(builder, { level: "WARN" }).severityText).toBe("WARN");
  });

  it("builds nothing at all when logging is disabled, whatever the level", () => {
    const { builder } = makeBuilder({ enabled: false });

    expect(builder.isEnabled("FATAL")).toBe(false);
    expect(builder.build({ ...input, level: "FATAL" })).toBeNull();
  });

  it("rejects before allocating, which is what makes a hot-loop debug call cheap", () => {
    // The sequence is only advanced by a record that survives the gate, so a
    // gap in it would mean the gate had built something before rejecting it.
    const { builder } = makeBuilder();

    builder.build({ ...input, level: "DEBUG" });

    expect(built(builder).attributes["log.seq"]).toBe(1);
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
    // `url.full` names the target of the request a record is about. Stamping
    // the page URL over it would rewrite every captured request to the page it
    // was made from, leaving the real target only inside the body string.
    const { builder } = makeBuilder();

    const record = built(builder, { payload: { "url.full": "https://api.internal/orders" } });

    expect(record.attributes["url.full"]).toBe("https://api.internal/orders");
    expect(record.attributes["page.url"]).toBeTypeOf("string");
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
    // Sanitizing itself cannot throw. What can is reading the attributes out of
    // an injected dependency before the sanitizer ever sees them, and that must
    // cost this record's attributes rather than throwing back into the
    // consumer's own logging call.
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
    const { builder, diagnostics } = makeBuilder({ limits: { maxBodyChars: 10 } });

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

    expect(builder.build(input)).toBeNull();
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

  it("survives a hook that throws, rather than losing the record", () => {
    const { builder, diagnostics } = makeBuilder({
      redact: () => {
        throw new Error("consumer bug");
      },
    });

    expect(built(builder).body).toBe("hello");
    expect(diagnostics.snapshot()["record.sanitize_failed"]).toBe(1);
  });

  it("sanitizes attributes a hook substituted, so one hook cannot poison a batch", () => {
    // The hook can return anything, and its result has not been through the
    // sanitizer. An unserializable value here reaches the transport, where the
    // whole batch is classified as unserializable and a hundred good records
    // from other loggers die with it.
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
    // The running byte total describes the record that was built, not whatever
    // the hook handed back.
    const { builder } = makeBuilder({
      limits: { maxRecordBytes: 200 },
      redact: (record) => ({ ...record, attributes: { huge: "x".repeat(5000) } }),
    });

    const record = built(builder);

    expect(record.attributes["uiobs.attributes_dropped"]).toBe(true);
    expect(record.attributes.huge).toBeUndefined();
  });

  it("keeps the original record when the hook returns something that is not a record", () => {
    // These hooks are written in plain JavaScript, where nothing stops one
    // returning a string. Losing the redaction is reported; shipping a
    // malformed record would lose the batch it travels in.
    const { builder, diagnostics } = makeBuilder({
      redact: (() => "not a record") as unknown as ObservabilityConfig["redact"],
    });

    const record = built(builder);

    expect(record.body).toBe("hello");
    expect(record.attributes["log.type"]).toBe("event");
    expect(diagnostics.snapshot()["record.sanitize_failed"]).toBe(1);
  });
});

describe("the size budget", () => {
  it("keeps the keys that make a record findable when oversized attributes are dropped", () => {
    // Dropping the journey here would leave the one record most worth looking
    // up as the one record with nothing to look it up by.
    const { builder, journey, diagnostics } = makeBuilder({ limits: { maxRecordBytes: 200 } });
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

  it("drops oversized attributes with no journey running, keeping the rest", () => {
    const { builder } = makeBuilder({ limits: { maxRecordBytes: 200 } });

    const record = built(builder, { payload: { blob: "x".repeat(50_000) } });

    expect(record.attributes["uiobs.attributes_dropped"]).toBe(true);
    expect("journey.id" in record.attributes).toBe(false);
    expect(record.attributes["app.namespace"]).toBe("test");
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
    // It cannot change between two records from one context, and it is the
    // largest part of a record, so rebuilding it per record would be the
    // biggest waste on the hottest path here.
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
    // Those two fields genuinely differ on a forwarded record, and that
    // difference is the only measure of forwarding lag there is. Setting both
    // here would make the second one say nothing.
    const { builder } = makeBuilder();

    const record = built(builder);

    expect(record.timeUnixNano).toMatch(/^\d+000000$/);
    expect(record.observedTimeUnixNano).toBeUndefined();
  });
});

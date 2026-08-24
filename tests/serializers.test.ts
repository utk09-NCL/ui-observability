import { describe, expect, it } from "vitest";
import { type LogBatch, splitBatch } from "../src/models/batch";
import type { LogRecord } from "../src/models/log-record";
import { ecsSerializer } from "../src/transport/serializers/ecs";
import { otlpSerializer } from "../src/transport/serializers/otlp";

const record = (over: Partial<LogRecord> = {}): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "hello",
  attributes: { "log.type": "event" },
  resource: { "service.name": "svc" },
  ...over,
});

/** The parsed OTLP payload for one batch. */
const otlp = (records: LogRecord[]): any => JSON.parse(otlpSerializer.serialize(records).body);

/** The single record of a one-record OTLP payload, as the collector receives it. */
const only = (r: LogRecord): any => otlp([r]).resourceLogs[0].scopeLogs[0].logRecords[0];

/** That record's attributes back as an object, since OTLP sends them as a list of pairs. */
const attrs = (r: LogRecord): Record<string, any> =>
  Object.fromEntries(only(r).attributes.map((a: any) => [a.key, a.value]));

/** The attribute names that survived encoding, in order. */
const attrKeys = (r: LogRecord): string[] => only(r).attributes.map((a: any) => a.key);

/** The parsed ECS document for one record. */
const ecs = (r: LogRecord): any => JSON.parse(ecsSerializer.serialize([r]).body.trimEnd());

describe("otlpSerializer", () => {
  it("groups records by resource, so forwarded records are not mislabelled", () => {
    const parent = { "service.name": "platform" };
    const child = { "service.name": "gator-ui" };

    const payload = otlp([
      record({ resource: parent }),
      record({ resource: child }),
      record({ resource: parent }),
    ]);

    expect(payload.resourceLogs).toHaveLength(2);
    const counts = payload.resourceLogs.map((rl: any) => rl.scopeLogs[0].logRecords.length);
    expect(counts.sort()).toEqual([1, 2]);
  });

  it("hoists the resource out of the records that carry it", () => {
    const payload = otlp([record()]);

    expect(payload.resourceLogs[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "svc" } },
    ]);
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords[0].resource).toBeUndefined();
  });

  it("encodes integers as strings and floats as doubles, per OTLP/JSON", () => {
    const attributes = { count: 42, ratio: 0.5, ok: true, name: "x" };

    const byKey = attrs(record({ attributes }));

    expect(byKey.count).toEqual({ intValue: "42" });
    expect(byKey.ratio).toEqual({ doubleValue: 0.5 });
    expect(byKey.ok).toEqual({ boolValue: true });
    expect(byKey.name).toEqual({ stringValue: "x" });
  });

  it("encodes a bigint rather than letting JSON.stringify throw on it", () => {
    // Past exact double range, so the digits also prove it never went through Number.
    const attributes = { big: 9007199254740993n };

    expect(attrs(record({ attributes })).big).toEqual({ intValue: "9007199254740993" });
  });

  it("omits null and undefined attributes rather than emitting an empty value", () => {
    const attributes = { a: null, b: undefined, c: 1 };

    expect(attrKeys(record({ attributes }))).toEqual(["c"]);
  });

  it("omits a symbol or a function, exactly as JSON.stringify drops them", () => {
    const attributes = { sym: Symbol("side"), fn: () => "buy", kept: "yes" };

    expect(attrKeys(record({ attributes }))).toEqual(["kept"]);
  });

  it("encodes nested objects and arrays rather than stringifying them", () => {
    const attributes = { tags: ["a", null, "b"], leg: { side: "BUY", qty: 100 } };
    const kept = [{ stringValue: "a" }, { stringValue: "b" }];

    const byKey = attrs(record({ attributes }));

    // Null is dropped inside an array too: OTLP has no field for it.
    expect(byKey.tags).toEqual({ arrayValue: { values: kept } });
    expect(byKey.leg.kvlistValue.values).toContainEqual({
      key: "side",
      value: { stringValue: "BUY" },
    });
  });

  it("falls back to observedTime equal to time when nothing set it", () => {
    // Only a forwarded record differs. Some collectors reject an empty field.
    const local = only(record());

    expect(local.observedTimeUnixNano).toBe(local.timeUnixNano);
  });

  it("keeps an observed time that differs, because that gap is the forwarding lag", () => {
    const forwarded = only(record({ observedTimeUnixNano: "1755543600456000000" }));

    expect(forwarded.timeUnixNano).toBe("1755543600123000000");
    expect(forwarded.observedTimeUnixNano).toBe("1755543600456000000");
  });
});

describe("ecsSerializer", () => {
  it("emits newline-delimited JSON, one document per record", () => {
    const out = ecsSerializer.serialize([record(), record({ body: "second" })]);

    expect(out.contentType).toBe("application/x-ndjson");
    const lines = out.body.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).message).toBe("second");
  });

  it("converts the OTLP nanosecond string into an ISO timestamp", () => {
    expect(ecs(record())["@timestamp"]).toBe(new Date(1755543600123).toISOString());
  });

  it("lowercases the level, because that is what ECS expects", () => {
    expect(ecs(record({ severityText: "ERROR" })).log.level).toBe("error");
  });

  it("renames the resource into ECS fields and still keeps everything in labels", () => {
    const resource = {
      "service.name": "svc",
      "service.version": "1.4.0",
      "deployment.environment": "uat",
      "browser.user_agent": "test-agent",
    };

    const doc = ecs(record({ resource }));

    expect(doc.service).toEqual({ name: "svc", version: "1.4.0", environment: "uat" });
    expect(doc.user_agent.original).toBe("test-agent");
    // A field with no ECS name stays searchable under the name it arrived with.
    expect(doc.labels["service.name"]).toBe("svc");
    expect(doc.labels["log.type"]).toBe("event");
  });

  it("prefers the request URL over the page URL", () => {
    const both = { "url.full": "https://api/orders", "page.url": "https://app/" };
    const pageOnly = { "page.url": "https://app/" };

    expect(ecs(record({ attributes: both })).url.full).toBe("https://api/orders");
    expect(ecs(record({ attributes: pageOnly })).url.full).toBe("https://app/");
  });
});

describe("splitBatch", () => {
  const batchOf = (count: number): LogBatch => ({
    id: "original",
    createdAt: 1000,
    attempts: 2,
    records: Array.from({ length: count }, () => record()),
  });

  it("halves a batch and gives each half a new id", () => {
    const halves = splitBatch(batchOf(5));
    expect(halves).not.toBeNull();
    const [first, second] = halves!;

    expect(first.records).toHaveLength(2);
    expect(second.records).toHaveLength(3);
    // Fresh ids: reusing "original" makes the server drop the second half as a duplicate.
    expect(first.id).not.toBe("original");
    expect(second.id).not.toBe(first.id);
    // Age and attempts carry over: a split is not a second chance.
    expect(first.createdAt).toBe(1000);
    expect(first.attempts).toBe(2);
  });

  it("gives up on a single record, because splitting cannot help", () => {
    expect(splitBatch(batchOf(1))).toBeNull();
    expect(splitBatch(batchOf(0))).toBeNull();
  });
});

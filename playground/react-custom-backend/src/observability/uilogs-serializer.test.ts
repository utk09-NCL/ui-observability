import { describe, expect, it } from "vitest";
import type { LogRecord } from "@utk09/ui-observability";
import {
  MAX_ATTRIBUTE_KEYS,
  MAX_ATTRIBUTES_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_RECORDS,
} from "./uilogs-limits";
import { CUT_MARKER, cutMessage, uilogsSerializer } from "./uilogs-serializer";

const OCCURRED_AT_MS = 1763719200123;

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timeUnixNano: `${String(OCCURRED_AT_MS)}000000`,
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: 1,
    severityNumber: 9,
    severityText: "INFO",
    body: "ORDER_PLACED",
    attributes: {
      "app.namespace": "orders.ticket",
      "log.type": "action",
      "log.seq": 1,
      "journey.id": "journey-1",
      orderId: "ORD-1001",
    },
    resource: {
      "service.name": "react-custom-backend",
      "session.id": "session-1",
      "tab.id": "tab-1",
      "browser.user_agent": "test-agent",
    },
    ...overrides,
  };
}

interface Body {
  service: string;
  userAgent?: string;
  records: {
    ts: string;
    level: string;
    logger: string;
    message: string;
    type: string;
    sessionId?: string;
    tabId?: string;
    journeyId?: string;
    traceId: string;
    attributes: Record<string, unknown>;
  }[];
}

function serializeToBody(records: LogRecord[]): Body {
  return JSON.parse(uilogsSerializer.serialize(records).body) as Body;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe("uilogs serializer", () => {
  it("writes the uilogs shape", () => {
    const body = serializeToBody([makeRecord()]);

    expect(body.service).toBe("react-custom-backend");
    expect(body.userAgent).toBe("test-agent");
    expect(body.records).toEqual([
      {
        ts: new Date(OCCURRED_AT_MS).toISOString(),
        level: "INFO",
        logger: "orders.ticket",
        message: "ORDER_PLACED",
        type: "action",
        sessionId: "session-1",
        tabId: "tab-1",
        journeyId: "journey-1",
        traceId: "0af7651916cd43dd8448eb211c80319c",
        attributes: { "log.seq": 1, orderId: "ORD-1001" },
      },
    ]);
  });

  it("answers with the JSON content type", () => {
    expect(uilogsSerializer.serialize([makeRecord()]).contentType).toBe("application/json");
  });

  it("omits the journey and the user agent when the record has none", () => {
    const record = makeRecord({
      attributes: { "app.namespace": "orders.ticket", "log.type": "log" },
      resource: { "service.name": "react-custom-backend" },
    });
    const body = serializeToBody([record]);

    expect(body.userAgent).toBeUndefined();
    expect(body.records[0]?.journeyId).toBeUndefined();
    expect(body.records[0]?.sessionId).toBeUndefined();
  });

  it("cuts a message above the limit", () => {
    const body = serializeToBody([makeRecord({ body: "x".repeat(MAX_MESSAGE_CHARS + 500) })]);

    expect(body.records[0]?.message).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it("leaves attributes that fit as they are", () => {
    const body = serializeToBody([makeRecord()]);

    expect(body.records[0]?.attributes).not.toHaveProperty(CUT_MARKER);
  });

  it("cuts attributes above the key limit and marks the cut", () => {
    const attributes: Record<string, unknown> = { "app.namespace": "orders.ticket" };
    for (let index = 0; index < MAX_ATTRIBUTE_KEYS + 10; index += 1) {
      attributes[`key${String(index)}`] = index;
    }

    const cut = serializeToBody([makeRecord({ attributes })]).records[0]?.attributes ?? {};

    expect(Object.keys(cut)).toHaveLength(MAX_ATTRIBUTE_KEYS);
    expect(cut[CUT_MARKER]).toBe(11);
    expect(cut.key0).toBe(0);
  });

  it("cuts attributes above the byte limit and keeps the small ones", () => {
    const attributes = {
      "app.namespace": "orders.ticket",
      huge: "x".repeat(MAX_ATTRIBUTES_BYTES + 100),
      small: "kept",
    };

    const cut = serializeToBody([makeRecord({ attributes })]).records[0]?.attributes ?? {};

    expect(cut).toEqual({ small: "kept", [CUT_MARKER]: 1 });
    expect(jsonBytes(cut)).toBeLessThanOrEqual(MAX_ATTRIBUTES_BYTES);
  });

  it("counts bytes and not characters for the byte limit", () => {
    // Each of these characters is 3 bytes in UTF-8 and 1 character in a JavaScript string.
    const attributes = { wide: "€".repeat(MAX_ATTRIBUTES_BYTES / 3 - 100), more: "€".repeat(200) };

    const cut = serializeToBody([makeRecord({ attributes })]).records[0]?.attributes ?? {};

    expect(jsonBytes(cut)).toBeLessThanOrEqual(MAX_ATTRIBUTES_BYTES);
    expect(cut).toHaveProperty("wide");
    expect(cut[CUT_MARKER]).toBe(1);
  });

  it("keeps each record of a large batch, and the library splits it after a 413", () => {
    const records = Array.from({ length: MAX_RECORDS + 100 }, () => makeRecord());
    const body = serializeToBody(records);

    expect(body.records).toHaveLength(MAX_RECORDS + 100);
    expect(body).not.toHaveProperty("cutRecords");
  });

  it("cuts a message between two characters and not inside a surrogate pair", () => {
    // One letter and then pairs of two units each. The limit falls after the first half of a pair.
    const message = `a${"\u{1F600}".repeat(MAX_MESSAGE_CHARS)}`;
    const cut = cutMessage(message);

    expect(cut).toHaveLength(MAX_MESSAGE_CHARS - 1);
    expect(cut.endsWith("\u{1F600}")).toBe(true);
    expect(JSON.parse(JSON.stringify(cut))).toBe(cut);
  });

  it("cuts a message of the limit length at the limit when the last unit is whole", () => {
    expect(cutMessage("x".repeat(MAX_MESSAGE_CHARS + 1))).toHaveLength(MAX_MESSAGE_CHARS);
    expect(cutMessage("short")).toBe("short");
  });

  it("writes an empty batch without a throw", () => {
    expect(serializeToBody([])).toEqual({ service: "unknown-service", records: [] });
  });
});

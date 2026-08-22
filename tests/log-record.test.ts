import { describe, expect, it, vi } from "vitest";
import { LEVEL_ORDER, SEVERITY_NUMBER } from "../src/constants";
import { isLogRecord, type LogRecord, nowUnixNano } from "../src/models/log-record";

// Kept here rather than imported from src, on the same reasoning as the storage
// keys in the identity tests: a test that reads the table it is checking cannot
// catch a wrong number in that table.
const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
const OTEL_NUMBERS = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

const validRecord = (): LogRecord => ({
  timeUnixNano: "1755000000123000000",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "order submitted",
  attributes: { orderId: "A-1" },
  resource: { "service.name": "checkout" },
});

/** A record with one field replaced by something a hostile or stale realm might send. */
const withField = (key: string, value: unknown): unknown => ({
  ...validRecord(),
  [key]: value,
});

describe("nowUnixNano", () => {
  it("spells the millisecond clock as nanoseconds without losing a digit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_755_000_000_123));

    expect(nowUnixNano()).toBe("1755000000123000000");
  });

  it("produces a value already past the point where a Number stays exact", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_755_000_000_123));

    // Multiplying by 1e6 prints the right digits at millisecond resolution, so
    // this is not a claim that the arithmetic is broken today. It is a claim
    // that the value sits well outside the exactly-representable range and
    // only survives because milliseconds leave 13 significant digits. That is
    // a property of the clock, not of the format, and it is why the
    // concatenation is worth keeping: a finer clock adds significant digits
    // and the multiply then rounds with nothing to notice it by.
    expect(Number.isSafeInteger(Date.now() * 1e6)).toBe(false);

    // What genuinely does not survive a Number, and the reason this field is
    // spelled as a string at every hop rather than only on the wire.
    const fullPrecision = "1755000000123456789";
    expect(String(Number(fullPrecision))).not.toBe(fullPrecision);
  });

  it("returns a plain decimal string, never an exponent or a separator", () => {
    expect(nowUnixNano()).toMatch(/^\d+$/);
  });

  it("tracks the clock forward rather than caching its first answer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_755_000_000_000));
    const first = nowUnixNano();

    vi.advanceTimersByTime(5);

    expect(nowUnixNano()).not.toBe(first);
  });
});

describe("isLogRecord", () => {
  it("accepts a well-formed record", () => {
    expect(isLogRecord(validRecord())).toBe(true);
  });

  it("accepts a record with no observed timestamp, which the emitting context never sets", () => {
    const record = validRecord();
    expect(record.observedTimeUnixNano).toBeUndefined();
    expect(isLogRecord(record)).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not a record"],
    ["a number", 42],
    ["a boolean", true],
    ["a function", () => "no"],
    ["an array", []],
    ["an empty object", {}],
  ])("rejects %s", (_label, value) => {
    expect(isLogRecord(value)).toBe(false);
  });

  it.each([
    ["body is missing", withField("body", undefined)],
    ["body is not a string", withField("body", { text: "oops" })],
    ["severityText is missing", withField("severityText", undefined)],
    ["severityText is a number", withField("severityText", 9)],
    ["timeUnixNano is missing", withField("timeUnixNano", undefined)],
    // The realistic mistake is sending the timestamp as a number at all. At
    // nanosecond magnitude a Number has already stopped being exact, which is
    // the whole reason this field is spelled as a string.
    ["timeUnixNano is a number", withField("timeUnixNano", 1_755_000_000_123_000_000)],
    ["attributes is missing", withField("attributes", undefined)],
    ["attributes is null", withField("attributes", null)],
    ["attributes is a string", withField("attributes", "orderId=A-1")],
    ["resource is missing", withField("resource", undefined)],
    ["resource is null", withField("resource", null)],
    ["resource is a number", withField("resource", 1)],
  ])("rejects a record where %s", (_label, value) => {
    expect(isLogRecord(value)).toBe(false);
  });

  it("accepts a level it does not recognise, rather than dropping a record on a version skew", () => {
    // Deliberate looseness. A newer version of this library could add a level;
    // the record still carries its own severityNumber and still serializes, so
    // passing it through beats silently deleting real records.
    expect(isLogRecord(withField("severityText", "NOTICE"))).toBe(true);
  });

  it("narrows the type, so a caller can read the record without asserting", () => {
    const fromAnotherRealm: unknown = validRecord();

    expect(isLogRecord(fromAnotherRealm)).toBe(true);
    if (isLogRecord(fromAnotherRealm)) {
      // The point of the predicate: this line only compiles because the guard
      // narrowed `unknown` to LogRecord.
      expect(fromAnotherRealm.attributes.orderId).toBe("A-1");
    }
  });
});

describe("the severity tables", () => {
  it("uses the OpenTelemetry numbers rather than invented ones", () => {
    for (const level of LEVELS) {
      expect(SEVERITY_NUMBER[level]).toBe(OTEL_NUMBERS[level]);
    }
  });

  it("numbers every level, so no level can serialize as undefined", () => {
    expect(Object.keys(SEVERITY_NUMBER).sort()).toEqual([...LEVELS].sort());
  });

  it("increases with severity, which is what makes a minimum level a comparison", () => {
    const numbers = LEVELS.map((level) => SEVERITY_NUMBER[level]);
    const ascending = [...numbers].sort((a, b) => a - b);

    expect(numbers).toEqual(ascending);
    expect(new Set(numbers).size).toBe(LEVELS.length);
  });

  it("exposes one table under both names, so filtering and encoding cannot drift", () => {
    expect(LEVEL_ORDER).toBe(SEVERITY_NUMBER);
  });
});

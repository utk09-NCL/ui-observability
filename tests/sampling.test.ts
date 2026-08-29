import { describe, expect, it, vi } from "vitest";
import { ATTR_APP_NAMESPACE, ATTR_JOURNEY_ID, ATTR_LOG_TYPE } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { shouldSample } from "../src/core/sampling";
import type { ObservabilityConfig } from "../src/models/config";
import type { LogRecord } from "../src/models/log-record";

const config = (sampling: ObservabilityConfig["sampling"] = {}) =>
  resolveConfig(
    { endpoint: "https://x/v1/logs", serviceName: "svc", sampling },
    new Diagnostics(vi.fn(), 0),
  );

const record = (
  attributes: Record<string, unknown> = {},
  over: Partial<LogRecord> = {},
): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body: "hello",
  attributes: { [ATTR_LOG_TYPE]: "event", [ATTR_APP_NAMESPACE]: "app", ...attributes },
  resource: {},
  ...over,
});

/** Distinct 32 character trace ids, for the statistical assertions below. */
const traceId = (i: number) => String(i).padStart(32, "0");

describe("shouldSample bypasses", () => {
  it("keeps an ERROR at rate zero", () => {
    expect(shouldSample(record({}, { severityText: "ERROR" }), config({ defaultRate: 0 }))).toBe(
      true,
    );
  });

  it("keeps a FATAL at rate zero", () => {
    expect(shouldSample(record({}, { severityText: "FATAL" }), config({ defaultRate: 0 }))).toBe(
      true,
    );
  });

  it("keeps a type on alwaysSampleTypes at rate zero", () => {
    const kept = record({ [ATTR_LOG_TYPE]: "action" });
    expect(shouldSample(kept, config({ defaultRate: 0 }))).toBe(true);
  });

  it("drops an ordinary record at rate zero", () => {
    expect(shouldSample(record(), config({ defaultRate: 0 }))).toBe(false);
  });

  it("keeps an ordinary record at rate one", () => {
    expect(shouldSample(record(), config({ defaultRate: 1 }))).toBe(true);
  });
});

describe("shouldSample namespace rates", () => {
  it("lets the longest matching prefix win", () => {
    const rates = config({ defaultRate: 1, rates: { trading: 1, "trading.ticks": 0 } });

    expect(shouldSample(record({ [ATTR_APP_NAMESPACE]: "trading.ticks" }), rates)).toBe(false);
    expect(shouldSample(record({ [ATTR_APP_NAMESPACE]: "trading.orders" }), rates)).toBe(true);
  });

  it("keeps the longest prefix whichever order the rates are declared in", () => {
    const rates = config({ defaultRate: 1, rates: { "trading.ticks": 0, trading: 1 } });

    expect(shouldSample(record({ [ATTR_APP_NAMESPACE]: "trading.ticks" }), rates)).toBe(false);
  });

  it("matches a namespace exactly", () => {
    const rates = config({ defaultRate: 1, rates: { trading: 0 } });

    expect(shouldSample(record({ [ATTR_APP_NAMESPACE]: "trading" }), rates)).toBe(false);
  });

  it("matches only on a dot boundary, so tradingfloor is not trading", () => {
    const rates = config({ defaultRate: 1, rates: { trading: 0 } });

    expect(shouldSample(record({ [ATTR_APP_NAMESPACE]: "tradingfloor" }), rates)).toBe(true);
  });

  it("falls back to the default rate when no prefix matches", () => {
    const rates = config({ defaultRate: 0, rates: { other: 1 } });

    expect(shouldSample(record({ [ATTR_APP_NAMESPACE]: "app" }), rates)).toBe(false);
  });
});

describe("shouldSample keying", () => {
  it("decides the same way every time for one journey", () => {
    const half = config({ defaultRate: 0.5 });
    const one = record({ [ATTR_JOURNEY_ID]: "journey-1" });

    const answers = new Set(Array.from({ length: 20 }, () => shouldSample(one, half)));

    expect(answers.size).toBe(1);
  });

  it("splits journeys either side of the rate", () => {
    const half = config({ defaultRate: 0.5 });

    const answers = new Set(
      Array.from({ length: 200 }, (_unused, i) =>
        shouldSample(record({ [ATTR_JOURNEY_ID]: `journey-${String(i)}` }), half),
      ),
    );

    expect(answers).toEqual(new Set([true, false]));
  });

  it("keys on the journey rather than the trace, so one journey survives whole", () => {
    const half = config({ defaultRate: 0.5 });
    const attributes = { [ATTR_JOURNEY_ID]: "journey-1" };

    const first = shouldSample(record(attributes, { traceId: traceId(1) }), half);
    const second = shouldSample(record(attributes, { traceId: traceId(2) }), half);

    expect(first).toBe(second);
  });

  it("falls back to the trace when there is no journey", () => {
    const half = config({ defaultRate: 0.5 });

    const answers = new Set(
      Array.from({ length: 200 }, (_unused, i) =>
        shouldSample(record({}, { traceId: traceId(i) }), half),
      ),
    );

    expect(answers).toEqual(new Set([true, false]));
  });
});

describe("shouldSample on attributes it cannot read", () => {
  it("ignores a log.type that is not a string", () => {
    const typed = record({ [ATTR_LOG_TYPE]: 42 });

    expect(shouldSample(typed, config({ defaultRate: 0, alwaysSampleTypes: ["action"] }))).toBe(
      false,
    );
  });

  it("treats a namespace that is not a string as unnamespaced", () => {
    const rates = config({ defaultRate: 0, rates: { app: 1 } });

    expect(shouldSample(record({ [ATTR_APP_NAMESPACE]: 42 }), rates)).toBe(false);
  });
});

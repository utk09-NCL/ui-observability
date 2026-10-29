import { afterEach, describe, expect, it, vi } from "vitest";
import { METRIC_DEFAULT_BOUNDARIES, METRIC_MAX_SERIES } from "../src/constants";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { Meter } from "../src/core/meter";
import type { InstrumentDef } from "../src/models/metric";

const counterDef = (name = "orders"): InstrumentDef => ({
  name,
  kind: "counter",
  unit: "count",
  boundaries: [],
});

const histogramDef = (boundaries: readonly number[] = [10, 100]): InstrumentDef => ({
  name: "latency",
  kind: "histogram",
  unit: "ms",
  boundaries,
});

/**
 * Builds a meter with a 1000 ms interval. It collects the points and the diagnostic events.
 * @returns The meter, its points and its events.
 */
function setup() {
  const events: DiagnosticEvent[] = [];
  const points: { name: string; point: Record<string, unknown> }[] = [];
  const meter = new Meter(
    () => 1000,
    (name, point) => {
      points.push({ name, point });
    },
    new Diagnostics((event) => {
      events.push(event);
    }, 0),
  );
  return { meter, points, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Meter", () => {
  it("sums a counter into one point for each attribute set", () => {
    const { meter, points } = setup();

    meter.record(counterDef(), 1, { venue: "LSE" });
    meter.record(counterDef(), 2, { venue: "LSE" });
    meter.record(counterDef(), 5, { venue: "NYSE" });
    meter.collect();

    expect(points.map(({ point }) => [point.venue, point["metric.value"]])).toEqual([
      ["LSE", 3],
      ["NYSE", 5],
    ]);
    expect(points[0].point).toMatchObject({
      "metric.name": "orders",
      "metric.unit": "count",
      "metric.type": "counter",
      "metric.attribute_keys": ["venue"],
    });
  });

  it("shares one series between two calls with the same set in another key order", () => {
    const { meter, points } = setup();

    meter.record(counterDef(), 1, { a: "x", b: "y" });
    meter.record(counterDef(), 1, { b: "y", a: "x" });
    meter.collect();

    expect(points).toHaveLength(1);
    expect(points[0].point["metric.value"]).toBe(2);
  });

  it("counts histogram values in buckets with count, sum, min and max", () => {
    const { meter, points } = setup();

    for (const value of [5, 10, 50, 500]) {
      meter.record(histogramDef(), value);
    }
    meter.collect();

    // A value equal to a boundary goes into the bucket of that boundary.
    expect(points[0].point).toMatchObject({
      "metric.type": "histogram",
      "metric.count": 4,
      "metric.sum": 565,
      "metric.min": 5,
      "metric.max": 500,
      "metric.bounds": [10, 100],
      "metric.bucket_counts": [2, 1, 1],
    });
  });

  it.each([
    ["not ascending", [100, 10]],
    ["not a list", "10,100"],
    ["longer than 50", Array.from({ length: 51 }, (_unused, i) => i)],
    ["not numbers", ["10"]],
    ["not finite", [Number.NaN]],
  ])("uses the default boundaries for boundaries that are %s, and says so", (_case, bounds) => {
    const { meter, points, events } = setup();

    meter.record(histogramDef(bounds as never), 1);
    meter.collect();

    expect(points[0].point["metric.bounds"]).toEqual(METRIC_DEFAULT_BOUNDARIES);
    expect(events.map((event) => event.code)).toEqual(["config.invalid"]);
  });

  it("copies the boundaries, so a later change of the array of the app changes nothing", () => {
    const { meter, points } = setup();
    const boundaries = [10, 100];

    meter.record(histogramDef(boundaries), 1);
    boundaries[0] = 0;
    meter.collect();

    expect(points[0].point["metric.bounds"]).toEqual([10, 100]);
  });

  it("drops a value that is not finite, and a negative counter value", () => {
    const { meter, points, events } = setup();

    meter.record(counterDef(), Number.NaN);
    meter.record(counterDef(), -1);
    meter.record(histogramDef(), Infinity);
    meter.collect();

    expect(points).toEqual([]);
    expect(events.map((event) => event.code)).toEqual([
      "record.dropped_malformed",
      "record.dropped_malformed",
      "record.dropped_malformed",
    ]);
  });

  it("drops a value when the name is a counter and a histogram in one interval", () => {
    const { meter, points, events } = setup();

    meter.record(counterDef("latency"), 1);
    meter.record(histogramDef(), 1);
    meter.collect();

    expect(points).toHaveLength(1);
    expect(events[0].message).toContain("is a counter and a histogram");
  });

  it("keeps only string, finite number and boolean attributes", () => {
    const { meter, points } = setup();
    const attributes = { a: "x", b: 1, c: true, d: Number.NaN, e: { nested: 1 } };

    meter.record(counterDef(), 1, attributes as never);
    meter.collect();

    expect(points[0].point["metric.attribute_keys"]).toEqual(["a", "b", "c"]);
  });

  it("joins the attribute sets above the limit into one overflow set", () => {
    const { meter, points } = setup();

    for (let i = 0; i <= METRIC_MAX_SERIES + 1; i++) {
      meter.record(counterDef(), 1, { user: `u${String(i)}` });
    }
    meter.collect();

    expect(points).toHaveLength(METRIC_MAX_SERIES + 1);
    expect(points.at(-1)?.point).toMatchObject({
      "otel.metric.overflow": true,
      "metric.value": 2,
    });
  });

  it("reports attributes that throw, and does not throw into the call of the app", () => {
    const { meter, points, events } = setup();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );

    expect(() => {
      meter.record(counterDef(), 1, hostile);
    }).not.toThrow();
    meter.collect();

    expect(points).toEqual([]);
    expect(events.map((event) => event.code)).toEqual(["record.sanitize_failed"]);
  });

  it("sends the points of an interval when its timer fires, with the start of the interval", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { meter, points } = setup();

    meter.record(counterDef(), 1);
    vi.advanceTimersByTime(999);
    expect(points).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(points).toHaveLength(1);
    expect(points[0].point["metric.start_time_unix_nano"]).toBe("1000000000000");
  });

  it("starts a new interval after a collect, and arms no timer while idle", () => {
    vi.useFakeTimers();
    const { meter, points } = setup();

    meter.record(counterDef(), 1);
    meter.collect();
    meter.collect();
    expect(vi.getTimerCount()).toBe(0);

    meter.record(counterDef(), 4);
    vi.advanceTimersByTime(1000);

    expect(points.map(({ point }) => point["metric.value"])).toEqual([1, 4]);
  });
});

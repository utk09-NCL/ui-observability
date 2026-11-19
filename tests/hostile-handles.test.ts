// tests/hostile-handles.test.ts
//
// Tests that the functions which hand out a handle never throw into the app. A getter or a
// Proxy trap on an argument can throw. The library then falls back to a default and reports it.

import { afterEach, describe, expect, it } from "vitest";
import type { DiagnosticEvent } from "../src/core/diagnostics";
import {
  configure,
  counter,
  createMemoryTransport,
  flush,
  histogram,
  shutdown,
  startMeasure,
} from "../src/index";
import type { LogRecord } from "../src/models/log-record";
import type { HistogramOptions, InstrumentOptions } from "../src/models/metric";
import type { CapturePlugin, PluginContext } from "../src/models/plugin";

afterEach(async () => {
  await shutdown();
});

/** Options that throw on every read. */
const hostileOptions = (error: Error): HistogramOptions =>
  new Proxy<HistogramOptions>(
    {},
    {
      get() {
        throw error;
      },
    },
  );

/**
 * Starts a runtime with a memory transport.
 * @param plugins Capture plugins for the test.
 * @returns The transport and the diagnostic events.
 */
async function start(plugins: CapturePlugin[] = []) {
  const memory = createMemoryTransport();
  const events: DiagnosticEvent[] = [];
  configure({
    endpoint: null,
    serviceName: "svc",
    storage: { backend: "memory" },
    identity: "memory",
    bus: { mode: "off" },
    capture: { errors: false, rejections: false, plugins },
    diagnostics: { throttleMs: 0 },
    transport: memory.transport,
    onDiagnostic: (event) => {
      events.push(event);
    },
  });
  await flush();
  events.length = 0;

  return { memory, events };
}

/** Finds the metric record with a given name. */
const metricOf = (records: readonly LogRecord[], name: string): LogRecord | undefined =>
  records.find((record) => record.attributes["metric.name"] === name);

describe("handle functions with options that throw", () => {
  it("returns a counter with the default unit and reports the options", async () => {
    const error = new Error("hostile options");
    const { memory, events } = await start();

    const orders = counter("orders", hostileOptions(error));
    orders.add(2);
    await flush();

    expect(metricOf(memory.records(), "orders")?.attributes).toMatchObject({
      "metric.unit": "count",
      "metric.value": 2,
    });
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      [
        "config.invalid",
        "The library could not read the options of an instrument. The library uses the defaults.",
        error,
      ],
    ]);
  });

  it("returns a histogram with the default unit and default buckets, and reports the options", async () => {
    const error = new Error("hostile options");
    const { memory, events } = await start();

    const latency = histogram("latency", hostileOptions(error));
    latency.record(3);
    await flush();

    const record = metricOf(memory.records(), "latency");
    expect(record?.attributes).toMatchObject({ "metric.unit": "count", "metric.count": 1 });
    expect((record?.attributes["metric.bounds"] as number[]).length).toBeGreaterThan(1);
    expect(events.map(({ code, cause }) => [code, cause])).toEqual([["config.invalid", error]]);
  });

  it.each([
    ["null", null],
    ["a number", 5],
  ])("returns a counter and a histogram for options of %s", async (_label, options) => {
    await start();

    expect(() => {
      counter("a", options as unknown as InstrumentOptions).add(1);
      histogram("b", options as unknown as HistogramOptions).record(1);
    }).not.toThrow();
  });

  it("returns a counter without a report before configure()", () => {
    expect(() => counter("early", hostileOptions(new Error("hostile options")))).not.toThrow();
  });

  it("returns a plugin's counter and histogram when their options throw", async () => {
    const error = new Error("hostile options");
    let made = false;
    const plugin: CapturePlugin = {
      name: "hostile",
      install: (ctx: PluginContext) => {
        ctx.counter("plugin.count", hostileOptions(error)).add(1);
        ctx.histogram("plugin.time", hostileOptions(error)).record(1);
        made = true;
      },
      uninstall: () => undefined,
    };

    const { events } = await start([plugin]);
    await flush();

    expect(made).toBe(true);
    expect(events.filter(({ code }) => code === "capture.install_failed")).toEqual([]);
  });
});

describe("startMeasure with a name that throws", () => {
  it("returns a measure and reports the name", async () => {
    const error = new Error("hostile name");
    const { events } = await start();
    const name = {
      toString(): string {
        throw error;
      },
    };

    expect(() => {
      startMeasure(name as unknown as string).end();
    }).not.toThrow();

    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["record.sanitize_failed", "The library could not read the name of the measure.", error],
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, flush, getLogger } from "@utk09/ui-observability";
import { memory } from "../../test/observability";
import { readDiagnostics, readTap, resetTap, tapDiagnostic, tapProcessor } from "./tap";

beforeEach(() => {
  resetTap();
  // The console sink prints DEBUG records with console.debug. A spy keeps the spec output clean.
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  configure({ processors: [tapProcessor], minLevel: "INFO", consoleOutput: false });
});

afterEach(() => {
  resetTap();
});

describe("processor tap", () => {
  it("counts a record that is sent", async () => {
    getLogger("tap.spec").info("sent");
    await flush();

    expect(readTap().built).toBe(1);
    expect(memory.records().map((record) => record.body)).toEqual(["sent"]);
  });

  it("does not see a record that minLevel drops when nothing prints it", () => {
    getLogger("tap.spec").debug("dropped");

    expect(readTap().built).toBe(0);
  });

  it("sees a record that minLevel drops and the console prints, so it counts built records", async () => {
    configure({ consoleOutput: true });
    getLogger("tap.spec").debug("console only");
    await flush();

    expect(readTap().recent.map((record) => record.body)).toEqual(["console only"]);
    expect(memory.records()).toEqual([]);
  });

  it("sees a record that sampling drops, because a breadcrumb keeps its text", async () => {
    configure({ sampling: { rates: { "tap.sampled": 0 } } });
    getLogger("tap.sampled").info("sampled out");
    await flush();

    expect(readTap().built).toBe(1);
    expect(memory.records()).toEqual([]);
  });

  it("keeps only the last 50 records", () => {
    const log = getLogger("tap.spec");
    for (let index = 0; index < 60; index += 1) {
      log.info(`record ${String(index)}`);
    }

    const { built, recent } = readTap();

    expect(built).toBe(60);
    expect(recent).toHaveLength(50);
    expect(recent[0]?.body).toBe("record 10");
  });

  it("keeps a noisy namespace apart, so its records don't push the others out", () => {
    getLogger("tap.spec").info("ORDER_PLACED");
    const prices = getLogger("market.prices");
    for (let index = 0; index < 80; index += 1) {
      prices.info("price tick");
    }

    const { recent } = readTap();

    expect(recent.filter((record) => record.namespace === "market.prices")).toHaveLength(50);
    expect(recent.map((record) => record.body)).toContain("ORDER_PLACED");
  });

  it("returns the records oldest first", () => {
    getLogger("tap.spec").info("first");
    getLogger("market.prices").info("second");
    getLogger("tap.spec").info("third");

    expect(readTap().recent.map((record) => record.body)).toEqual(["first", "second", "third"]);
  });

  it("returns the record that it got, unchanged", () => {
    const record = {
      timeUnixNano: "1",
      traceId: "",
      spanId: "",
      traceFlags: 0,
      severityNumber: 9,
      severityText: "INFO" as const,
      body: "same",
      attributes: {},
      resource: {},
    };

    expect(tapProcessor(record)).toBe(record);
  });

  it("keeps the last 20 diagnostic reports", () => {
    for (let index = 0; index < 25; index += 1) {
      tapDiagnostic({
        code: "config.invalid",
        message: `report ${String(index)}`,
        at: 0,
        count: index,
      });
    }

    expect(readDiagnostics()).toHaveLength(20);
    expect(readDiagnostics()[0]?.message).toBe("report 5");
  });
});

// tests/remote-sampling.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_SAMPLING_MAX_CHARS,
  REMOTE_SAMPLING_MAX_RATES,
  REMOTE_SAMPLING_MAX_TTL_MS,
} from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { applyRemote, parseRemoteRules } from "../src/core/remote-rules";
import { RemoteSampling, type RemoteSlot } from "../src/core/remote-sampling";
import type { ObservabilityConfig } from "../src/models/config";

/**
 * Builds a diagnostics reporter with the throttle off, and its event list.
 * @returns The reporter and its events.
 */
function reporter() {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);

  return { diagnostics, events };
}

/**
 * Builds an overlay on a resolved config.
 * @param sampling Sampling options over remote on.
 * @returns The overlay and its config.
 */
function overlay(sampling: ObservabilityConfig["sampling"] = {}) {
  const config = resolveConfig(
    {
      endpoint: null,
      serviceName: "svc",
      minLevel: "INFO",
      sampling: { remote: true, ...sampling },
    },
    new Diagnostics(),
  );

  return { sut: new RemoteSampling(config), config };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseRemoteRules", () => {
  it("reads the header text", () => {
    const { diagnostics, events } = reporter();
    const text = JSON.stringify({
      v: 1,
      ttlMs: 600_000,
      defaultRate: 0.1,
      rates: { "blotter.grid": 1 },
      minLevel: "DEBUG",
    });

    expect(parseRemoteRules(text, diagnostics)).toEqual({
      ttlMs: 600_000,
      rules: { defaultRate: 0.1, rates: { "blotter.grid": 1 }, minLevel: "DEBUG" },
    });
    expect(events).toEqual([]);
  });

  it("reads a parsed object with only the mandatory fields", () => {
    const { diagnostics } = reporter();

    expect(parseRemoteRules({ v: 1, ttlMs: 1000 }, diagnostics)).toEqual({
      ttlMs: 1000,
      rules: { rates: {} },
    });
  });

  it("keeps each rate as the server sent it. Sampling applies remoteMaxRate", () => {
    const { diagnostics } = reporter();

    const update = parseRemoteRules(
      { v: 1, ttlMs: 1000, defaultRate: 1, rates: { a: 0.9 } },
      diagnostics,
    );

    expect(update?.rules).toEqual({ defaultRate: 1, rates: { a: 0.9 } });
  });

  it("keeps a __proto__ key as an own rate", () => {
    const { diagnostics } = reporter();

    const update = parseRemoteRules('{"v":1,"ttlMs":1000,"rates":{"__proto__":0.5}}', diagnostics);

    expect(Object.getPrototypeOf(update?.rules.rates)).toBe(Object.prototype);
    expect(Object.entries(update?.rules.rates ?? {})).toEqual([["__proto__", 0.5]]);
  });

  it.each([
    ["x".repeat(REMOTE_SAMPLING_MAX_CHARS + 1), "longer than 4096 characters"],
    ["{not json", "not valid JSON"],
    [[1], "must be an object"],
    [{ v: 2, ttlMs: 1000 }, "version must be 1"],
    [{ v: 1 }, "ttlMs must be a number"],
    [{ v: 1, ttlMs: 0 }, "ttlMs must be a number"],
    [{ v: 1, ttlMs: REMOTE_SAMPLING_MAX_TTL_MS + 1 }, "ttlMs must be a number"],
    [{ v: 1, ttlMs: Number.NaN }, "ttlMs must be a number"],
    [{ v: 1, ttlMs: 1000, defaultRate: 2 }, "defaultRate must be"],
    [{ v: 1, ttlMs: 1000, minLevel: "LOUD" }, "minLevel must be a level name"],
    [{ v: 1, ttlMs: 1000, minLevel: "toString" }, "minLevel must be a level name"],
    [{ v: 1, ttlMs: 1000, minLevel: 3 }, "minLevel must be a level name"],
    [{ v: 1, ttlMs: 1000, rates: [] }, "rates must be an object"],
    [{ v: 1, ttlMs: 1000, rates: { a: "1" } }, "rates must be an object"],
    [
      {
        v: 1,
        ttlMs: 1000,
        rates: Object.fromEntries(
          Array.from({ length: REMOTE_SAMPLING_MAX_RATES + 1 }, (_unused, i) => [
            `ns${String(i)}`,
            1,
          ]),
        ),
      },
      "rates must be an object",
    ],
  ])("rejects all the rules for %j", (raw, reason) => {
    const { diagnostics, events } = reporter();

    expect(parseRemoteRules(raw, diagnostics)).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe("config.invalid");
    expect(events[0]?.message).toContain(reason);
  });

  it("reports a value that throws while the library reads it", () => {
    const { diagnostics, events } = reporter();
    const hostile = {
      get v(): number {
        throw new Error("getter failed");
      },
    };

    expect(parseRemoteRules(hostile, diagnostics)).toBeNull();
    expect(events[0]?.message).toBe("The library ignores the sampling rules from the server.");
  });
});

describe("applyRemote", () => {
  it("makes the overlay for the first rules, and keeps it for the next rules", () => {
    const { config } = overlay();
    const slot: RemoteSlot = { sampling: null };

    applyRemote(slot, config, null);
    expect(slot.sampling).toBeNull();

    applyRemote(slot, config, { rules: { rates: { a: 1 } }, ttlMs: 60_000 });
    const first = slot.sampling;
    applyRemote(slot, config, { rules: { rates: { b: 1 } }, ttlMs: 60_000 });

    expect(slot.sampling).toBe(first);
    expect(slot.sampling?.current()).toEqual({ rates: { b: 1 } });
  });
});

describe("RemoteSampling", () => {
  it("has no rules before the first update", () => {
    const { sut } = overlay();

    expect(sut.current()).toBeNull();
    expect(sut.wire()).toBeNull();
    expect(sut.minLevel()).toBe("INFO");
  });

  it("keeps the rules for their TTL, and gives the remaining TTL to a forwarder", () => {
    vi.useFakeTimers();
    const { sut } = overlay();
    const rules = { rates: { grid: 1 } };

    sut.apply({ rules, ttlMs: 1000 });
    vi.advanceTimersByTime(400);

    expect(sut.current()).toBe(rules);
    expect(sut.wire()).toEqual({ v: 1, ttlMs: 600, rates: { grid: 1 } });

    vi.advanceTimersByTime(600);

    expect(sut.current()).toBeNull();
  });

  it("ends the rules when the clock moves back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { sut } = overlay();
    sut.apply({ rules: { rates: {} }, ttlMs: 60_000 });

    vi.setSystemTime(50_000);

    expect(sut.current()).toBeNull();
  });

  it("drops the rules while sampling.remote is off, and does not bring them back", () => {
    const { sut, config } = overlay();
    sut.apply({ rules: { rates: {} }, ttlMs: 60_000 });

    config.sampling.remote = false;
    expect(sut.current()).toBeNull();

    // An operator turns remote sampling off to stop incident rules.
    config.sampling.remote = true;
    expect(sut.current()).toBeNull();
  });

  it("ends the rules when the upstream has none", () => {
    const { sut } = overlay();
    sut.apply({ rules: { rates: {} }, ttlMs: 60_000 });

    sut.apply(null);

    expect(sut.current()).toBeNull();
  });

  it("lowers minLevel, and never raises it", () => {
    const { sut } = overlay();

    sut.apply({ rules: { rates: {}, minLevel: "DEBUG" }, ttlMs: 60_000 });
    expect(sut.minLevel()).toBe("DEBUG");

    sut.apply({ rules: { rates: {}, minLevel: "ERROR" }, ttlMs: 60_000 });
    expect(sut.minLevel()).toBe("INFO");
  });
});

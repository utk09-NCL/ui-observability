import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_CAPTURE_FLAGS } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { applyRemote, parseRemoteRules } from "../src/core/remote-rules";
import { RemoteSampling } from "../src/core/remote-sampling";
import { ObservabilityRuntime } from "../src/core/runtime";
import { configure, createMemoryTransport, flush, shutdown } from "../src/index";
import type { CaptureOptions } from "../src/models/config";
import { fakeVitals } from "./web-vitals-fakes";

afterEach(() => {
  vi.useRealTimers();
});

describe("Remote capture validation", () => {
  it("reads boolean capture switches in text and bus rules", () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const capture = Object.fromEntries(REMOTE_CAPTURE_FLAGS.map((key) => [key, true]));
    const update = parseRemoteRules(JSON.stringify({ v: 1, ttlMs: 1000, capture }), diagnostics);
    expect(update?.rules.capture).toEqual(capture);

    const config = resolveConfig(
      { endpoint: null, serviceName: "svc", sampling: { remote: true } },
      diagnostics,
    );
    const sampling = new RemoteSampling(config);
    sampling.apply(update);
    expect(parseRemoteRules(sampling.wire(), diagnostics)?.rules.capture).toEqual(capture);
  });

  it.each(
    [
      true,
      [],
      { fetch: "true" },
      { fullUrls: true },
      { interactions: { text: true } },
      { plugins: true },
      { urlTransform: true },
      { __proto__: null, constructor: true },
    ].map((capture) => ({ capture })),
  )("refuses invalid or private capture controls %j", ({ capture }) => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    expect(parseRemoteRules({ v: 1, ttlMs: 1000, capture }, diagnostics)).toBeNull();
    expect(diagnostics.snapshot()["config.invalid"]).toBe(1);
  });
});

describe("Remote captures in the runtime", () => {
  async function setup(capture: Partial<CaptureOptions> = {}) {
    configure({
      endpoint: null,
      serviceName: "svc",
      bus: { mode: "off" },
      sampling: { remote: true },
      capture: { errors: false, rejections: false, ...capture },
    });
    await flush();
    const runtime = ObservabilityRuntime.current()!;
    if (capture.fetch) {
      await vi.waitFor(() =>
        expect(runtime["captures"].map((item) => item.name)).toContain("network"),
      );
    }
    return { runtime, config: runtime.config };
  }

  it("changes only permitted switches and keeps the local config", async () => {
    const { runtime, config } = await setup({ remoteToggles: ["fetch"] });
    const before = globalThis.fetch;
    applyRemote(runtime["remote"], config, {
      ttlMs: 1000,
      rules: { rates: {}, capture: { fetch: true, xhr: true } },
    });
    await vi.waitFor(() => expect(globalThis.fetch).not.toBe(before));
    expect(config.capture.fetch).toBe(false);
    expect(runtime["effectiveCapture"]()).toMatchObject({ fetch: true, xhr: false });

    applyRemote(runtime["remote"], config, null);
    await vi.waitFor(() => expect(globalThis.fetch).toBe(before));
    expect(runtime["remoteCaptureTimer"]).toBeUndefined();
  });

  it("does not change captures with the default empty allowlist", async () => {
    const { runtime, config } = await setup();
    applyRemote(runtime["remote"], config, {
      ttlMs: 1000,
      rules: { rates: {}, capture: { fetch: true } },
    });
    expect(runtime["effectiveCapture"]().fetch).toBe(false);
    applyRemote(runtime["remote"], config, { ttlMs: 1000, rules: { rates: {} } });
    expect(runtime["effectiveCapture"]().fetch).toBe(false);
  });

  it("restores local settings when the TTL ends", async () => {
    const { runtime, config } = await setup({ fetch: true, remoteToggles: ["fetch"] });
    vi.useFakeTimers();
    const captured = globalThis.fetch;
    applyRemote(runtime["remote"], config, {
      ttlMs: 1000,
      rules: { rates: {}, capture: { fetch: false } },
    });
    await vi.waitFor(() => expect(globalThis.fetch).not.toBe(captured), { interval: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime["effectiveCapture"]().fetch).toBe(true);
    await vi.waitFor(() =>
      expect(runtime["captures"].map((item) => item.name)).toContain("network"),
    );
  });

  it("keeps the local options of a capture when a remote rule turns it on", async () => {
    const { runtime, config } = await setup({
      resourceTiming: { slowMs: 75 },
      interactions: { text: false },
      console: { levels: ["warn"] },
      longFrames: { thresholdMs: 50 },
      userTiming: { include: ["grid"] },
      remoteToggles: ["resourceTiming", "interactions", "console", "longFrames", "userTiming"],
    });
    applyRemote(runtime["remote"], config, {
      ttlMs: 1000,
      rules: {
        rates: {},
        capture: {
          resourceTiming: true,
          interactions: true,
          console: true,
          longFrames: true,
          userTiming: true,
        },
      },
    });
    expect(runtime["effectiveCapture"]()).toMatchObject({
      resourceTiming: { slowMs: 75 },
      interactions: { text: false },
      console: { levels: ["warn"] },
      longFrames: { thresholdMs: 50 },
      userTiming: { include: ["grid"] },
    });
  });

  it("turns off a capture with options when a remote rule turns it off", async () => {
    const { runtime, config } = await setup({
      longFrames: { thresholdMs: 50 },
      remoteToggles: ["longFrames"],
    });
    applyRemote(runtime["remote"], config, {
      ttlMs: 1000,
      rules: { rates: {}, capture: { longFrames: false } },
    });
    expect(runtime["effectiveCapture"]().longFrames).toBe(false);
  });

  it("applies allowlist changes and remote off at reconfigure", async () => {
    const { runtime, config } = await setup();
    applyRemote(runtime["remote"], config, {
      ttlMs: 1000,
      rules: { rates: {}, capture: { fetch: true } },
    });
    configure({ capture: { remoteToggles: ["fetch"] } });
    expect(runtime["effectiveCapture"]().fetch).toBe(true);
    configure({ sampling: { remote: false } });
    expect(runtime["effectiveCapture"]().fetch).toBe(false);
    expect(runtime["remoteCaptureTimer"]).toBeUndefined();
    configure({ sampling: { remote: true } });
    expect(runtime["effectiveCapture"]().fetch).toBe(false);
  });

  /**
   * Starts a runtime that lets a remote rule switch webVitals, with the fake web-vitals loaded.
   * @returns The runtime, the fake, a reader for the web_vitals records and a remote-rule helper.
   */
  async function startVitals() {
    const memory = createMemoryTransport();
    const fake = fakeVitals();
    configure({
      endpoint: null,
      serviceName: "svc",
      bus: { mode: "off" },
      transport: memory.transport,
      sampling: { remote: true },
      capture: {
        errors: false,
        rejections: false,
        remoteToggles: ["webVitals"],
        webVitals: { loader: fake.loader },
      },
    });
    await vi.waitFor(() => {
      expect(fake.subscriptions()).toBe(5);
    });
    const runtime = ObservabilityRuntime.current()!;

    return {
      fake,
      /** Waits until the capture list has, or has not, the web-vitals capture. */
      captured: async (on: boolean): Promise<void> => {
        await vi.waitFor(() => {
          const names = runtime["captures"].map((item) => item.name);
          expect(names.includes("web-vitals")).toBe(on);
        });
      },
      /** Applies a remote rule for the web-vitals switch, or ends the rule with null. */
      rule: (webVitals: boolean | null): void => {
        applyRemote(
          runtime["remote"],
          runtime.config,
          webVitals === null
            ? null
            : { ttlMs: 60_000, rules: { rates: {}, capture: { webVitals } } },
        );
      },
      /** Flushes, then lists the web_vitals records in the order they were sent. */
      sent: async (): Promise<string[]> => {
        await flush();
        const bodies = memory.records().map((record) => record.body);
        memory.clear();
        return bodies.filter((body) => body.startsWith("web_vitals."));
      },
    };
  }

  it("sends no web vital while a remote rule turns webVitals off", async () => {
    const { fake, captured, rule, sent } = await startVitals();
    fake.fire("cls", 0.1);
    expect(await sent()).toEqual(["web_vitals.cls"]);

    rule(false);
    await captured(false);
    // INP and CLS report late, at the page hide, so a report can come after the switch-off.
    fake.fire("cls", 0.3);

    expect(await sent()).toEqual([]);
  });

  it("sends one record per report after the remote rule ends, with one subscription", async () => {
    const { fake, captured, rule, sent } = await startVitals();
    rule(false);
    await captured(false);

    // The rule ends, and the local setting turns the capture on again.
    rule(null);
    await captured(true);
    fake.fire("cls", 0.4);

    // A second set of reporters would send the same metric twice.
    expect(await sent()).toEqual(["web_vitals.cls"]);
    expect(fake.subscriptions()).toBe(5);
  });

  it("clears the remote timer at shutdown", async () => {
    const { runtime, config } = await setup();
    applyRemote(runtime["remote"], config, {
      ttlMs: 60_000,
      rules: { rates: {}, capture: { fetch: true } },
    });
    const timer = runtime["remoteCaptureTimer"];
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await shutdown();
    expect(clear).toHaveBeenCalledWith(timer);

    applyRemote(runtime["remote"], config, {
      ttlMs: 60_000,
      rules: { rates: {}, capture: { fetch: true } },
    });
    expect(runtime["remoteCaptureTimer"]).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_CAPTURE_FLAGS } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { Diagnostics } from "../src/core/diagnostics";
import { applyRemote, parseRemoteRules } from "../src/core/remote-rules";
import { RemoteSampling } from "../src/core/remote-sampling";
import { ObservabilityRuntime } from "../src/core/runtime";
import { configure, flush, shutdown } from "../src/index";
import type { CaptureOptions } from "../src/models/config";

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

  it("keeps resource options when a remote rule enables the capture", async () => {
    const { runtime, config } = await setup({
      resourceTiming: { slowMs: 75 },
      interactions: { text: false },
      console: ["warn"],
      remoteToggles: ["resourceTiming", "interactions", "console"],
    });
    applyRemote(runtime["remote"], config, {
      ttlMs: 1000,
      rules: { rates: {}, capture: { resourceTiming: true, interactions: true, console: true } },
    });
    expect(runtime["effectiveCapture"]()).toMatchObject({
      resourceTiming: { slowMs: 75 },
      interactions: { text: false },
      console: ["warn"],
    });
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

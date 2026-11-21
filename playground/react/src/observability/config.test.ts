import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { setToken } from "../session/token";
import { authHeaders } from "./auth-headers";
import { tapDrop } from "../observability-settings/tap";
import { buildConfig, routing } from "./config";
import { saveConsent } from "./consent";

afterEach(() => {
  setToken(undefined);
  localStorage.clear();
});

describe("routing", () => {
  it("gives the anonymous context no headers function", () => {
    expect(routing(DEFAULT_SETTINGS, "anonymous").headers).toBeUndefined();
    expect(buildConfig(DEFAULT_SETTINGS, "anonymous").headers).toBeUndefined();
  });

  it("gives the user context the one headers function", () => {
    expect(routing(DEFAULT_SETTINGS, "user").headers).toBe(authHeaders);
    expect(routing(DEFAULT_SETTINGS, "user").headers).toBe(
      routing(DEFAULT_SETTINGS, "user").headers,
    );
  });

  it("builds absolute endpoints on the origin of the page, so the library reports no relative URL", () => {
    expect(routing(DEFAULT_SETTINGS, "user")).toMatchObject({
      endpoint: `${location.origin}/telemetry/v1/logs`,
      metricsEndpoint: `${location.origin}/telemetry/v1/metrics`,
      tracesEndpoint: `${location.origin}/telemetry/v1/traces`,
    });
  });

  it("leaves out the spans and the worker when the settings turn them off", () => {
    const config = routing({ ...DEFAULT_SETTINGS, spans: false }, "user");

    expect(config.tracesEndpoint).toBeNull();
    expect(config.transportWorker).toBeUndefined();
  });

  it("gives the worker factory when the settings turn it on", () => {
    const config = routing({ ...DEFAULT_SETTINGS, transportWorker: true }, "user");

    expect(config.transportWorker).toBeTypeOf("function");
  });
});

describe("buildConfig", () => {
  it("starts enabled for a user who gave no choice", () => {
    expect(buildConfig(DEFAULT_SETTINGS, "anonymous").enabled).toBe(true);
  });

  it("starts paused for a user who withdrew consent in an earlier visit", () => {
    saveConsent({ telemetry: false, replay: false });

    expect(buildConfig(DEFAULT_SETTINGS, "anonymous").enabled).toBe(false);
  });

  it("removes the console arguments in redact, because they can hold request headers", () => {
    const { redact } = buildConfig(DEFAULT_SETTINGS, "anonymous");
    const record = {
      attributes: { "console.args": ["Bearer secret"], keep: 1 },
    } as unknown as Parameters<NonNullable<typeof redact>>[0];

    expect(redact?.(record)?.attributes).toEqual({ keep: 1 });
  });
});

describe("replay config", () => {
  it("records only after the user agrees, and sends to the replay endpoint of the page", () => {
    const { replay } = buildConfig(DEFAULT_SETTINGS, "anonymous");

    expect(replay).toMatchObject({
      enabled: true,
      recordCanvas: false,
      requireConsent: true,
      endpoint: `${location.origin}/telemetry/v1/replay`,
    });
  });

  it("gives the same loader and headers function each time, because configure() compares references", () => {
    const first = buildConfig(DEFAULT_SETTINGS, "anonymous").replay;
    const second = buildConfig(DEFAULT_SETTINGS, "user").replay;

    expect(first?.loader).toBeTypeOf("function");
    expect(first?.loader).toBe(second?.loader);
    expect(first?.headers).toBe(authHeaders);
  });

  it("follows the replay rows of the settings", () => {
    const { replay } = buildConfig(
      { ...DEFAULT_SETTINGS, replayEnabled: false, recordCanvas: true },
      "anonymous",
    );

    expect(replay).toMatchObject({ enabled: false, recordCanvas: true, requireConsent: true });
  });

  it("reports the lost records to the tap", () => {
    expect(buildConfig(DEFAULT_SETTINGS, "anonymous").onDrop).toBe(tapDrop);
  });
});

describe("authHeaders", () => {
  it("sends no header before the login", () => {
    expect(authHeaders()).toEqual({});
  });

  it("reads the current token on each call", () => {
    setToken("first");
    expect(authHeaders()).toEqual({ Authorization: "Bearer first" });
    setToken("second");
    expect(authHeaders()).toEqual({ Authorization: "Bearer second" });
  });
});

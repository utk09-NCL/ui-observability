import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { setToken } from "../session/token";
import { authHeaders } from "./auth-headers";
import { buildConfig, routing } from "./config";

afterEach(() => {
  setToken(undefined);
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

  it("gives each routing setting to a rotation, so none goes back to its default", () => {
    const config = routing({ ...DEFAULT_SETTINGS, transportWorker: true }, "user");

    expect(config).toMatchObject({
      endpoint: "/uilogs",
      metricsEndpoint: "/telemetry/v1/metrics",
      tracesEndpoint: "/telemetry/v1/traces",
    });
    expect(config.transportWorker).toBeTypeOf("function");
  });

  it("leaves out the spans and the worker when the settings turn them off", () => {
    const config = routing({ ...DEFAULT_SETTINGS, spans: false }, "user");

    expect(config.tracesEndpoint).toBeNull();
    expect(config.transportWorker).toBeUndefined();
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

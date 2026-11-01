import { describe, expect, it } from "vitest";
import { TELEMETRY_SDK_VERSION } from "../src/constants";
import {
  addBreadcrumb,
  collectDebugBundle,
  configure,
  createMemoryTransport,
  getLogger,
} from "../src/index";
import type { ObservabilityConfig } from "../src/models/config";

/**
 * Configures a runtime with an endpoint that holds a token. The memory transport sends.
 * @param over Config values over the base.
 */
const start = (over: Partial<ObservabilityConfig> = {}): void => {
  configure({
    endpoint: "https://ingest.example/v1/logs?token=abc#part",
    transport: createMemoryTransport().transport,
    serviceName: "svc",
    storage: "memory",
    identity: "memory",
    bus: { mode: "off" },
    headers: { Authorization: "Bearer secret" },
    capture: { errors: false, rejections: false, ignoreUrls: [/health/] },
    ...over,
  });
};

describe("collectDebugBundle", () => {
  it("collects the state, the breadcrumbs and the debug buffer", async () => {
    start({ debugBuffer: { enabled: true } });
    addBreadcrumb("opened the blotter");
    getLogger("orders").debug("kept for the next error");

    const bundle = await collectDebugBundle();

    expect(bundle.sdkVersion).toBe(TELEMETRY_SDK_VERSION);
    expect(bundle.health).toMatchObject({ sdkVersion: TELEMETRY_SDK_VERSION, mode: "sender" });
    expect(bundle.diagnostics).toEqual(expect.any(Object));
    expect(bundle.resource["service.name"]).toBe("svc");
    expect(bundle.pageUrl).toBe(location.href.split(/[?#]/)[0]);
    expect(bundle.breadcrumbs).toMatchObject([
      { category: "custom", message: "opened the blotter" },
    ]);
    expect(bundle.debugBuffer.map((record) => record.body)).toEqual(["kept for the next error"]);
    expect(Date.parse(bundle.createdAt)).not.toBeNaN();
    // The bundle survives JSON without a change.
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });

  it("leaves out the headers, cuts each URL and names each function", async () => {
    start({ redact: (record) => record });

    const { config } = await collectDebugBundle();
    const capture = config.capture as Record<string, unknown>;

    expect(config).not.toHaveProperty("headers");
    expect(config.endpoint).toBe("https://ingest.example/v1/logs");
    expect(config.redact).toBe("[Function redact]");
    expect(config.transport).toEqual(expect.stringMatching(/^\[Function/));
    // The library adds the endpoint to ignoreUrls. The token must not show there.
    expect(capture.ignoreUrls).toEqual(["/health/", "https://ingest.example/v1/logs"]);
    expect(JSON.stringify(config)).not.toContain("token=abc");
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  it("gives no breadcrumbs and no resource when redact drops the bundle record", async () => {
    start({ redact: (record) => (record.body === "debug bundle" ? null : record) });
    addBreadcrumb("private step");

    const bundle = await collectDebugBundle();

    expect(bundle.breadcrumbs).toEqual([]);
    expect(bundle.resource).toEqual({});
    expect(bundle.pageUrl).toBe("");
  });
});

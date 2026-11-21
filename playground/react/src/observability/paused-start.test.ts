import { afterEach, describe, expect, it, vi } from "vitest";
import { configure, flush, getHealth, getLogger, shutdown } from "@utk09/ui-observability";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { saveConsent } from "./consent";
import { buildConfig } from "./config";
import { beginUserContext, setTelemetryConsent } from "./user-context";

const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 200 })),
);

afterEach(async () => {
  await shutdown();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("a page that starts after a withdrawal of consent", () => {
  it("logs in without an error, and stays paused", async () => {
    vi.stubGlobal("fetch", fetchMock);
    saveConsent({ telemetry: false, replay: false });
    await shutdown();
    configure(buildConfig(DEFAULT_SETTINGS, "anonymous"));

    await expect(beginUserContext("tenant-a", DEFAULT_SETTINGS)).resolves.toBeUndefined();
    getLogger("paused.spec").info("after the login");
    await flush();

    expect((await getHealth()).status).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts to send when the user agrees again", async () => {
    vi.stubGlobal("fetch", fetchMock);
    saveConsent({ telemetry: false, replay: false });
    await shutdown();
    configure({ ...buildConfig(DEFAULT_SETTINGS, "anonymous"), compression: "none" });
    await beginUserContext("tenant-a", DEFAULT_SETTINGS);

    await setTelemetryConsent(true, DEFAULT_SETTINGS);
    getLogger("paused.spec").info("after the grant");
    await flush();

    const bodies = fetchMock.mock.calls.map(([, init]) =>
      typeof init?.body === "string" ? init.body : "",
    );

    expect(bodies.some((body) => body.includes("after the grant"))).toBe(true);
  });
});

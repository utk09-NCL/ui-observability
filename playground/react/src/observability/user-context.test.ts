import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, flush, getHealth, getLogger, shutdown } from "@utk09/ui-observability";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { loadConsent } from "./consent";
import {
  beginUserContext,
  endUserContext,
  setTelemetryConsent,
  startAnonymous,
  stopForSharedDevice,
  switchTenantContext,
} from "./user-context";

const LOGS_URL = `${location.origin}/telemetry/v1/logs`;
const log = getLogger("user-context.spec");

// A rotation replaces the transport of the setup file with the HTTP sender, so the specs stub
// fetch and read what the sender posts.
const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 200 })),
);

function bodiesToLogs(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === LOGS_URL)
    .map(([, init]) => (typeof init?.body === "string" ? init.body : ""));
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  // The default gzip would turn the body into bytes. Compression is a runtime setting.
  configure({ compression: "none" });
});

afterEach(async () => {
  // The shutdown sends what is left, so it runs while fetch is still the stub. The hooks of this
  // file run before the hook of the setup file.
  await shutdown();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("setTelemetryConsent", () => {
  it("pauses the library on a withdrawal, and keeps the choice for the next page load", async () => {
    await setTelemetryConsent(false, DEFAULT_SETTINGS);

    expect((await getHealth()).status).toBe("disabled");
    expect(loadConsent().telemetry).toBe(false);
  });

  it("sends no record after a withdrawal", async () => {
    await setTelemetryConsent(false, DEFAULT_SETTINGS);
    log.info("after the withdrawal");
    await flush();

    expect(bodiesToLogs()).toEqual([]);
  });

  it("resumes delivery on a grant", async () => {
    await setTelemetryConsent(false, DEFAULT_SETTINGS);
    await setTelemetryConsent(true, DEFAULT_SETTINGS);
    log.info("after the grant");
    await flush();

    expect(loadConsent().telemetry).toBe(true);
    expect(bodiesToLogs().join("")).toContain("after the grant");
  });

  it("gives the tenant back to the records of a logged-in user after a grant", async () => {
    await beginUserContext("tenant-a", DEFAULT_SETTINGS);
    await setTelemetryConsent(false, DEFAULT_SETTINGS);
    await setTelemetryConsent(true, DEFAULT_SETTINGS);
    log.info("with the tenant");
    await flush();

    const body = bodiesToLogs().join("");

    expect(body).toContain("with the tenant");
    expect(body).toContain("tenant-a");
  });
});

describe("tenant switch", () => {
  it("puts the new tenant on the next records", async () => {
    await beginUserContext("tenant-a", DEFAULT_SETTINGS);
    await switchTenantContext("tenant-b", DEFAULT_SETTINGS);
    log.info("in the new tenant");
    await flush();

    const body = bodiesToLogs().join("");

    expect(body).toContain("in the new tenant");
    expect(body).toContain("tenant-b");
  });

  it("discards the unsent records of the old tenant", async () => {
    await beginUserContext("tenant-a", DEFAULT_SETTINGS);
    log.info("for the old tenant");
    await switchTenantContext("tenant-b", DEFAULT_SETTINGS);
    await flush();

    expect(bodiesToLogs().join("")).not.toContain("for the old tenant");
  });
});

describe("logout on a shared device", () => {
  it("stops the library, and a new anonymous runtime starts after it", async () => {
    await beginUserContext("tenant-a", DEFAULT_SETTINGS);
    await stopForSharedDevice();

    expect((await getHealth()).status).toBe("stopped");

    startAnonymous(DEFAULT_SETTINGS);

    expect((await getHealth()).status).not.toBe("stopped");
  });

  it("sends the unsent records of the user on a normal logout, and none on a shared device", async () => {
    await beginUserContext("tenant-a", DEFAULT_SETTINGS);
    log.info("before the normal logout");
    await endUserContext(DEFAULT_SETTINGS);
    await flush();

    expect(bodiesToLogs().join("")).toContain("before the normal logout");

    fetchMock.mockClear();
    await beginUserContext("tenant-a", DEFAULT_SETTINGS);
    log.info("before the shared logout");
    await stopForSharedDevice();
    startAnonymous(DEFAULT_SETTINGS);
    await flush();

    expect(bodiesToLogs().join("")).not.toContain("before the shared logout");
  });
});

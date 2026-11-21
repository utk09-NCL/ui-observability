import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, counter, flush, getHealth, getLogger, shutdown } from "@utk09/ui-observability";
import { memory } from "../../test/observability";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { setToken } from "../session/token";
import { getRuntimeGeneration } from "./runtime-generation";
import {
  beginUserContext,
  endUserContext,
  restartObservability,
  startAnonymous,
} from "./user-context";

describe("restart with shutdown() and configure()", () => {
  it("keeps a logger and a metric handle that the app made before it", async () => {
    const log = getLogger("restart.spec");
    const handle = counter("restart.count");
    log.info("before the restart");

    await shutdown();
    configure({
      serviceName: "react-workspace",
      transport: memory.transport,
      storage: { backend: "none" },
      bus: { mode: "off" },
      identity: "memory",
    });
    log.info("after the restart");
    handle.add(2);
    await flush();

    const records = memory.records();
    const point = records.find((record) => record.attributes["metric.name"] === "restart.count");

    expect(records.map((record) => record.body)).toContain("after the restart");
    expect(point?.attributes["metric.value"]).toBe(2);
  });

  it("reads the security context id after shutdown(), so a restart can keep it", async () => {
    // Isolation refuses a new id on a running library, so this spec starts a new runtime with it.
    await shutdown();
    configure({
      serviceName: "react-workspace",
      transport: memory.transport,
      storage: { backend: "none" },
      bus: { mode: "off" },
      identity: "memory",
      securityContext: { id: "ctx-restart-spec" },
    });
    await shutdown();

    expect((await getHealth()).securityContext.id).toBe("ctx-restart-spec");
  });
});

// The default gzip would turn each body into bytes, and the specs read the text.
const SETTINGS = { ...DEFAULT_SETTINGS, compression: "none" } as const;

describe("restartObservability()", () => {
  // A rotation replaces the transport of the setup file with the HTTP sender, so the specs
  // answer its requests and read what the sender posts.
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 200 })),
  );

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    // user-context.ts keeps the tenant in a module variable, so the next spec starts without it.
    await endUserContext(SETTINGS);
    // The shutdown sends what is left, so it runs while fetch is still the stub.
    await shutdown();
    vi.unstubAllGlobals();
    setToken(undefined);
  });

  function logsRequests(): { body: string; authorization: string | null }[] {
    return fetchMock.mock.calls
      .filter(([url]) => url.endsWith("/telemetry/v1/logs"))
      .map(([, init]) => ({
        body: typeof init?.body === "string" ? init.body : "",
        authorization: new Headers(init?.headers).get("Authorization"),
      }));
  }

  it("keeps the tenant and the token of the user in the new runtime", async () => {
    setToken("token-of-the-user");
    await beginUserContext("tenant-a", SETTINGS);

    await restartObservability(SETTINGS);
    getLogger("restart.spec").info("after the restart of the user");
    await flush();

    const sent = logsRequests().filter((request) =>
      request.body.includes("after the restart of the user"),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("tenant-a");
    expect(sent[0].authorization).toBe("Bearer token-of-the-user");
  });

  it("starts the anonymous config for a user who is not logged in, with no token", async () => {
    await restartObservability(SETTINGS);
    getLogger("restart.spec").info("after the anonymous restart");
    await flush();

    const sent = logsRequests().filter((request) =>
      request.body.includes("after the anonymous restart"),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].body).not.toContain("tenant-a");
    expect(sent[0].authorization).toBeNull();
  });

  it("goes up one generation for a restart and one for a new anonymous runtime", async () => {
    const before = getRuntimeGeneration();

    await restartObservability(SETTINGS);
    expect(getRuntimeGeneration()).toBe(before + 1);

    await shutdown();
    startAnonymous(SETTINGS);
    expect(getRuntimeGeneration()).toBe(before + 2);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "@utk09/ui-observability";
import { memory } from "../../test/observability";
import type { Api } from "../api/client";
import { login, logout, logoutSharedDevice, switchTenant } from "./session";
import { getToken, setToken } from "./token";

// The login and the logout call the library through user-context.ts. The spec replaces that
// module, because a rotation to the relative endpoints of the app would call a real server.
const { begin, end, restart, switchContext, stop, startAnon, order } = vi.hoisted(() => ({
  begin: vi.fn<() => Promise<void>>(),
  end: vi.fn<() => Promise<void>>(),
  restart: vi.fn<() => Promise<void>>(),
  switchContext: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  startAnon: vi.fn<() => void>(),
  /** The order of the steps of a shared-device logout, as the specs see it. */
  order: [] as string[],
}));

vi.mock("../observability/user-context", () => ({
  beginUserContext: begin,
  endUserContext: end,
  restartObservability: restart,
  switchTenantContext: switchContext,
  stopForSharedDevice: stop,
  startAnonymous: startAnon,
}));

const LOGIN_RESULT = { token: "token-1", user: "trader1", tenant: "tenant-a", expiresInMs: 1000 };

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    login: () => Promise.resolve(LOGIN_RESULT),
    logout: () => Promise.resolve(),
    logoutToken: () => Promise.resolve(),
    ...overrides,
  } as Api;
}

beforeEach(() => {
  setToken(undefined);
  begin.mockReset().mockResolvedValue();
  end.mockReset().mockResolvedValue();
  restart.mockReset().mockResolvedValue();
  switchContext.mockReset().mockResolvedValue();
  stop.mockReset().mockResolvedValue();
  startAnon.mockReset();
  order.length = 0;
});

describe("login", () => {
  it("returns the session with its token", async () => {
    const session = await login(makeApi(), "trader1", "tenant-a");

    expect(session).toEqual({ user: "trader1", tenant: "tenant-a", token: "token-1" });
    expect(getToken()).toBe("token-1");
    expect(restart).not.toHaveBeenCalled();
  });

  describe("when the rotation fails", () => {
    beforeEach(() => {
      begin.mockRejectedValue(new Error("rotation failed"));
    });

    it("revokes the session, clears the token and restarts the library", async () => {
      const logoutCall = vi.fn(() => Promise.resolve());

      // A restart through the queue would wait for the login that holds it, and the spec would hang.
      await expect(login(makeApi({ logout: logoutCall }), "trader1", "tenant-a")).rejects.toThrow(
        "rotation failed",
      );

      expect(logoutCall).toHaveBeenCalledTimes(1);
      expect(getToken()).toBeUndefined();
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("throws the error of the rotation when the restart fails too", async () => {
      restart.mockRejectedValue(new Error("restart failed"));

      await expect(login(makeApi(), "trader1", "tenant-a")).rejects.toThrow("rotation failed");
      expect(getToken()).toBeUndefined();
    });

    it("logs a failed revoke after the restart, and still throws the rotation error", async () => {
      const api = makeApi({ logout: () => Promise.reject(new Error("revoke failed")) });

      await expect(login(api, "trader1", "tenant-a")).rejects.toThrow("rotation failed");
      await flush();

      expect(restart).toHaveBeenCalledTimes(1);
      expect(
        memory
          .records()
          .some(
            (record) =>
              record.severityText === "WARN" && record.body.includes("revoke call after a failed"),
          ),
      ).toBe(true);
    });
  });
});

describe("logout", () => {
  it("does nothing when no token is set", async () => {
    const logoutCall = vi.fn(() => Promise.resolve());

    await logout(makeApi({ logout: logoutCall }));

    expect(end).not.toHaveBeenCalled();
    expect(logoutCall).not.toHaveBeenCalled();
  });

  it("revokes the token and clears it, also when the rotation fails", async () => {
    setToken("token-1");
    end.mockRejectedValue(new Error("rotation failed"));
    const logoutCall = vi.fn(() => Promise.resolve());

    await expect(logout(makeApi({ logout: logoutCall }))).rejects.toThrow("rotation failed");

    expect(logoutCall).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeUndefined();
  });
});

describe("switchTenant", () => {
  const SECOND = { token: "token-2", user: "trader1", tenant: "tenant-b", expiresInMs: 1000 };

  it("returns the session of the new tenant, and the library rotates after the new token is in place", async () => {
    setToken("token-1");
    let tokenAtRotation: string | undefined;
    switchContext.mockImplementation(() => {
      tokenAtRotation = getToken();

      return Promise.resolve();
    });

    const session = await switchTenant(
      makeApi({ login: () => Promise.resolve(SECOND) }),
      "trader1",
      "tenant-b",
    );

    expect(session).toEqual({ user: "trader1", tenant: "tenant-b", token: "token-2" });
    expect(tokenAtRotation).toBe("token-2");
    expect(getToken()).toBe("token-2");
    expect(switchContext).toHaveBeenCalledWith("tenant-b", expect.anything());
  });

  it("revokes the token of the old tenant, and not the new one", async () => {
    setToken("token-1");
    const revoked = vi.fn(() => Promise.resolve());
    const logoutCall = vi.fn(() => Promise.resolve());

    await switchTenant(
      makeApi({ login: () => Promise.resolve(SECOND), logoutToken: revoked, logout: logoutCall }),
      "trader1",
      "tenant-b",
    );

    expect(revoked).toHaveBeenCalledWith("token-1");
    expect(logoutCall).not.toHaveBeenCalled();
  });

  it("still returns the new session when the revoke of the old token fails", async () => {
    setToken("token-1");
    const api = makeApi({
      login: () => Promise.resolve(SECOND),
      logoutToken: () => Promise.reject(new Error("revoke failed")),
    });

    await expect(switchTenant(api, "trader1", "tenant-b")).resolves.toMatchObject({
      token: "token-2",
    });
    await flush();

    expect(
      memory.records().some((record) => record.body.includes("revoke call for the old tenant")),
    ).toBe(true);
  });

  it("revokes both sessions, clears the token and restarts the library when the rotation fails", async () => {
    setToken("token-1");
    switchContext.mockRejectedValue(new Error("rotation failed"));
    const revoked = vi.fn(() => Promise.resolve());
    const logoutCall = vi.fn(() => Promise.resolve());

    await expect(
      switchTenant(
        makeApi({ login: () => Promise.resolve(SECOND), logoutToken: revoked, logout: logoutCall }),
        "trader1",
        "tenant-b",
      ),
    ).rejects.toThrow("rotation failed");

    expect(logoutCall).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith("token-1");
    expect(getToken()).toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe("logoutSharedDevice", () => {
  it("stops the library, then revokes the token, then starts a new anonymous runtime", async () => {
    setToken("token-1");
    stop.mockImplementation(() => {
      order.push("stop");

      return Promise.resolve();
    });
    const api = makeApi({
      logout: () => {
        order.push(`revoke with ${getToken() ?? "no token"}`);

        return Promise.resolve();
      },
    });
    startAnon.mockImplementation(() => {
      order.push(`start with ${getToken() ?? "no token"}`);
    });

    await logoutSharedDevice(api);

    expect(order).toEqual(["stop", "revoke with token-1", "start with no token"]);
  });

  it("clears the token and starts the new runtime when the revoke fails", async () => {
    setToken("token-1");

    await expect(
      logoutSharedDevice(makeApi({ logout: () => Promise.reject(new Error("revoke failed")) })),
    ).rejects.toThrow("revoke failed");

    expect(getToken()).toBeUndefined();
    expect(startAnon).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no token is set", async () => {
    await logoutSharedDevice(makeApi());

    expect(stop).not.toHaveBeenCalled();
    expect(startAnon).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "@utk09/ui-observability";
import { memory } from "../../test/observability";
import type { Api } from "../api/client";
import { login, logout } from "./session";
import { getToken, setToken } from "./token";

// The login and the logout call the library through user-context.ts. The spec replaces that
// module, because a rotation to the relative endpoints of the app would call a real server.
const { begin, end, restart } = vi.hoisted(() => ({
  begin: vi.fn<() => Promise<void>>(),
  end: vi.fn<() => Promise<void>>(),
  restart: vi.fn<() => Promise<void>>(),
}));

vi.mock("../observability/user-context", () => ({
  beginUserContext: begin,
  endUserContext: end,
  restartObservability: restart,
}));

const LOGIN_RESULT = { token: "token-1", user: "trader1", tenant: "tenant-a", expiresInMs: 1000 };

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    login: () => Promise.resolve(LOGIN_RESULT),
    logout: () => Promise.resolve(),
    ...overrides,
  } as Api;
}

beforeEach(() => {
  setToken(undefined);
  begin.mockReset().mockResolvedValue();
  end.mockReset().mockResolvedValue();
  restart.mockReset().mockResolvedValue();
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

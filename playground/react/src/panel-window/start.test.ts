import { describe, expect, it, vi } from "vitest";
import type { Session } from "../session/session";
import { type StartSteps, startWindow } from "./start";

const SESSION = { user: "trader1", tenant: "tenant-a" } as unknown as Session;

function steps(overrides: Partial<StartSteps> = {}): StartSteps {
  return {
    ask: () => Promise.resolve({ user: "trader1", tenant: "tenant-a" }),
    login: () => Promise.resolve(SESSION),
    dropOpener: vi.fn(),
    revoke: vi.fn(),
    adopt: () => true,
    warn: vi.fn(),
    ...overrides,
  };
}

describe("startWindow", () => {
  it("revokes the session at pagehide while the login still runs", async () => {
    // The login sets the token first and then rotates the security context for up to 3 seconds.
    let finishLogin: (session: Session) => void = () => undefined;
    const revoke = vi.fn();
    const started = startWindow(
      null,
      steps({
        revoke,
        login: () =>
          new Promise<Session>((resolve) => {
            finishLogin = resolve;
          }),
      }),
    );
    await vi.waitFor(() => {
      expect(finishLogin).not.toBe(undefined);
    });

    dispatchEvent(new Event("pagehide"));
    finishLogin(SESSION);
    await started;

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("revokes the session at pagehide while the opener has not answered", () => {
    const revoke = vi.fn();
    void startWindow(null, steps({ revoke, ask: () => new Promise(() => undefined) }));

    dispatchEvent(new Event("pagehide"));

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("drops the link to the opener after the answer and before the login", async () => {
    const order: string[] = [];

    await startWindow(
      null,
      steps({
        ask: () => {
          order.push("ask");

          return Promise.resolve({ user: "trader1", tenant: "tenant-a" });
        },
        dropOpener: () => {
          order.push("dropOpener");
        },
        login: () => {
          order.push("login");

          return Promise.resolve(SESSION);
        },
      }),
    );

    expect(order).toEqual(["ask", "dropOpener", "login"]);
  });

  it("logs in with the user and the tenant that the opener gave", async () => {
    const login = vi.fn(() => Promise.resolve(SESSION));

    await startWindow(null, steps({ login }));

    expect(login).toHaveBeenCalledWith({ user: "trader1", tenant: "tenant-a" });
  });

  it("adopts the journey after the login", async () => {
    const order: string[] = [];

    await startWindow(
      "token-1",
      steps({
        login: () => {
          order.push("login");

          return Promise.resolve(SESSION);
        },
        adopt: (token) => {
          order.push(`adopt ${token}`);

          return true;
        },
      }),
    );

    expect(order).toEqual(["login", "adopt token-1"]);
  });

  it("warns when the library refuses the journey token", async () => {
    const warn = vi.fn();

    await startWindow("bad", steps({ adopt: () => false, warn }));

    expect(warn).toHaveBeenCalledWith("The window could not adopt the journey of its opener.");
  });

  it("adopts nothing when the address has no journey token", async () => {
    const adopt = vi.fn(() => true);

    await startWindow(null, steps({ adopt }));

    expect(adopt).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Session } from "../session/session";
import { createPanelWindow, type WindowSteps } from "./window-run";

const SESSION = { user: "trader1", tenant: "tenant-a" } as unknown as Session;
const WHO = { user: "trader1", tenant: "tenant-a" };

function steps(overrides: Partial<WindowSteps> = {}): WindowSteps {
  return {
    ask: () => Promise.resolve(WHO),
    dropOpener: vi.fn(),
    login: () => Promise.resolve(SESSION),
    revoke: vi.fn(),
    adopt: () => true,
    warn: vi.fn(),
    clearToken: vi.fn(),
    stopConsentWatch: vi.fn(),
    discard: () => Promise.resolve(),
    report: vi.fn(),
    ...overrides,
  };
}

/** A promise that the spec settles by hand, so it decides when a step finishes. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe("start", () => {
  it("revokes the session at pagehide while the login still runs", async () => {
    // The login sets the token first and then rotates the security context for up to 3 seconds.
    const login: { finish?: (session: Session) => void } = {};
    const revoke = vi.fn();
    const started = createPanelWindow(
      steps({
        revoke,
        login: () =>
          new Promise<Session>((resolve) => {
            login.finish = resolve;
          }),
      }),
    ).start(null);
    await vi.waitFor(() => {
      expect(login.finish).toBeDefined();
    });

    dispatchEvent(new Event("pagehide"));
    login.finish?.(SESSION);
    await started;

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("revokes the session at pagehide while the opener has not answered", () => {
    const revoke = vi.fn();
    void createPanelWindow(steps({ revoke, ask: () => new Promise(() => undefined) })).start(null);

    dispatchEvent(new Event("pagehide"));

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("drops the link to the opener after the answer and before the login", async () => {
    const order: string[] = [];

    await createPanelWindow(
      steps({
        ask: () => {
          order.push("ask");

          return Promise.resolve(WHO);
        },
        dropOpener: () => {
          order.push("dropOpener");
        },
        login: () => {
          order.push("login");

          return Promise.resolve(SESSION);
        },
      }),
    ).start(null);

    expect(order).toEqual(["ask", "dropOpener", "login"]);
  });

  it("logs in with the user and the tenant that the opener gave", async () => {
    const login = vi.fn(() => Promise.resolve(SESSION));

    await createPanelWindow(steps({ login })).start(null);

    expect(login).toHaveBeenCalledWith(WHO);
  });

  it("returns the session of the login", async () => {
    expect(await createPanelWindow(steps()).start(null)).toBe(SESSION);
  });

  it("adopts the journey after the login", async () => {
    const order: string[] = [];

    await createPanelWindow(
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
    ).start("token-1");

    expect(order).toEqual(["login", "adopt token-1"]);
  });

  it("warns when the library refuses the journey token", async () => {
    const warn = vi.fn();

    await createPanelWindow(steps({ adopt: () => false, warn })).start("bad");

    expect(warn).toHaveBeenCalledWith("The window could not adopt the journey of its opener.");
  });

  it("adopts nothing when the address has no journey token", async () => {
    const adopt = vi.fn(() => true);

    await createPanelWindow(steps({ adopt })).start(null);

    expect(adopt).not.toHaveBeenCalled();
  });
});

describe("end", () => {
  it("forgets the token, stops the consent listener and stops the library", async () => {
    const clearToken = vi.fn();
    const stopConsentWatch = vi.fn();
    const discard = vi.fn(() => Promise.resolve());
    const run = createPanelWindow(steps({ clearToken, stopConsentWatch, discard }));
    await run.start(null);

    run.end();

    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(stopConsentWatch).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("stops the pagehide listener, so a later hide revokes nothing", async () => {
    const revoke = vi.fn();
    const run = createPanelWindow(steps({ revoke }));
    await run.start(null);

    run.end();
    dispatchEvent(new Event("pagehide"));

    expect(revoke).not.toHaveBeenCalled();
  });

  it("runs once, also when the browser restores the page again", async () => {
    const discard = vi.fn(() => Promise.resolve());
    const run = createPanelWindow(steps({ discard }));
    await run.start(null);

    run.end();
    run.end();

    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("reports a stop of the library that fails, and throws nothing", async () => {
    const report = vi.fn();
    const failure = new Error("shutdown failed");
    const run = createPanelWindow(steps({ report, discard: () => Promise.reject(failure) }));
    await run.start(null);

    expect(() => {
      run.end();
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(report).toHaveBeenCalledWith(failure);
    });
  });

  it("refuses the login when the restore came while the opener had not answered", async () => {
    // A pagehide before the login revoked nothing, because no token was set. The restore then
    // lets the start go on, and a login would give a new token to a page that is gone.
    const answer = gate<{ user: string; tenant: string }>();
    const login = vi.fn(() => Promise.resolve(SESSION));
    const dropOpener = vi.fn();
    const run = createPanelWindow(steps({ ask: () => answer.promise, login, dropOpener }));
    const started = run.start("token-1");

    run.end();
    answer.resolve(WHO);

    expect(await started).toBeNull();
    expect(login).not.toHaveBeenCalled();
    expect(dropOpener).not.toHaveBeenCalled();
  });

  it("revokes and forgets a token that a login in progress sets after the restore", async () => {
    const loginGate = gate<Session>();
    const login = vi.fn(() => loginGate.promise);
    const clearToken = vi.fn();
    const revoke = vi.fn();
    const adopt = vi.fn(() => true);
    const run = createPanelWindow(steps({ login, clearToken, revoke, adopt }));
    const started = run.start("token-1");
    await vi.waitFor(() => {
      expect(login).toHaveBeenCalled();
    });

    run.end();
    expect(clearToken).toHaveBeenCalledTimes(1);
    loginGate.resolve(SESSION);

    expect(await started).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(clearToken).toHaveBeenCalledTimes(2);
    expect(adopt).not.toHaveBeenCalled();
  });
});

// tests/identity.test.ts
import { describe, expect, it, vi } from "vitest";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { newId, resolveIdentity, touchSession } from "../src/utils/identity";

const SESSION_KEY = "ui-observability.session";
const TAB_KEY = "ui-observability.tab";

function collect(): { events: DiagnosticEvent[]; diagnostics: Diagnostics } {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  return { events, diagnostics };
}

const codes = (events: DiagnosticEvent[]): string[] => events.map((event) => event.code);

/**
 * A Storage that throws on every access, which is what a sandboxed iframe
 * without allow-same-origin actually does. It does not return null.
 *
 * `clear` has to work, because the shared teardown calls it.
 */
const throwingStorage = {
  getItem(): string | null {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem(): void {
    throw new DOMException("blocked", "SecurityError");
  },
  clear(): void {
    // Nothing to clear, and the teardown must not itself throw.
  },
};

describe("newId", () => {
  it("uses crypto.randomUUID when it is available", () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("falls back to random bytes when randomUUID is absent", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab);
        return bytes;
      },
    });

    expect(newId()).toBe("ab".repeat(16));
  });

  it("falls back when a sandbox exposes randomUUID but throws on the call", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new DOMException("blocked", "NotSupportedError");
      },
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0x01);
        return bytes;
      },
    });

    expect(newId()).toBe("01".repeat(16));
  });

  it("falls back to Math.random when there is no usable crypto at all", () => {
    vi.stubGlobal("crypto", undefined);

    const id = newId();

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newId()).not.toBe(id);
  });

  it("still produces 32 hex characters when crypto exists but is empty", () => {
    vi.stubGlobal("crypto", {});

    expect(newId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("resolveIdentity", () => {
  it("mints a session, a tab and a context on a first visit, and persists the first two", () => {
    const { events, diagnostics } = collect();

    const identity = resolveIdentity(diagnostics);

    expect(identity.sessionId).toBeTruthy();
    expect(identity.tabId).toBeTruthy();
    expect(identity.contextId).toBeTruthy();
    expect(localStorage.getItem(SESSION_KEY)).toContain(identity.sessionId);
    expect(sessionStorage.getItem(TAB_KEY)).toBe(identity.tabId);
    expect(events).toEqual([]);
  });

  it("gives every context its own id while reusing the session and the tab", () => {
    const diagnostics = collect().diagnostics;

    const first = resolveIdentity(diagnostics);
    const second = resolveIdentity(diagnostics);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.tabId).toBe(first.tabId);
    expect(second.contextId).not.toBe(first.contextId);
  });

  it("starts a new session once the stored one has gone idle", () => {
    const diagnostics = collect().diagnostics;
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000;
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ id: "stale-session", lastSeenAt: thirtyOneMinutesAgo }),
    );

    expect(resolveIdentity(diagnostics).sessionId).not.toBe("stale-session");
  });

  it("keeps a session that was seen recently", () => {
    const diagnostics = collect().diagnostics;
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ id: "live-session", lastSeenAt: Date.now() - 1000 }),
    );

    expect(resolveIdentity(diagnostics).sessionId).toBe("live-session");
  });

  it("ignores a stored session that carries no id", () => {
    const diagnostics = collect().diagnostics;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ lastSeenAt: Date.now() }));

    expect(resolveIdentity(diagnostics).sessionId).toBeTruthy();
  });

  it("ignores a stored session with no timestamp, treating it as infinitely old", () => {
    const diagnostics = collect().diagnostics;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ id: "no-timestamp" }));

    expect(resolveIdentity(diagnostics).sessionId).not.toBe("no-timestamp");
  });

  it("reports and recovers when the stored session is not JSON", () => {
    const { events, diagnostics } = collect();
    localStorage.setItem(SESSION_KEY, "{not json");

    const identity = resolveIdentity(diagnostics);

    expect(identity.sessionId).toBeTruthy();
    expect(codes(events)).toContain("storage.degraded");
  });

  it("reuses a tab id that sessionStorage already holds", () => {
    const diagnostics = collect().diagnostics;
    sessionStorage.setItem(TAB_KEY, "existing-tab");

    expect(resolveIdentity(diagnostics).tabId).toBe("existing-tab");
  });

  it("survives storage that throws instead of returning null, and reports it", () => {
    const { events, diagnostics } = collect();
    vi.stubGlobal("localStorage", throwingStorage);
    vi.stubGlobal("sessionStorage", throwingStorage);

    const identity = resolveIdentity(diagnostics);

    // Still usable: nothing persisted, but the ids are real.
    expect(identity.sessionId).toBeTruthy();
    expect(identity.tabId).toBeTruthy();
    expect(codes(events)).toContain("storage.unavailable");
  });
});

describe("touchSession", () => {
  it("writes the first time it is called", () => {
    const diagnostics = collect().diagnostics;
    const setItem = vi.spyOn(localStorage, "setItem");

    touchSession("s-1", diagnostics);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SESSION_KEY)).toContain("s-1");
  });

  it("throttles to one write a minute, so the record path pays one integer compare", () => {
    const diagnostics = collect().diagnostics;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    const setItem = vi.spyOn(localStorage, "setItem");

    touchSession("s-1", diagnostics);
    vi.setSystemTime(new Date("2026-08-22T10:00:30.000Z"));
    touchSession("s-1", diagnostics);

    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("writes again once the throttle window has passed", () => {
    const diagnostics = collect().diagnostics;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    const setItem = vi.spyOn(localStorage, "setItem");

    touchSession("s-1", diagnostics);
    vi.setSystemTime(new Date("2026-08-22T10:02:00.000Z"));
    touchSession("s-1", diagnostics);

    expect(setItem).toHaveBeenCalledTimes(2);
  });
});

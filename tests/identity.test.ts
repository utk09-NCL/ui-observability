// tests/identity.test.ts
import { describe, expect, it, vi } from "vitest";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { memoryStores, newId, resolveIdentity, SessionTouch } from "../src/utils/identity";

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
 * A Storage that throws on every access. That is what a sandboxed iframe without allow-same-origin
 * does, rather than returning null.
 *
 * `clear` must work, because the shared teardown calls it.
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
  /** Diagnostics with the throttle off. */
  const quiet = (): Diagnostics => new Diagnostics(vi.fn(), 0);

  it("uses crypto.randomUUID when it is available", () => {
    expect(newId(quiet())).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("falls back to random bytes when randomUUID is absent", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab);
        return bytes;
      },
    });

    expect(newId(quiet())).toBe("ab".repeat(16));
  });

  it("falls back and counts the fault when a sandbox throws on randomUUID", () => {
    const diagnostics = quiet();
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new DOMException("blocked", "NotSupportedError");
      },
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0x01);
        return bytes;
      },
    });

    expect(newId(diagnostics)).toBe("01".repeat(16));
    expect(diagnostics.snapshot()["platform.api_blocked"]).toBe(1);
  });

  it("falls back to Math.random when there is no usable crypto at all", () => {
    vi.stubGlobal("crypto", undefined);

    const id = newId(quiet());

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newId(quiet())).not.toBe(id);
  });

  it("still produces 32 hex characters when crypto exists but is empty", () => {
    vi.stubGlobal("crypto", {});

    expect(newId(quiet())).toMatch(/^[0-9a-f]{32}$/);
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

    // Nothing persists, but the ids are still real.
    expect(identity.sessionId).toBeTruthy();
    expect(identity.tabId).toBeTruthy();
    expect(codes(events)).toContain("storage.unavailable");
  });
});

describe("resolveIdentity in a popup", () => {
  /**
   * Makes this window read like a popup. The opener is a same-origin window, and its
   * sessionStorage holds one tab id.
   * @param tabId The tab id in the opener's sessionStorage, or null for none.
   * @param closed Whether the opener has closed.
   * @returns The opener's getItem, to check what the code read.
   */
  const openerWithTab = (tabId: string | null, closed = false) => {
    const getItem = vi.fn((key: string) => (key === TAB_KEY ? tabId : null));
    vi.stubGlobal("opener", { closed, sessionStorage: { getItem } });
    return getItem;
  };

  it("makes a new tab id when its opener holds the same one, and stores it", () => {
    const diagnostics = collect().diagnostics;
    // window.open copies the opener's sessionStorage into the popup.
    sessionStorage.setItem(TAB_KEY, "copied-tab");
    openerWithTab("copied-tab");

    const identity = resolveIdentity(diagnostics);

    expect(identity.tabId).toBeTruthy();
    expect(identity.tabId).not.toBe("copied-tab");
    expect(sessionStorage.getItem(TAB_KEY)).toBe(identity.tabId);
  });

  it("keeps the popup's own tab id when it reloads", () => {
    const diagnostics = collect().diagnostics;
    sessionStorage.setItem(TAB_KEY, "copied-tab");
    openerWithTab("copied-tab");

    const first = resolveIdentity(diagnostics);
    const reloaded = resolveIdentity(diagnostics);

    expect(first.tabId).not.toBe("copied-tab");
    expect(reloaded.tabId).toBe(first.tabId);
  });

  it("keeps a stored tab id that differs from the opener's", () => {
    const diagnostics = collect().diagnostics;
    sessionStorage.setItem(TAB_KEY, "popup-tab");
    openerWithTab("opener-tab");

    const identity = resolveIdentity(diagnostics);

    expect(identity.tabId).toBe("popup-tab");
    expect(sessionStorage.getItem(TAB_KEY)).toBe("popup-tab");
  });

  it("keeps the stored tab id when the opener holds none", () => {
    const diagnostics = collect().diagnostics;
    sessionStorage.setItem(TAB_KEY, "popup-tab");
    openerWithTab(null);

    expect(resolveIdentity(diagnostics).tabId).toBe("popup-tab");
  });

  it("keeps the stored tab id when there is no opener", () => {
    const diagnostics = collect().diagnostics;
    sessionStorage.setItem(TAB_KEY, "own-tab");
    vi.stubGlobal("opener", null);

    expect(resolveIdentity(diagnostics).tabId).toBe("own-tab");
  });

  it("keeps the stored tab id when the opener has closed", () => {
    const diagnostics = collect().diagnostics;
    sessionStorage.setItem(TAB_KEY, "copied-tab");
    openerWithTab("copied-tab", true);

    expect(resolveIdentity(diagnostics).tabId).toBe("copied-tab");
  });

  it("keeps the stored tab id, without a throw, when a cross-origin opener blocks the read", () => {
    const diagnostics = collect().diagnostics;
    sessionStorage.setItem(TAB_KEY, "own-tab");
    // A cross-origin window answers `closed` and throws on its sessionStorage.
    vi.stubGlobal("opener", {
      closed: false,
      get sessionStorage(): never {
        throw new DOMException("blocked a frame", "SecurityError");
      },
    });

    expect(() => resolveIdentity(diagnostics)).not.toThrow();
    expect(resolveIdentity(diagnostics).tabId).toBe("own-tab");
    expect(sessionStorage.getItem(TAB_KEY)).toBe("own-tab");
  });

  it("checks no opener and writes no tab id to the browser with identity memory", () => {
    const diagnostics = collect().diagnostics;
    const getItem = openerWithTab("shared-tab");

    const identity = resolveIdentity(diagnostics, memoryStores());

    expect(identity.tabId).toBeTruthy();
    expect(getItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(TAB_KEY)).toBeNull();
  });
});

describe("SessionTouch", () => {
  it("writes the first time it is called", () => {
    const diagnostics = collect().diagnostics;
    const setItem = vi.spyOn(localStorage, "setItem");

    new SessionTouch(diagnostics).touch("s-1");

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SESSION_KEY)).toContain("s-1");
  });

  it("throttles to one write a minute, so the record path pays one integer compare", () => {
    const diagnostics = collect().diagnostics;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    const setItem = vi.spyOn(localStorage, "setItem");
    const touch = new SessionTouch(diagnostics);

    touch.touch("s-1");
    vi.setSystemTime(new Date("2026-08-22T10:00:30.000Z"));
    touch.touch("s-1");

    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("writes again once the throttle window has passed", () => {
    const diagnostics = collect().diagnostics;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    const setItem = vi.spyOn(localStorage, "setItem");
    const touch = new SessionTouch(diagnostics);

    touch.touch("s-1");
    vi.setSystemTime(new Date("2026-08-22T10:02:00.000Z"));
    touch.touch("s-1");

    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it("throttles per instance, so a second runtime in the document still writes", () => {
    const diagnostics = collect().diagnostics;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    const setItem = vi.spyOn(localStorage, "setItem");

    new SessionTouch(diagnostics).touch("s-1");
    new SessionTouch(diagnostics).touch("s-1");

    expect(setItem).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(SESSION_KEY)).toContain("s-1");
  });

  it("does not write an old id over a newer session of another tab", () => {
    // Tab A called newSession(). Tab B still runs with the old id.
    localStorage.setItem(SESSION_KEY, JSON.stringify({ id: "s-new", lastSeenAt: Date.now() }));

    new SessionTouch(collect().diagnostics).touch("s-old");

    expect(localStorage.getItem(SESSION_KEY)).toContain("s-new");
  });

  it("writes over a session of another tab that expired", () => {
    const expired = Date.now() - 31 * 60 * 1000;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ id: "s-gone", lastSeenAt: expired }));

    new SessionTouch(collect().diagnostics).touch("s-1");

    expect(localStorage.getItem(SESSION_KEY)).toContain("s-1");
  });
});

describe("memory identity stores", () => {
  it("mints a session and a tab, and writes no key to browser storage", () => {
    const { diagnostics } = collect();

    const identity = resolveIdentity(diagnostics, memoryStores());

    expect(identity.sessionId).not.toBe("");
    expect(identity.tabId).not.toBe("");
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(TAB_KEY)).toBeNull();
  });

  it("does not read the ids that browser storage holds", () => {
    const { diagnostics } = collect();
    sessionStorage.setItem(TAB_KEY, "stored-tab");

    const identity = resolveIdentity(diagnostics, memoryStores());

    expect(identity.tabId).not.toBe("stored-tab");
  });

  it("does not write the session to browser storage on a touch", () => {
    const { diagnostics } = collect();

    new SessionTouch(diagnostics, memoryStores()).touch("s-1");

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

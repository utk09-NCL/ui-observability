// src/utils/identity.ts
import type { Diagnostics } from "../core/diagnostics";

const SESSION_KEY = "ui-observability.session";
const TAB_KEY = "ui-observability.tab";
const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface Identity {
  sessionId: string;
  tabId: string;
  contextId: string;
}

export function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Some sandboxed contexts expose crypto but forbid randomUUID, and they
    // throw on the call rather than leaving the method absent.
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Storage access throws, it does not return null, in a sandboxed iframe without
 * allow-same-origin and in some webviews. Every access goes through here, so an
 * unguarded read cannot take the library down at import time.
 */
function safeRead(
  store: "local" | "session",
  key: string,
  diagnostics: Diagnostics,
): string | null {
  return (
    diagnostics.guard("storage.unavailable", `reading ${store}Storage`, () => {
      const s = store === "local" ? localStorage : sessionStorage;
      return s.getItem(key);
    }) ?? null
  );
}

function safeWrite(
  store: "local" | "session",
  key: string,
  value: string,
  diagnostics: Diagnostics,
): void {
  diagnostics.guard("storage.unavailable", `writing ${store}Storage`, () => {
    const s = store === "local" ? localStorage : sessionStorage;
    s.setItem(key, value);
  });
}

export function resolveIdentity(diagnostics: Diagnostics): Identity {
  const contextId = newId();
  const now = Date.now();

  // The session is shared by every tab on this origin and expires after an
  // idle period, so one visit is one session however many tabs it opens.
  let sessionId = newId();
  const rawSession = safeRead("local", SESSION_KEY, diagnostics);
  if (rawSession) {
    try {
      const parsed = JSON.parse(rawSession) as { id?: string; lastSeenAt?: number };
      if (parsed.id && now - (parsed.lastSeenAt ?? 0) < SESSION_IDLE_MS) {
        sessionId = parsed.id;
      }
    } catch {
      diagnostics.report("storage.degraded", "session record was not JSON, starting a new session");
    }
  }
  safeWrite("local", SESSION_KEY, JSON.stringify({ id: sessionId, lastSeenAt: now }), diagnostics);

  // The tab is one browser tab, one OpenFin window, or one OpenFin view.
  // Duplicating a tab copies sessionStorage, so two tabs can start out claiming
  // the same id. The control plane detects that collision and the newer context
  // regenerates; without it, two tabs look like one.
  let tabId = safeRead("session", TAB_KEY, diagnostics) ?? "";
  if (!tabId) {
    tabId = newId();
    safeWrite("session", TAB_KEY, tabId, diagnostics);
  }

  return { sessionId, tabId, contextId };
}

const SESSION_TOUCH_MS = 60_000;
let lastTouchAt = 0;

/**
 * Keep an active session alive.
 *
 * Called from the record path, because that is the only place that reliably
 * knows the user is still here, and throttled to one write a minute so the cost
 * on that path is a single integer compare.
 *
 * Without it the idle window is measured from the last time a realm booted: a
 * tab left open for 45 minutes, then a second tab opened beside it, produces two
 * session ids for one continuous visit.
 */
export function touchSession(sessionId: string, diagnostics: Diagnostics): void {
  const now = Date.now();
  if (now - lastTouchAt < SESSION_TOUCH_MS) {
    return;
  }
  lastTouchAt = now;
  safeWrite("local", SESSION_KEY, JSON.stringify({ id: sessionId, lastSeenAt: now }), diagnostics);
}

/** Test seam. Module-level throttle state has to be resettable between tests. */
export function resetSessionTouch(): void {
  lastTouchAt = 0;
}

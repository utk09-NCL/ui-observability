// src/utils/identity.ts
import {
  BYTE_VALUE_COUNT,
  ID_BYTE_LENGTH,
  SESSION_ID_KEY,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  TAB_ID_KEY,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";

/** The three ids every record carries, from widest scope to narrowest. */
export interface Identity {
  /** One visit to this origin, shared by every tab and expiring after an idle period. */
  sessionId: string;
  /** One browser tab, OpenFin window or OpenFin view, surviving a reload. */
  tabId: string;
  /** One realm, regenerated on every reload. Distinguishes two iframes of the same tab. */
  contextId: string;
}

/**
 * A random id, from the strongest source this context actually offers.
 *
 * Three sources in descending order, because the first two are absent or
 * blocked often enough to matter: an id is needed in sandboxes and insecure
 * contexts too, and there is nothing to fall back to after this.
 */
export function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Some sandboxed contexts expose crypto but forbid randomUUID, and they
    // throw on the call rather than leaving the method absent.
  }
  const bytes = new Uint8Array(ID_BYTE_LENGTH);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < ID_BYTE_LENGTH; i++) {
      bytes[i] = Math.floor(Math.random() * BYTE_VALUE_COUNT);
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

/** The write half of `safeRead`, and it throws in exactly the same places. */
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

/**
 * Establish this realm's three ids, restoring the session and the tab from
 * storage where they are still valid.
 *
 * Called once per realm at startup. Storage that is unreadable is not an error
 * here: it costs continuity, not logging, and every id falls back to a fresh
 * random one.
 */
export function resolveIdentity(diagnostics: Diagnostics): Identity {
  const contextId = newId();
  const now = Date.now();

  // The session is shared by every tab on this origin and expires after an
  // idle period, so one visit is one session however many tabs it opens.
  let sessionId = newId();
  const rawSession = safeRead("local", SESSION_ID_KEY, diagnostics);
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
  const session = JSON.stringify({ id: sessionId, lastSeenAt: now });
  safeWrite("local", SESSION_ID_KEY, session, diagnostics);

  // The tab is one browser tab, one OpenFin window, or one OpenFin view.
  // Duplicating a tab copies sessionStorage, so two tabs can start out claiming
  // the same id. The control plane detects that collision and the newer context
  // regenerates; without it, two tabs look like one.
  let tabId = safeRead("session", TAB_ID_KEY, diagnostics) ?? "";
  if (!tabId) {
    tabId = newId();
    safeWrite("session", TAB_ID_KEY, tabId, diagnostics);
  }

  return { sessionId, tabId, contextId };
}

/**
 * When the session's last-seen time was last written. Module state, so it is reset by
 * `resetSessionTouch`.
 */
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
  const session = JSON.stringify({ id: sessionId, lastSeenAt: now });
  safeWrite("local", SESSION_ID_KEY, session, diagnostics);
}

/** Test seam. Module-level throttle state has to be resettable between tests. */
export function resetSessionTouch(): void {
  lastTouchAt = 0;
}

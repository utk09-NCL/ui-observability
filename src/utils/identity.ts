// src/utils/identity.ts
//
// Generates and manages session, tab, and context correlation identifiers. Storage
// throws rather than returning null in a sandboxed iframe and in private mode. An
// unguarded read takes the library down at import.

import {
  BYTE_VALUE_COUNT,
  ID_BYTE_LENGTH,
  SESSION_ID_KEY,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  TAB_ID_KEY,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";

/** Correlation identifiers attached to log records across session, tab, and realm scopes. */
export interface Identity {
  /** Origin-wide user session identifier surviving across tabs until idle expiration. */
  sessionId: string;
  /** Browser tab or desktop window identifier surviving document reloads. */
  tabId: string;
  /** Unique execution realm identifier regenerated on every document load. */
  contextId: string;
}

/**
 * Generates a random lowercase hexadecimal string of the specified byte length.
 * Uses crypto.getRandomValues when available, falling back to Math.random.
 * @param byteLength Number of random bytes to generate.
 * @returns Hexadecimal string of length byteLength * 2.
 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = Math.floor(Math.random() * BYTE_VALUE_COUNT);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a unique identifier string using crypto.randomUUID or randomHex fallback.
 * @returns UUID or random hex identifier.
 */
export function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Catches sandbox SecurityError throws when crypto.randomUUID is blocked. The
    // method is present; only the call fails.
  }
  return randomHex(ID_BYTE_LENGTH);
}

/**
 * Reads a value from localStorage or sessionStorage with storage error guarding.
 * @param store Storage target ("local" or "session").
 * @param key Storage key.
 * @param diagnostics Diagnostics reporter.
 * @returns Stored string value or null if unreadable or absent.
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

/**
 * Writes a key-value pair to localStorage or sessionStorage with storage error guarding.
 * @param store Storage target ("local" or "session").
 * @param key Storage key.
 * @param value String value to store.
 * @param diagnostics Diagnostics reporter.
 */
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
 * Resolves or initializes session, tab, and context identifiers for the active realm.
 * @param diagnostics Diagnostics reporter.
 * @returns Populated Identity object.
 */
export function resolveIdentity(diagnostics: Diagnostics): Identity {
  const contextId = newId();
  const now = Date.now();

  let sessionId = newId();
  const rawSession = safeRead("local", SESSION_ID_KEY, diagnostics);
  if (rawSession) {
    try {
      const parsed = JSON.parse(rawSession) as {
        id?: string;
        lastSeenAt?: number;
      };
      if (parsed.id && now - (parsed.lastSeenAt ?? 0) < SESSION_IDLE_MS) {
        sessionId = parsed.id;
      }
    } catch {
      diagnostics.report("storage.degraded", "session record was not JSON, starting a new session");
    }
  }
  const session = JSON.stringify({ id: sessionId, lastSeenAt: now });
  safeWrite("local", SESSION_ID_KEY, session, diagnostics);

  let tabId = safeRead("session", TAB_ID_KEY, diagnostics) ?? "";
  if (!tabId) {
    tabId = newId();
    safeWrite("session", TAB_ID_KEY, tabId, diagnostics);
  }

  return { sessionId, tabId, contextId };
}

/** Timestamp of last recorded session touch in epoch milliseconds. */
let lastTouchAt = 0;

/**
 * Updates session activity timestamp in localStorage, throttled by SESSION_TOUCH_MS.
 * @param sessionId Active session identifier.
 * @param diagnostics Diagnostics reporter.
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

/** Resets the session touch throttle timer state for testing. */
export function resetSessionTouch(): void {
  lastTouchAt = 0;
}

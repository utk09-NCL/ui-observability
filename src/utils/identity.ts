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

/** The three Storage methods that identity and journey code use. */
export interface KeyValueStore {
  /**
   * Reads one value.
   * @param key Storage key.
   * @returns Stored value, or null.
   */
  getItem(key: string): string | null;
  /**
   * Writes one value.
   * @param key Storage key.
   * @param value Value to write.
   */
  setItem(key: string, value: string): void;
  /**
   * Removes one value.
   * @param key Storage key.
   */
  removeItem(key: string): void;
}

/** Stores for identity and journey keys. A getter can throw in a sandboxed frame. */
export interface IdentityStores {
  /** Store that lasts across tabs and reloads. */
  local(): KeyValueStore;
  /** Store that lasts for one tab. */
  session(): KeyValueStore;
}

/** Stores that write to the browser. The `identity: "storage"` option uses them. */
export const BROWSER_STORES: IdentityStores = {
  local: () => localStorage,
  session: () => sessionStorage,
};

/**
 * Creates stores that keep values in memory only. The `identity: "memory"` option uses them.
 * @returns Stores that write nothing to the browser.
 */
export function memoryStores(): IdentityStores {
  const wrap = (map: Map<string, string>): KeyValueStore => ({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  });

  const localStore = wrap(new Map());
  const sessionStore = wrap(new Map());

  return { local: () => localStore, session: () => sessionStore };
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
 * Reads a value from the local or session store. Reports a storage error to diagnostics.
 * @param stores Identity stores.
 * @param store Storage target ("local" or "session").
 * @param key Storage key.
 * @param diagnostics Diagnostics reporter.
 * @returns Stored string value or null if unreadable or absent.
 */
function safeRead(
  stores: IdentityStores,
  store: "local" | "session",
  key: string,
  diagnostics: Diagnostics,
): string | null {
  return (
    diagnostics.guard("storage.unavailable", `reading ${store}Storage`, () =>
      stores[store]().getItem(key),
    ) ?? null
  );
}

/**
 * Writes a key-value pair to the local or session store. Reports a storage error to diagnostics.
 * @param stores Identity stores.
 * @param store Storage target ("local" or "session").
 * @param key Storage key.
 * @param value String value to store.
 * @param diagnostics Diagnostics reporter.
 */
function safeWrite(
  stores: IdentityStores,
  store: "local" | "session",
  key: string,
  value: string,
  diagnostics: Diagnostics,
): void {
  diagnostics.guard("storage.unavailable", `writing ${store}Storage`, () => {
    stores[store]().setItem(key, value);
  });
}

/**
 * Resolves or initializes session, tab, and context identifiers for the active realm.
 * @param diagnostics Diagnostics reporter.
 * @param stores Identity stores.
 * @returns Populated Identity object.
 */
export function resolveIdentity(
  diagnostics: Diagnostics,
  stores: IdentityStores = BROWSER_STORES,
): Identity {
  const contextId = newId();
  const now = Date.now();

  let sessionId = newId();
  const rawSession = safeRead(stores, "local", SESSION_ID_KEY, diagnostics);
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
  safeWrite(stores, "local", SESSION_ID_KEY, session, diagnostics);

  let tabId = safeRead(stores, "session", TAB_ID_KEY, diagnostics) ?? "";
  if (!tabId) {
    tabId = newId();
    safeWrite(stores, "session", TAB_ID_KEY, tabId, diagnostics);
  }

  return { sessionId, tabId, contextId };
}

/**
 * Writes a new tab id to the session store.
 * @param tabId New tab identifier.
 * @param diagnostics Diagnostics reporter.
 * @param stores Identity stores.
 */
export function persistTabId(
  tabId: string,
  diagnostics: Diagnostics,
  stores: IdentityStores,
): void {
  safeWrite(stores, "session", TAB_ID_KEY, tabId, diagnostics);
}

/**
 * Writes the session's last-seen timestamp, throttled by `SESSION_TOUCH_MS`.
 * The throttle is instance state, not module state: two runtimes in one document
 * must not silence each other's session writes.
 */
export class SessionTouch {
  /** Epoch milliseconds of the last write this instance made. */
  private lastTouchAt = 0;

  /**
   * @param diagnostics Diagnostics reporter.
   * @param stores Identity stores.
   */
  constructor(
    private diagnostics: Diagnostics,
    private readonly stores: IdentityStores = BROWSER_STORES,
  ) {}

  /**
   * Writes the session activity time to the local store. It writes one time in each throttle window.
   * @param sessionId Active session identifier.
   */
  touch(sessionId: string): void {
    const now = Date.now();

    if (now - this.lastTouchAt < SESSION_TOUCH_MS) {
      return;
    }

    this.lastTouchAt = now;
    const session = JSON.stringify({ id: sessionId, lastSeenAt: now });
    safeWrite(this.stores, "local", SESSION_ID_KEY, session, this.diagnostics);
  }
}

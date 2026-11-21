// src/observability/consent.ts
//
// The privacy choices of the user, kept in localStorage. A withdrawal must survive a reload,
// because the next page load calls configure() before any component runs. The replay choice does
// too, because replay.requireConsent keeps the recorder off until startReplay() runs.

/** The key of the consent in localStorage. Another window of the app listens for it. */
export const CONSENT_STORAGE_KEY = "react-workspace.consent";

export interface Consent {
  /** False after the user withdrew consent. The library then builds no record. */
  telemetry: boolean;
  /** True after the user agreed to the session replay. */
  replay: boolean;
}

const DEFAULT_CONSENT: Consent = { telemetry: true, replay: false };

/**
 * Turns stored text into the choices. Bad JSON, a value that is not an object and a missing value
 * give the defaults. A field of the wrong type keeps its default.
 * @param text The stored text, or null when nothing is stored.
 * @returns The choices.
 */
export function parseConsent(text: string | null): Consent {
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    if (typeof value !== "object" || value === null) {
      return { ...DEFAULT_CONSENT };
    }

    const telemetry: unknown = Reflect.get(value, "telemetry");
    const replay: unknown = Reflect.get(value, "replay");

    return {
      telemetry: typeof telemetry === "boolean" ? telemetry : DEFAULT_CONSENT.telemetry,
      replay: typeof replay === "boolean" ? replay : DEFAULT_CONSENT.replay,
    };
  } catch {
    // Bad JSON. The defaults are the fallback.
    return { ...DEFAULT_CONSENT };
  }
}

/**
 * Reads the stored choices. A blocked store gives the defaults, because the page must start
 * without the store.
 * @returns The stored choices, or the defaults.
 */
export function loadConsent(): Consent {
  try {
    return parseConsent(localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    // A private window or blocked site data. The defaults are the fallback.
    return { ...DEFAULT_CONSENT };
  }
}

/**
 * Stores the choices. A failed write keeps the choice for this page only.
 * @param consent The choices to store.
 */
export function saveConsent(consent: Consent): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
  } catch {
    // The choice then lasts until the page closes. Nothing else depends on the store.
  }
}

/** Removes the stored choices, so the next user of a device starts from the defaults. */
export function resetConsent(): void {
  try {
    localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Nothing to remove when the store is blocked.
  }
}

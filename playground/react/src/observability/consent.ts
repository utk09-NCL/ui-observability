// src/observability/consent.ts
//
// The privacy choices of the user, kept in localStorage. A withdrawal must survive a reload,
// because the next page load calls configure() before any component runs. Replay is a stub in
// this stage. It has a switch so the "Privacy choices" dialog has its final shape.

const STORAGE_KEY = "react-workspace.consent";

export interface Consent {
  /** False after the user withdrew consent. The library then builds no record. */
  telemetry: boolean;
  /** Stub. Nothing records a replay yet, so the value only goes into the stored choice. */
  replay: boolean;
}

const DEFAULT_CONSENT: Consent = { telemetry: true, replay: false };

/**
 * Reads the stored choices. A blocked store or bad JSON gives the defaults, because the page
 * must start without the store.
 * @returns The stored choices, or the defaults.
 */
export function loadConsent(): Consent {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
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
    // A private window, blocked site data or bad JSON. The defaults are the fallback.
    return { ...DEFAULT_CONSENT };
  }
}

/**
 * Stores the choices. A failed write keeps the choice for this page only.
 * @param consent The choices to store.
 */
export function saveConsent(consent: Consent): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
  } catch {
    // The choice then lasts until the page closes. Nothing else depends on the store.
  }
}

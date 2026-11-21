// src/observability/consent-sync.ts
//
// Keeps the windows of the app in line on the privacy choices. The workspace writes the choices to
// localStorage, and the browser tells each other window of the same origin with a storage event.
// A window with a panel has its own runtime. Without this, it would keep sending after the user
// withdrew the consent in the workspace, because it read the choice one time, at its start.

import type { Settings } from "../observability-settings/settings";
import { type Consent, CONSENT_STORAGE_KEY, parseConsent } from "./consent";
import { setReplayConsent, setTelemetryConsent } from "./user-context";

/**
 * Reads the choices from a storage event.
 * @param event The key and the new value of the event.
 * @returns The new choices, or null when the event is about another key. A cleared storage
 * sends the key null, and the choices are the defaults then.
 */
export function consentFromStorageEvent(event: {
  key: string | null;
  newValue: string | null;
}): Consent | null {
  if (event.key !== null && event.key !== CONSENT_STORAGE_KEY) {
    return null;
  }

  return parseConsent(event.key === null ? null : event.newValue);
}

/**
 * Applies the difference between two sets of choices to the library of this window. The
 * telemetry comes first, because the replay starts only for a library that runs.
 * @param previous The choices that this window applied last.
 * @param next The new choices.
 * @param settings The settings in force.
 */
export async function applyConsentChange(
  previous: Consent,
  next: Consent,
  settings: Settings,
): Promise<void> {
  if (previous.telemetry !== next.telemetry) {
    await setTelemetryConsent(next.telemetry, settings);
  }
  if (previous.replay !== next.replay) {
    setReplayConsent(next.replay);
  }
}

export interface ConsentWatch {
  /** Returns the settings in force when a change arrives. */
  settings: () => Settings;
  /** Runs a task in the queue of the page, so it can't meet a login or a restart. */
  run: (task: () => Promise<void>) => Promise<unknown>;
}

/**
 * Listens for a change of the choices that another window stored.
 * @param watch The settings and the queue.
 * @returns Function that stops the listener.
 */
export function watchConsent(watch: ConsentWatch): () => void {
  let applied = parseConsent(localStorage.getItem(CONSENT_STORAGE_KEY));

  const onStorage = (event: StorageEvent): void => {
    const next = consentFromStorageEvent(event);
    if (next === null || (next.telemetry === applied.telemetry && next.replay === applied.replay)) {
      return;
    }

    const previous = applied;
    applied = next;
    void watch.run(() => applyConsentChange(previous, next, watch.settings()));
  };
  addEventListener("storage", onStorage);

  return () => {
    removeEventListener("storage", onStorage);
  };
}

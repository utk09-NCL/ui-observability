// src/observability/consent-sync.ts
//
// Keeps the windows of the app in line on the privacy choices. The workspace writes the choices to
// localStorage, and the browser tells each other window of the same origin with a storage event.
// A window with a panel has its own runtime. Without this, it would keep sending after the user
// withdrew the consent in the workspace, because it read the choice one time, at its start. A
// window only applies a choice. It never stores one, because the window that made the choice
// stored it, and a late write from here could put an older choice over a newer one.

import { getLogger } from "@utk09/ui-observability";
import type { Settings } from "../observability-settings/settings";
import { type Consent, CONSENT_STORAGE_KEY, loadConsent, parseConsent } from "./consent";
import { applyReplayConsent, applyTelemetryConsent } from "./user-context";

const log = getLogger("consent.sync");

/**
 * Reads the choices from a storage event.
 * @param event The key and the new value of the event.
 * @returns The new choices, or null when the event doesn't carry a choice. That is another key,
 * a removed key and a cleared storage. A shared-device logout removes the key, and a removed key
 * is no grant.
 */
export function consentFromStorageEvent(event: {
  key: string | null;
  newValue: string | null;
}): Consent | null {
  if (event.key !== CONSENT_STORAGE_KEY || event.newValue === null) {
    return null;
  }

  return parseConsent(event.newValue);
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
    await applyTelemetryConsent(next.telemetry, settings);
  }
  if (previous.replay !== next.replay) {
    applyReplayConsent(next.replay);
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
  // The choices that this window applied last. Only a task that ran in the queue changes it.
  let applied = loadConsent();

  const onStorage = (event: StorageEvent): void => {
    const next = consentFromStorageEvent(event);
    if (next === null) {
      return;
    }

    // The comparison runs in the queue and not here. Two events can arrive while the queue is
    // busy, and a withdrawal that a grant follows needs both runs.
    watch
      .run(async () => {
        if (next.telemetry === applied.telemetry && next.replay === applied.replay) {
          return;
        }

        await applyConsentChange(applied, next, watch.settings());
        applied = next;
      })
      .catch((error: unknown) => {
        // The choice stays unapplied, so the same choice at the next event runs again.
        log.error("The window could not apply the privacy choice of the workspace.", error);
      });
  };
  addEventListener("storage", onStorage);

  return () => {
    removeEventListener("storage", onStorage);
  };
}

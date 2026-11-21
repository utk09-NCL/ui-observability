// src/observability-settings/settings-store.ts
//
// The settings of the panel. "draft" is what the user picked, and the browser keeps it. "applied"
// is what the running library uses. They differ only for a setting that needs a restart.

import { useSyncExternalStore } from "react";
import { configure } from "@utk09/ui-observability";
import { configFor, HINTS, withFasterValues } from "./hints";
import { runExclusive } from "./operation-queue";
import { DEFAULT_SETTINGS, type SettingKey, type Settings } from "./settings";

const STORAGE_KEY = "react-workspace.settings";

export interface SettingsState {
  draft: Settings;
  applied: Settings;
}

/**
 * Keeps the values that a setting offers and falls back to the default for the rest, so a stored
 * value from an older version can't put a setting out of range.
 * @param raw The parsed stored value.
 * @returns Valid settings.
 */
function sanitize(raw: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== "object" || raw === null) {
    return settings;
  }

  for (const hint of HINTS) {
    const value: unknown = Reflect.get(raw, hint.key);
    if ((hint.options as readonly unknown[]).includes(value)) {
      Reflect.set(settings, hint.key, value);
    }
  }

  return settings;
}

/**
 * Reads the settings from localStorage. The page works without storage, so a blocked or broken
 * store gives the defaults.
 * @returns The stored settings, or the defaults.
 */
export function loadSettings(): Settings {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = text === null ? null : JSON.parse(text);

    return sanitize(parsed);
  } catch {
    // A private window, blocked site data or bad JSON. The defaults are the fallback.
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The choice then lasts until the page closes. Nothing else depends on the store.
  }
}

const loaded = loadSettings();
let state: SettingsState = { draft: loaded, applied: loaded };
const listeners = new Set<() => void>();

function publish(next: SettingsState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getSettingsState(): SettingsState {
  return state;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Reads the settings state in a component. */
export function useSettingsState(): SettingsState {
  return useSyncExternalStore(subscribeSettings, getSettingsState);
}

/**
 * Returns the settings that wait for a restart.
 * @param current The settings state.
 * @returns The keys of the settings that differ and need a restart.
 */
export function stagedKeys(current: SettingsState): SettingKey[] {
  return HINTS.filter(
    (hint) => hint.applies === "restart" && current.draft[hint.key] !== current.applied[hint.key],
  ).map((hint) => hint.key);
}

/**
 * Takes new settings. A setting that applies at runtime goes to configure() in one call, in the
 * queue, so it can't meet a rotation. A setting that needs a restart waits in the draft.
 * @param draft The settings to take.
 * @returns Promise that resolves when configure() ran.
 */
export function replaceDraft(draft: Settings): Promise<void> {
  saveSettings(draft);
  // The choice shows at once. The call to configure() waits for its turn.
  publish({ ...state, draft });

  return runExclusive(() => {
    // The applied settings are read when the task runs, after the tasks before it.
    const applied = { ...state.applied };
    let changed = false;
    for (const hint of HINTS) {
      if (hint.applies === "runtime" && draft[hint.key] !== applied[hint.key]) {
        Reflect.set(applied, hint.key, draft[hint.key]);
        changed = true;
      }
    }

    if (changed) {
      configure(configFor(applied, "runtime"));
    }
    publish({ draft: state.draft, applied });

    return Promise.resolve();
  });
}

export function changeSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  return replaceDraft({ ...state.draft, [key]: value });
}

export function resetSettings(): Promise<void> {
  return replaceDraft({ ...DEFAULT_SETTINGS });
}

export function applyFasterValues(): Promise<void> {
  return replaceDraft(withFasterValues(state.draft));
}

/**
 * Runs a restart with the draft, then marks the draft as applied. The restart runs in the queue.
 * @param restart Stops the library and starts it again with the given settings.
 */
export function applyStaged(restart: (settings: Settings) => Promise<void>): Promise<void> {
  return runExclusive(async () => {
    const { draft } = state;
    await restart(draft);
    publish({ draft: state.draft, applied: draft });
  });
}

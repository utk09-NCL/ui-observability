import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as library from "@utk09/ui-observability";
import type * as LibraryTypes from "@utk09/ui-observability";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { CONSENT_STORAGE_KEY, loadConsent, saveConsent, type Consent } from "./consent";
import { applyConsentChange, consentFromStorageEvent, watchConsent } from "./consent-sync";

// The replay needs a real recorder, and the specs only ask who calls startReplay() and
// stopReplay(). So the spec replaces these two functions and keeps the rest.
vi.mock("@utk09/ui-observability", async (original) => ({
  ...(await original<typeof LibraryTypes>()),
  startReplay: vi.fn(),
  stopReplay: vi.fn(),
}));

const ON: Consent = { telemetry: true, replay: false };

beforeEach(() => {
  vi.mocked(library.startReplay).mockClear();
  vi.mocked(library.stopReplay).mockClear();
  // A rotation switches the sender to HTTP, so the specs answer its requests.
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 200 })));
});

afterEach(async () => {
  await library.shutdown();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("consentFromStorageEvent", () => {
  it("reads the new value of the consent key", () => {
    const next = consentFromStorageEvent({
      key: CONSENT_STORAGE_KEY,
      newValue: JSON.stringify({ telemetry: false, replay: true }),
    });

    expect(next).toEqual({ telemetry: false, replay: true });
  });

  it("ignores the change of another key", () => {
    expect(consentFromStorageEvent({ key: "other", newValue: "{}" })).toBeNull();
  });

  it.each([[null], ["{not json"], ["7"]])(
    "gives the defaults for the value %j of the consent key, as loadConsent() does",
    (newValue) => {
      expect(consentFromStorageEvent({ key: CONSENT_STORAGE_KEY, newValue })).toEqual(ON);
    },
  );

  it("gives the defaults when the whole storage was cleared, which sends the key null", () => {
    expect(consentFromStorageEvent({ key: null, newValue: null })).toEqual(ON);
  });
});

describe("applyConsentChange", () => {
  it("pauses the library when the telemetry goes off in another window", async () => {
    await applyConsentChange(ON, { telemetry: false, replay: false }, DEFAULT_SETTINGS);

    expect((await library.getHealth()).status).toBe("disabled");
  });

  it("resumes the library when the telemetry goes on again", async () => {
    await applyConsentChange(ON, { telemetry: false, replay: false }, DEFAULT_SETTINGS);
    await applyConsentChange({ telemetry: false, replay: false }, ON, DEFAULT_SETTINGS);

    expect((await library.getHealth()).status).not.toBe("disabled");
  });

  it("starts and stops the replay when that choice changes", async () => {
    saveConsent({ telemetry: true, replay: true });
    await applyConsentChange(ON, { telemetry: true, replay: true }, DEFAULT_SETTINGS);
    expect(library.startReplay).toHaveBeenCalledTimes(1);

    await applyConsentChange({ telemetry: true, replay: true }, ON, DEFAULT_SETTINGS);
    expect(library.stopReplay).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a change that touches neither choice", async () => {
    await applyConsentChange(ON, ON, DEFAULT_SETTINGS);

    expect(library.startReplay).not.toHaveBeenCalled();
    expect(library.stopReplay).not.toHaveBeenCalled();
    expect((await library.getHealth()).status).not.toBe("disabled");
  });

  it("changes the telemetry first, so a replay that starts finds a library that runs", async () => {
    saveConsent({ telemetry: true, replay: true });
    await applyConsentChange(
      { telemetry: false, replay: false },
      { telemetry: true, replay: true },
      DEFAULT_SETTINGS,
    );

    expect(library.startReplay).toHaveBeenCalled();
    expect((await library.getHealth()).status).not.toBe("disabled");
  });
});

describe("watchConsent", () => {
  function storageEvent(newValue: string | null, key: string | null = CONSENT_STORAGE_KEY): void {
    dispatchEvent(new StorageEvent("storage", { key, newValue }));
  }

  it("applies a change that another window stored, in the queue", async () => {
    const queued: (() => Promise<void>)[] = [];
    const stop = watchConsent({
      settings: () => DEFAULT_SETTINGS,
      run: (task) => {
        queued.push(task);

        return Promise.resolve();
      },
    });

    storageEvent(JSON.stringify({ telemetry: false, replay: false }));
    expect(queued).toHaveLength(1);

    await queued[0]();
    expect((await library.getHealth()).status).toBe("disabled");
    stop();
  });

  it("compares a change with the last one that it applied, so each change runs once", async () => {
    const queued: (() => Promise<void>)[] = [];
    const stop = watchConsent({
      settings: () => DEFAULT_SETTINGS,
      run: (task) => {
        queued.push(task);

        return Promise.resolve();
      },
    });

    storageEvent(JSON.stringify({ telemetry: true, replay: true }));
    storageEvent(JSON.stringify({ telemetry: true, replay: false }));
    for (const task of queued) {
      await task();
    }

    expect(library.startReplay).toHaveBeenCalledTimes(1);
    expect(library.stopReplay).toHaveBeenCalledTimes(1);
    stop();
  });

  it("starts from the consent in storage, so an event with the same value runs nothing", () => {
    saveConsent({ telemetry: true, replay: true });
    const run = vi.fn(() => Promise.resolve());
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent(JSON.stringify({ telemetry: true, replay: true }));

    expect(run).not.toHaveBeenCalled();
    expect(loadConsent()).toEqual({ telemetry: true, replay: true });
    stop();
  });

  it("ignores the other keys, and listens no more after stop", () => {
    const run = vi.fn(() => Promise.resolve());
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent("{}", "react-workspace.theme");
    stop();
    storageEvent(JSON.stringify({ telemetry: false, replay: false }));

    expect(run).not.toHaveBeenCalled();
  });
});

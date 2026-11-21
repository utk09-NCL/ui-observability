import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as library from "@utk09/ui-observability";
import type * as LibraryTypes from "@utk09/ui-observability";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { CONSENT_STORAGE_KEY, loadConsent, saveConsent, type Consent } from "./consent";
import { memory } from "../../test/observability";
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

  it.each([["{not json"], ["7"]])(
    "gives the defaults for the value %j of the consent key, as loadConsent() does",
    (newValue) => {
      expect(consentFromStorageEvent({ key: CONSENT_STORAGE_KEY, newValue })).toEqual(ON);
    },
  );

  it("ignores a removed consent key, which a shared-device logout makes and is no grant", () => {
    expect(consentFromStorageEvent({ key: CONSENT_STORAGE_KEY, newValue: null })).toBeNull();
  });

  it("ignores a cleared storage, which sends the key null", () => {
    expect(consentFromStorageEvent({ key: null, newValue: null })).toBeNull();
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

  it("writes nothing to storage, because the window that made the change stored it", async () => {
    // A task can run long after its event, and a newer choice may be stored by then. A write
    // here would put the older choice over the newer one.
    saveConsent({ telemetry: true, replay: false });
    const stored = localStorage.getItem(CONSENT_STORAGE_KEY);

    await applyConsentChange(ON, { telemetry: false, replay: false }, DEFAULT_SETTINGS);
    await applyConsentChange(
      { telemetry: false, replay: false },
      { telemetry: false, replay: true },
      DEFAULT_SETTINGS,
    );

    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe(stored);
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
  /** Stores the value, as the other window did, and then sends the event that the browser sends. */
  function storageEvent(newValue: string | null, key: string | null = CONSENT_STORAGE_KEY): void {
    if (newValue !== null && key === CONSENT_STORAGE_KEY) {
      localStorage.setItem(key, newValue);
    }
    dispatchEvent(new StorageEvent("storage", { key, newValue }));
  }

  /** A queue that collects the tasks, so a spec decides when each one runs. */
  function collector(): {
    queued: (() => Promise<void>)[];
    run: (task: () => Promise<void>) => Promise<void>;
  } {
    const queued: (() => Promise<void>)[] = [];

    return {
      queued,
      run: (task) => {
        queued.push(task);

        return Promise.resolve();
      },
    };
  }

  it("applies a change that another window stored, in the queue", async () => {
    const { queued, run } = collector();
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent(JSON.stringify({ telemetry: false, replay: false }));
    expect(queued).toHaveLength(1);

    await queued[0]();
    expect((await library.getHealth()).status).toBe("disabled");
    stop();
  });

  it("compares a change with the last one that ran, so each change runs once", async () => {
    const { queued, run } = collector();
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent(JSON.stringify({ telemetry: true, replay: true }));
    await queued[0]();
    storageEvent(JSON.stringify({ telemetry: true, replay: true }));
    await queued[1]();
    storageEvent(JSON.stringify({ telemetry: true, replay: false }));
    await queued[2]();

    expect(library.startReplay).toHaveBeenCalledTimes(1);
    expect(library.stopReplay).toHaveBeenCalledTimes(1);
    stop();
  });

  it("starts no replay for a grant that a later withdrawal replaced in storage", async () => {
    // The task of the grant runs late. It reads the stored choice, which is the withdrawal.
    const { queued, run } = collector();
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent(JSON.stringify({ telemetry: true, replay: true }));
    storageEvent(JSON.stringify({ telemetry: true, replay: false }));
    for (const task of queued) {
      await task();
    }

    expect(library.startReplay).not.toHaveBeenCalled();
    stop();
  });

  it("applies a choice that comes back before the first change ran", async () => {
    // Two events in a row, withdraw and grant, while the queue is busy. The first task runs
    // later. A comparison at event time would see "no change" for the second event.
    const { queued, run } = collector();
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent(JSON.stringify({ telemetry: false, replay: false }));
    storageEvent(JSON.stringify({ telemetry: true, replay: false }));
    for (const task of queued) {
      await task();
    }

    expect((await library.getHealth()).status).not.toBe("disabled");
    stop();
  });

  it("starts from the stored consent, so an event with the same value runs nothing", async () => {
    saveConsent({ telemetry: true, replay: true });
    const { queued, run } = collector();
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent(JSON.stringify({ telemetry: true, replay: true }));
    for (const task of queued) {
      await task();
    }

    expect(library.startReplay).not.toHaveBeenCalled();
    expect(loadConsent()).toEqual({ telemetry: true, replay: true });
    stop();
  });

  it("starts with the defaults when the browser blocks the storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });

    expect(() => {
      watchConsent({ settings: () => DEFAULT_SETTINGS, run: () => Promise.resolve() })();
    }).not.toThrow();
  });

  it("reports a task that fails, and tries the same choice again at the next event", async () => {
    let fail = true;
    const stop = watchConsent({
      settings: () => {
        if (fail) {
          throw new Error("rotation failed");
        }

        return DEFAULT_SETTINGS;
      },
      run: (task) => task(),
    });

    storageEvent(JSON.stringify({ telemetry: false, replay: false }));
    await vi.waitFor(async () => {
      await library.flush();
      expect(
        memory
          .records()
          .some((record) => record.body.includes("could not apply the privacy choice")),
      ).toBe(true);
    });

    fail = false;
    storageEvent(JSON.stringify({ telemetry: false, replay: false }));
    await vi.waitFor(async () => {
      expect((await library.getHealth()).status).toBe("disabled");
    });
    stop();
  });

  it("ignores a removed key and the other keys, and listens no more after stop", () => {
    const { queued, run } = collector();
    const stop = watchConsent({ settings: () => DEFAULT_SETTINGS, run });

    storageEvent(null);
    storageEvent("{}", "react-workspace.theme");
    stop();
    storageEvent(JSON.stringify({ telemetry: false, replay: false }));

    expect(queued).toHaveLength(0);
  });
});

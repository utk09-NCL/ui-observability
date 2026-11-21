import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import {
  applyFasterValues,
  applyStaged,
  changeSetting,
  getSettingsState,
  loadSettings,
  resetSettings,
  stagedKeys,
} from "./settings-store";

const STORAGE_KEY = "react-workspace.settings";

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetSettings();
  localStorage.clear();
});

describe("settings store", () => {
  it("applies a runtime setting at once", async () => {
    await changeSetting("minLevel", "WARN");

    expect(getSettingsState().applied.minLevel).toBe("WARN");
    expect(stagedKeys(getSettingsState())).toEqual([]);
  });

  it("stages a setting that needs a restart", async () => {
    await changeSetting("maxDepth", 3);

    expect(getSettingsState().draft.maxDepth).toBe(3);
    expect(getSettingsState().applied.maxDepth).toBe(DEFAULT_SETTINGS.maxDepth);
    expect(stagedKeys(getSettingsState())).toEqual(["maxDepth"]);
  });

  it("applies the staged settings after the restart ran with them", async () => {
    await changeSetting("maxDepth", 3);
    const seen: number[] = [];

    await applyStaged((settings) => {
      seen.push(settings.maxDepth);

      return Promise.resolve();
    });

    expect(seen).toEqual([3]);
    expect(getSettingsState().applied.maxDepth).toBe(3);
    expect(stagedKeys(getSettingsState())).toEqual([]);
  });

  it("uses all faster values, and a setting without one stays", async () => {
    await applyFasterValues();
    const { draft } = getSettingsState();

    expect(draft.consoleOutput).toBe(false);
    expect(draft.minLevel).toBe("INFO");
    expect(draft.compression).toBe(DEFAULT_SETTINGS.compression);
  });

  it("resets to the defaults", async () => {
    await applyFasterValues();
    await resetSettings();

    expect(getSettingsState().draft).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the choice in localStorage", async () => {
    await changeSetting("minLevel", "WARN");

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
      minLevel: "WARN",
    });
  });

  it("falls back to the default for a stored value that is out of range", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ minLevel: "LOUD", maxDepth: 3, unknown: 1 }),
    );

    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, maxDepth: 3 });
  });

  it("falls back to the defaults when the stored text is not JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");

    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("works when the storage throws", async () => {
    // A spy on Storage.prototype does not reach the localStorage of happy-dom, so the spec
    // replaces the global. The counters prove that the store did call the throwing functions.
    const getItem = vi.fn(() => {
      throw new Error("blocked");
    });
    const setItem = vi.fn(() => {
      throw new Error("blocked");
    });
    vi.stubGlobal("localStorage", { getItem, setItem });

    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    await expect(changeSetting("minLevel", "WARN")).resolves.toBeUndefined();
    expect(getSettingsState().draft.minLevel).toBe("WARN");
    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
  });
});

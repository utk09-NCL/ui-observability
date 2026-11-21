import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConsent, saveConsent } from "./consent";

const KEY = "react-workspace.consent";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("consent", () => {
  it("defaults to telemetry on and replay off", () => {
    expect(loadConsent()).toEqual({ telemetry: true, replay: false });
  });

  it("keeps a saved choice", () => {
    saveConsent({ telemetry: false, replay: true });

    expect(loadConsent()).toEqual({ telemetry: false, replay: true });
  });

  it("keeps the default for a field of the wrong type", () => {
    localStorage.setItem(KEY, JSON.stringify({ telemetry: "no", replay: 1 }));

    expect(loadConsent()).toEqual({ telemetry: true, replay: false });
  });

  it.each([["{not json"], ["null"], ["7"]])("falls back to the defaults for %s", (text) => {
    localStorage.setItem(KEY, text);

    expect(loadConsent()).toEqual({ telemetry: true, replay: false });
  });

  it("works when the storage throws", () => {
    // A spy on Storage.prototype does not reach the localStorage of happy-dom, so the spec
    // replaces the global.
    const fail = (): never => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail });

    expect(loadConsent()).toEqual({ telemetry: true, replay: false });
    expect(() => {
      saveConsent({ telemetry: false, replay: false });
    }).not.toThrow();
  });
});

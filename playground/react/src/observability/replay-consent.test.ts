import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as library from "@utk09/ui-observability";
import type * as LibraryTypes from "@utk09/ui-observability";
import { DEFAULT_SETTINGS } from "../observability-settings/settings";
import { loadConsent, saveConsent } from "./consent";
import {
  resumeReplay,
  setReplayConsent,
  setTelemetryConsent,
  startAnonymous,
  stopForSharedDevice,
} from "./user-context";

// The replay needs a real recorder to record, and the specs only ask who calls startReplay() and
// stopReplay(), and when. So the spec replaces these two functions and keeps the rest.
vi.mock("@utk09/ui-observability", async (original) => ({
  ...(await original<typeof LibraryTypes>()),
  startReplay: vi.fn(),
  stopReplay: vi.fn(),
}));

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

describe("replay consent", () => {
  it("starts nothing for a user who gave no choice, because replay.requireConsent is on", () => {
    resumeReplay();

    expect(library.startReplay).not.toHaveBeenCalled();
  });

  it("starts the recorder when the user agrees, and stops it when the user withdraws", () => {
    setReplayConsent(true);
    expect(library.startReplay).toHaveBeenCalledTimes(1);
    expect(loadConsent().replay).toBe(true);

    setReplayConsent(false);
    expect(library.stopReplay).toHaveBeenCalledTimes(1);
    expect(loadConsent().replay).toBe(false);
  });

  it("does not start the recorder for a user who withdrew the telemetry", () => {
    saveConsent({ telemetry: false, replay: true });

    resumeReplay();
    setReplayConsent(true);

    expect(library.startReplay).not.toHaveBeenCalled();
  });

  it("stops the recorder when the telemetry is withdrawn, and starts it again on a grant", async () => {
    saveConsent({ telemetry: true, replay: true });

    await setTelemetryConsent(false, DEFAULT_SETTINGS);
    expect(library.stopReplay).toHaveBeenCalled();
    expect(library.startReplay).not.toHaveBeenCalled();

    await setTelemetryConsent(true, DEFAULT_SETTINGS);
    expect(library.startReplay).toHaveBeenCalledTimes(1);
  });

  it("starts the recorder again in a new runtime for a user who agreed", () => {
    saveConsent({ telemetry: true, replay: true });

    startAnonymous(DEFAULT_SETTINGS);

    expect(library.startReplay).toHaveBeenCalledTimes(1);
  });

  it("forgets the choices on a shared-device logout, so the next user does not record", async () => {
    saveConsent({ telemetry: true, replay: true });

    await stopForSharedDevice();
    startAnonymous(DEFAULT_SETTINGS);

    expect(loadConsent()).toEqual({ telemetry: true, replay: false });
    expect(library.startReplay).not.toHaveBeenCalled();
  });
});

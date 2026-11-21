import { afterEach, describe, expect, it, vi } from "vitest";
import * as library from "@utk09/ui-observability";
import type * as LibraryTypes from "@utk09/ui-observability";
import { saveConsent } from "./consent";
import { stopForSharedDevice } from "./user-context";

// The spec asks which options the app gives to shutdown(), and it lets the real function run.
vi.mock("@utk09/ui-observability", async (original) => {
  const actual = await original<typeof LibraryTypes>();

  return { ...actual, shutdown: vi.fn(actual.shutdown) };
});

afterEach(async () => {
  await library.shutdown();
  localStorage.clear();
});

describe("stopForSharedDevice", () => {
  it("discards what is not sent, and removes the stored data of the whole namespace", async () => {
    await stopForSharedDevice();

    // Each page load starts a new security context, so a scope of one context would leave the
    // parked batches of earlier page loads and of panel windows on the device.
    expect(library.shutdown).toHaveBeenCalledWith({
      pending: "discard",
      clearStorage: "namespace",
    });
  });

  it("forgets the privacy choices of the user", async () => {
    saveConsent({ telemetry: false, replay: true });

    await stopForSharedDevice();

    expect(localStorage.getItem("react-workspace.consent")).toBeNull();
  });
});

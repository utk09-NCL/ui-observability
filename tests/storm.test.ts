// tests/storm.test.ts
import { describe, expect, it, vi } from "vitest";
import { allowInWindow } from "../src/capture/storm";
import { Diagnostics } from "../src/core/diagnostics";

describe("allowInWindow", () => {
  it("starts a new window when the clock moves back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const window = { start: 0, count: 0 };
    const diagnostics = new Diagnostics(undefined, 0);

    allowInWindow(window, 1, diagnostics, "errors");
    vi.setSystemTime(50_000);

    // Without the reset, the window stays full until the clock passes the old start again.
    expect(allowInWindow(window, 1, diagnostics, "errors")).toBe(true);
  });
});

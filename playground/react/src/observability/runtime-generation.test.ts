import { describe, expect, it, vi } from "vitest";
import {
  bumpRuntimeGeneration,
  getRuntimeGeneration,
  subscribeRuntimeGeneration,
} from "./runtime-generation";

describe("runtime generation", () => {
  it("goes up by one for each bump, and tells each listener", () => {
    const listener = vi.fn();
    const stop = subscribeRuntimeGeneration(listener);
    const before = getRuntimeGeneration();

    bumpRuntimeGeneration();
    bumpRuntimeGeneration();

    expect(getRuntimeGeneration()).toBe(before + 2);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("tells no listener after it unsubscribed", () => {
    const listener = vi.fn();
    subscribeRuntimeGeneration(listener)();

    bumpRuntimeGeneration();

    expect(listener).not.toHaveBeenCalled();
  });
});

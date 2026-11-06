import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelDeferred, deferWrite, drainDeferred } from "../src/core/deferred";
import { Diagnostics } from "../src/core/diagnostics";

let callbacks: IdleRequestCallback[];

beforeEach(() => {
  callbacks = [];
  vi.stubGlobal(
    "requestIdleCallback",
    vi.fn((callback: IdleRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
  );
  vi.stubGlobal("cancelIdleCallback", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Deferred queue", () => {
  it("keeps runtimes separate and builds a group with one idle callback", () => {
    const first = {};
    const second = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const calls: number[] = [];
    deferWrite(first, () => calls.push(1), diagnostics, 10);
    deferWrite(first, () => calls.push(2), diagnostics, 10);
    deferWrite(second, () => calls.push(3), diagnostics, 10);
    expect(callbacks).toHaveLength(2);
    callbacks[0]({ didTimeout: false, timeRemaining: () => 10 });
    expect(calls).toEqual([1, 2]);
    drainDeferred(second);
    expect(calls).toEqual([1, 2, 3]);
    drainDeferred(first);
  });

  it("waits for more idle time when the current time allowance ends", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const calls: number[] = [];
    deferWrite(owner, () => calls.push(1), diagnostics, 10);
    deferWrite(owner, () => calls.push(2), diagnostics, 10);
    const remaining = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(0);
    callbacks[0]({ didTimeout: false, timeRemaining: remaining });
    expect(calls).toEqual([1]);
    expect(callbacks).toHaveLength(2);
    callbacks[1]({ didTimeout: true, timeRemaining: () => 0 });
    expect(calls).toEqual([1, 2]);
  });

  it("builds one call at the timeout without an idle allowance", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const calls: number[] = [];
    deferWrite(owner, () => calls.push(1), diagnostics, 10);
    deferWrite(owner, () => calls.push(2), diagnostics, 10);
    callbacks[0]({ didTimeout: true, timeRemaining: () => 0 });
    expect(calls).toEqual([1]);
    callbacks[1]({ didTimeout: true, timeRemaining: () => 0 });
    expect(calls).toEqual([1, 2]);
  });

  it("builds a full queue before it holds another payload reference", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const calls: number[] = [];
    deferWrite(owner, () => calls.push(1), diagnostics, 1);
    deferWrite(owner, () => calls.push(2), diagnostics, 1);
    expect(calls).toEqual([1]);
    drainDeferred(owner);
    expect(calls).toEqual([1, 2]);
  });

  it("uses the fixed cap when the record budget is unlimited", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const write = vi.fn();
    for (let i = 0; i < 1001; i++) {
      deferWrite(owner, write, diagnostics, 0);
    }
    expect(write).toHaveBeenCalledTimes(1000);
    drainDeferred(owner);
    expect(write).toHaveBeenCalledTimes(1001);
  });

  it("contains failed builds and cancellation failures", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    vi.stubGlobal("cancelIdleCallback", () => {
      throw new Error("blocked");
    });
    deferWrite(
      owner,
      () => {
        throw new Error("bad record");
      },
      diagnostics,
      10,
    );
    const next = vi.fn();
    deferWrite(owner, next, diagnostics, 10);
    expect(() => drainDeferred(owner)).not.toThrow();
    expect(next).toHaveBeenCalledOnce();
    expect(diagnostics.snapshot()["pipeline.crashed"]).toBe(2);
  });

  it.each(["no idle API", "no cancel API", "idle API throws"])("uses a timer with %s", (kind) => {
    vi.useFakeTimers();
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const write = vi.fn();
    if (kind === "no idle API") {
      vi.stubGlobal("requestIdleCallback", undefined);
    } else if (kind === "no cancel API") {
      vi.stubGlobal("cancelIdleCallback", undefined);
    } else {
      vi.stubGlobal("requestIdleCallback", () => {
        throw new Error("blocked");
      });
    }
    deferWrite(owner, write, diagnostics, 10);
    expect(write).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(write).toHaveBeenCalledOnce();
  });

  it("ignores a callback after cancellation and releases the queue", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const write = vi.fn();
    deferWrite(owner, write, diagnostics, 10);
    cancelDeferred(owner);
    expect(diagnostics.snapshot()["record.dropped_by_ceiling"]).toBe(1);
    callbacks[0]({ didTimeout: true, timeRemaining: () => 0 });
    expect(write).not.toHaveBeenCalled();
    cancelDeferred(owner);
  });

  it("limits reentrant calls and refuses a recursive drain", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const child = vi.fn();
    deferWrite(
      owner,
      () => {
        drainDeferred(owner);
        deferWrite(owner, child, diagnostics, 1);
        deferWrite(owner, child, diagnostics, 1);
      },
      diagnostics,
      1,
    );
    drainDeferred(owner);
    expect(child).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()["record.dropped_by_ceiling"]).toBe(1);
    drainDeferred(owner);
    expect(child).toHaveBeenCalledOnce();
  });

  it("keeps the cap when a full drain queues another call", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const child = vi.fn();
    const newest = vi.fn();
    deferWrite(owner, () => deferWrite(owner, child, diagnostics, 1), diagnostics, 1);
    deferWrite(owner, newest, diagnostics, 1);
    drainDeferred(owner);
    expect(child).toHaveBeenCalledOnce();
    expect(newest).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()["record.dropped_by_ceiling"]).toBe(1);
  });

  it("stops a group when a callback cancels the queue", () => {
    const owner = {};
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const next = vi.fn();
    deferWrite(owner, () => cancelDeferred(owner), diagnostics, 10);
    deferWrite(owner, next, diagnostics, 10);
    drainDeferred(owner);
    expect(next).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
  });
});

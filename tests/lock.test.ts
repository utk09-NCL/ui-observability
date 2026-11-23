import { describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import { withDrainLock } from "../src/utils/lock";

const diagnostics = () => new Diagnostics(vi.fn(), 0);

type Grant = { name: string } | null;
type Callback = (lock: Grant) => Promise<unknown>;

/** A lock manager that always hands back `grant`. null models one held elsewhere. */
const stubLocks = (grant: Grant) => {
  const request = vi.fn((_name: string, _options: unknown, callback: Callback) => callback(grant));
  vi.stubGlobal("navigator", { locks: { request } });
  return request;
};

describe("withDrainLock", () => {
  it("runs unguarded in a host with no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);
    const fn = vi.fn(() => Promise.resolve("ran"));

    await expect(withDrainLock("drain", diagnostics(), fn)).resolves.toBe("ran");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("runs unguarded when the runtime has no Web Locks", async () => {
    // Server-side deduplication still covers us, so running beats not running.
    vi.stubGlobal("navigator", { locks: undefined });
    const fn = vi.fn(() => Promise.resolve("ran"));

    await expect(withDrainLock("drain", diagnostics(), fn)).resolves.toBe("ran");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("runs the callback when the lock is free", async () => {
    stubLocks({ name: "drain" });

    await expect(withDrainLock("drain", diagnostics(), () => Promise.resolve("ran"))).resolves.toBe(
      "ran",
    );
  });

  it("returns undefined WITHOUT running when another context holds it", async () => {
    // `ifAvailable` hands back a null grant rather than queueing. A caller that
    // cannot tell this apart from a completed run never reschedules.
    stubLocks(null);
    const fn = vi.fn(() => Promise.resolve("ran"));

    await expect(withDrainLock("drain", diagnostics(), fn)).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips by default, and waits when the caller says so", async () => {
    const request = stubLocks({ name: "emergency" });

    await withDrainLock("emergency", diagnostics(), () => Promise.resolve(1));
    await withDrainLock("emergency", diagnostics(), () => Promise.resolve(1), {
      skipIfBusy: false,
    });

    expect(request.mock.calls[0][1]).toEqual({ ifAvailable: true });
    expect(request.mock.calls[1][1]).toEqual({ ifAvailable: false });
  });

  it.each([
    ["a SecurityError, as in an opaque origin", new DOMException("opaque origin", "SecurityError")],
    ["any other error", new Error("locks are unavailable in this context")],
  ])("runs the task without a lock when the request rejects with %s", async (_name, failure) => {
    // No lock was granted, so no other window can hold one either. A busy lock gives a null
    // grant and never rejects, so a rejection must not read as "busy".
    vi.stubGlobal("navigator", { locks: { request: () => Promise.reject(failure) } });
    const fn = vi.fn(() => Promise.resolve("ran"));

    await expect(withDrainLock("drain", diagnostics(), fn)).resolves.toBe("ran");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("runs the task only once when the task itself rejects under a granted lock", async () => {
    // The lock manager passes the task's rejection on. That isn't a refused request, and a
    // second run without the lock would send the stored batches twice.
    stubLocks({ name: "drain" });
    const fn = vi.fn(() => Promise.reject(new Error("the drain threw")));

    await withDrainLock("drain", diagnostics(), fn);

    expect(fn).toHaveBeenCalledOnce();
  });

  it("reports a failed lock request, and still runs the task without the lock", async () => {
    const handler = vi.fn();
    vi.stubGlobal("navigator", {
      locks: {
        request: () => Promise.reject(new Error("locks are unavailable in this context")),
      },
    });

    await expect(
      withDrainLock("drain", new Diagnostics(handler, 0), () => Promise.resolve(1)),
    ).resolves.toBe(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "storage.degraded",
        message: "The library could not get the lock drain. It runs the work without the lock.",
      }),
    );
  });

  it("reports a task that fails under the lock, and skips that run", async () => {
    // The caller reads undefined as "skipped", so the next timer still comes.
    const handler = vi.fn();
    stubLocks({ name: "drain" });
    const cause = new Error("the drain threw");

    await expect(
      withDrainLock("drain", new Diagnostics(handler, 0), () => Promise.reject(cause)),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "storage.degraded",
        message: "The work under the lock drain failed. The library skips this run.",
        cause,
      }),
    );
  });
});

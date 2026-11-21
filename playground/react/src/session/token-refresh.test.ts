import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTokenRefresh } from "./token-refresh";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("token refresh timer", () => {
  it("refreshes at 80 percent of the life of the token", async () => {
    const refresh = vi.fn(() => Promise.resolve(10_000));
    startTokenRefresh({ refresh, expiresInMs: 10_000, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("starts the next wait from the life of the new token", async () => {
    const lives = [20_000, 5_000];
    const refresh = vi.fn(() => Promise.resolve(lives.shift() ?? 0));
    startTokenRefresh({ refresh, expiresInMs: 10_000, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The first answer said 20 s, so the next refresh is at 16 s and not at 8 s.
    await vi.advanceTimersByTimeAsync(15_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    // The second answer said 5 s, so the third refresh is 4 s later.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("waits at least one second for a token that lives for less", async () => {
    const refresh = vi.fn(() => Promise.resolve(100));
    startTokenRefresh({ refresh, expiresInMs: 100, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops after a failed refresh, and reports the error one time", async () => {
    const error = new Error("401");
    const refresh = vi.fn(() => Promise.reject(error));
    const onError = vi.fn();
    startTokenRefresh({ refresh, expiresInMs: 10_000, onError });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("does nothing after stop, also for an answer that was on its way", async () => {
    let answer: (life: number) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          answer = resolve;
        }),
    );
    const stop = startTokenRefresh({ refresh, expiresInMs: 10_000, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    answer(10_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when it stops before the first timer", async () => {
    const refresh = vi.fn(() => Promise.resolve(10_000));
    const stop = startTokenRefresh({ refresh, expiresInMs: 10_000, onError: vi.fn() });

    stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not report an error that comes after stop", async () => {
    let fail: (error: unknown) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<number>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const onError = vi.fn();
    const stop = startTokenRefresh({ refresh, expiresInMs: 10_000, onError });

    await vi.advanceTimersByTimeAsync(8_000);
    stop();
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(1);

    expect(onError).not.toHaveBeenCalled();
  });
});

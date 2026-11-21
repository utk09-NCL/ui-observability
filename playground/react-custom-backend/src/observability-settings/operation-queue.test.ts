import { describe, expect, it } from "vitest";
import { isBusy, runExclusive } from "./operation-queue";

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}

describe("operation queue", () => {
  it("runs one task at a time, in the order of the calls", async () => {
    const log: string[] = [];
    const first = runExclusive(async () => {
      log.push("first starts");
      await tick();
      log.push("first ends");
    });
    const second = runExclusive(() => {
      log.push("second runs");

      return Promise.resolve();
    });

    await Promise.all([first, second]);

    expect(log).toEqual(["first starts", "first ends", "second runs"]);
  });

  it("is busy while a task runs or waits, and idle after", async () => {
    const first = runExclusive(tick);
    const second = runExclusive(tick);

    expect(isBusy()).toBe(true);
    await first;
    expect(isBusy()).toBe(true);
    await second;
    expect(isBusy()).toBe(false);
  });

  it("gives the result of the task to the caller", async () => {
    await expect(runExclusive(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it("keeps running after a task rejects, and the caller gets the rejection", async () => {
    const failing = runExclusive(() => Promise.reject(new Error("rotation failed")));
    const after = runExclusive(() => Promise.resolve("next"));

    await expect(failing).rejects.toThrow("rotation failed");
    await expect(after).resolves.toBe("next");
    expect(isBusy()).toBe(false);
  });
});

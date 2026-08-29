import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import { drainEmergencyQueue, saveToEmergencyQueue } from "../src/storage/emergency-queue";
import { MemoryStorage } from "../src/storage/memory-storage";
import { useFakeLocalStorage } from "./fake-storage";

const PREFIX = "ui-observability.emergency.";
const MAX_ENTRIES = 20;

const limits = { maxBatches: 100, maxAgeMs: 60_000, maxAttempts: 5 };

const quiet = () => new Diagnostics(vi.fn(), 0);
const listening = () => {
  const handler = vi.fn<(event: DiagnosticEvent) => void>();
  return { handler, diagnostics: new Diagnostics(handler, 0) };
};

const batch = (id: string, createdAt = Date.now()): LogBatch => ({
  id,
  createdAt,
  attempts: 0,
  records: [{ body: id } as never],
});

/** Object.keys on a Storage is not portable. Enumerate the documented way. */
const emergencyKeys = (): string[] => {
  const out: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = String(localStorage.key(i));
    if (key.startsWith(PREFIX)) {
      out.push(key);
    }
  }

  return out.sort();
};

beforeEach(() => {
  localStorage.clear();
});

describe("the emergency queue", () => {
  it("moves survivors into real storage at startup", async () => {
    localStorage.setItem("someone-elses.key", "keep me");
    saveToEmergencyQueue(batch("b1"), quiet());
    saveToEmergencyQueue(batch("b2"), quiet());
    const storage = new MemoryStorage(limits);

    expect(await drainEmergencyQueue(storage, quiet())).toBe(2);
    expect(await storage.count()).toBe(2);
    expect(emergencyKeys()).toEqual([]);
    expect(localStorage.getItem("someone-elses.key")).toBe("keep me");
  });

  it("claims each key before the save, so a second window finds nothing", async () => {
    // Five windows can restore at once after a crash. The key is removed
    // synchronously, so the race window is one statement rather than an await.
    saveToEmergencyQueue(batch("b1"), quiet());
    const storage = new MemoryStorage(limits);

    const [first, second] = await Promise.all([
      drainEmergencyQueue(storage, quiet()),
      drainEmergencyQueue(storage, quiet()),
    ]);

    expect(first + second).toBe(1);
    expect(await storage.count()).toBe(1);
  });

  it("stays bounded, dropping the oldest", () => {
    for (let i = 0; i < 25; i++) {
      saveToEmergencyQueue(batch(`b${String(i)}`, 1000 + i), quiet());
    }

    const keys = emergencyKeys();
    expect(keys.length).toBe(MAX_ENTRIES);
    // The five oldest went. The key embeds the creation time, so the survivors
    // are the newest rather than whichever ids happened to sort low.
    expect(keys[0]).toContain(".b5");
    expect(keys[MAX_ENTRIES - 1]).toContain(".b24");
  });

  it("drops an entry that is not JSON rather than reimporting it forever", async () => {
    const { handler, diagnostics } = listening();
    localStorage.setItem(`${PREFIX}00000000000001.bad`, "not json");

    expect(await drainEmergencyQueue(new MemoryStorage(limits), diagnostics)).toBe(0);
    expect(emergencyKeys()).toEqual([]);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("drops an entry that parses but is not a batch", async () => {
    const { handler, diagnostics } = listening();
    localStorage.setItem(`${PREFIX}00000000000001.wrong`, "{}");

    expect(await drainEmergencyQueue(new MemoryStorage(limits), diagnostics)).toBe(0);
    expect(emergencyKeys()).toEqual([]);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("skips an entry that reads back empty", async () => {
    localStorage.setItem(`${PREFIX}00000000000001.empty`, "");

    expect(await drainEmergencyQueue(new MemoryStorage(limits), quiet())).toBe(0);
    expect(emergencyKeys()).toEqual([]);
  });

  it("reports rather than throwing when the store refuses the write", () => {
    // This runs while a document is unloading. Throwing here is the last thing
    // that happens in that window, and nothing is left to catch it.
    const blocked = useFakeLocalStorage();
    const { handler, diagnostics } = listening();
    blocked.add("setItem");

    expect(() => {
      saveToEmergencyQueue(batch("b1"), diagnostics);
    }).not.toThrow();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "storage.quota_exceeded" }),
    );
  });

  it("recovers nothing when the store cannot be enumerated at all", async () => {
    const blocked = useFakeLocalStorage();
    const { handler, diagnostics } = listening();
    localStorage.setItem(`${PREFIX}00000000000001.b1`, "{}");
    blocked.add("key");

    expect(await drainEmergencyQueue(new MemoryStorage(limits), diagnostics)).toBe(0);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.unavailable" }));
  });

  it("reports an entry the real storage refuses, and does not put it back", async () => {
    const { handler, diagnostics } = listening();
    const storage = new MemoryStorage(limits);
    vi.spyOn(storage, "save").mockRejectedValue(new Error("store is full"));
    saveToEmergencyQueue(batch("b1"), quiet());

    expect(await drainEmergencyQueue(storage, diagnostics)).toBe(0);
    expect(emergencyKeys()).toEqual([]);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("recovers nothing when the lock manager itself fails", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: () => Promise.reject(new Error("locks are unavailable in this context")),
      },
    });
    saveToEmergencyQueue(batch("b1"), quiet());

    expect(await drainEmergencyQueue(new MemoryStorage(limits), quiet())).toBe(0);
  });

  it("waits for the other window rather than skipping the recovery", async () => {
    const request = vi.fn(
      (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
        callback({ name: "emergency" }),
    );
    vi.stubGlobal("navigator", { locks: { request } });

    await drainEmergencyQueue(new MemoryStorage(limits), quiet());

    expect(request.mock.calls[0][1]).toEqual({ ifAvailable: false });
  });
});

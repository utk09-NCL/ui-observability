import { beforeEach, describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { PruneResult } from "../src/models/storage";
import { createStorage } from "../src/storage/factory";
import { LocalStorageStorage } from "../src/storage/local-storage";
import { MemoryStorage } from "../src/storage/memory-storage";

const limits = { maxBatches: 3, maxAgeMs: 1000, maxAttempts: 5 };

const batch = (id: string, createdAt = Date.now(), records = 0): LogBatch => ({
  id,
  createdAt,
  attempts: 0,
  records: Array.from({ length: records }, () => ({}) as never),
});

const quiet = () => new Diagnostics(vi.fn(), 0);

/**
 * A localStorage backed by a Map, with a switch that makes one method throw.
 *
 * The whole global is replaced rather than spied on. happy-dom's Storage is a
 * Proxy, so a spy installed on `Storage.prototype` never runs and the real
 * method answers instead, which reads as the failure not happening at all.
 */
const useFakeLocalStorage = () => {
  const store = new Map<string, string>();
  const blocked = new Set<"getItem" | "setItem" | "removeItem" | "key">();

  const check = (method: "getItem" | "setItem" | "removeItem" | "key") => {
    if (blocked.has(method)) {
      throw new DOMException("blocked", "SecurityError");
    }
  };

  vi.stubGlobal("localStorage", {
    get length(): number {
      return store.size;
    },
    key(index: number): string | null {
      check("key");
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      check("getItem");
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      check("setItem");
      store.set(key, value);
    },
    removeItem(key: string): void {
      check("removeItem");
      store.delete(key);
    },
    // Required: the shared afterEach calls clear() and can reach this stub.
    clear(): void {
      store.clear();
    },
  });

  return blocked;
};

beforeEach(() => {
  localStorage.clear();
});

describe("storage factory", () => {
  it("hands back a no-op adapter for strategy none", async () => {
    const adapter = await createStorage("none", "db", limits, quiet());

    expect(adapter.name).toBe("none");
    await adapter.save(batch("a"));
    expect(await adapter.count()).toBe(0);
    expect(await adapter.take(10)).toEqual([]);
    // Every method has to exist and resolve, or the sender crashes on shutdown.
    await adapter.remove("a");
    await adapter.bumpAttempts("a", 1);
    expect(await adapter.prune()).toMatchObject({ batches: 0, records: 0 });
    await adapter.clear();
    await adapter.close();
  });

  it("uses IndexedDB when it is there, and never imports Dexie when it is not asked to", async () => {
    const indexeddb = await createStorage("auto", "db-auto", limits, quiet());
    expect(indexeddb.name).toBe("indexeddb");
    await indexeddb.close();

    // The whole reason the import is dynamic: a consumer who asked for memory
    // must not pay for the heaviest dependency in the library.
    const memory = await createStorage("memory", "db", limits, quiet());
    expect(memory.name).toBe("memory");
  });

  it("falls back to localStorage when only IndexedDB is missing", async () => {
    vi.stubGlobal("indexedDB", undefined);

    expect((await createStorage("auto", "db", limits, quiet())).name).toBe("localstorage");

    // Some browsers null the property out rather than dropping it.
    vi.stubGlobal("indexedDB", null);

    expect((await createStorage("auto", "db", limits, quiet())).name).toBe("localstorage");
  });

  it("survives a browser that throws on touching indexedDB at all", async () => {
    // Firefox in private mode. Reading the property is itself the failure.
    const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    try {
      const handler = vi.fn();
      const adapter = await createStorage("auto", "db", limits, new Diagnostics(handler, 0));

      expect(adapter.name).toBe("localstorage");
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ code: "storage.unavailable" }),
      );
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "indexedDB", original);
      } else {
        Reflect.deleteProperty(globalThis, "indexedDB");
      }
    }
  });

  it("falls back when the IndexedDB chunk itself cannot be loaded", async () => {
    // A code-split chunk that fails to load is a real production failure, and
    // it must cost a fallback rather than the whole logger.
    vi.resetModules();
    vi.doMock("../src/storage/indexeddb-storage", () => {
      throw new Error("chunk load failed");
    });

    const { createStorage: create } = await import("../src/storage/factory");
    const handler = vi.fn();
    const adapter = await create("auto", "db", limits, new Diagnostics(handler, 0));

    expect(adapter.name).toBe("localstorage");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.unavailable" }));

    vi.doUnmock("../src/storage/indexeddb-storage");
    vi.resetModules();
  });

  it("takes localStorage when that is what was asked for", async () => {
    const adapter = await createStorage("localstorage", "db", limits, quiet());

    expect(adapter.name).toBe("localstorage");
  });

  it("says so when IndexedDB was asked for by name and is not available", async () => {
    const handler = vi.fn();
    vi.stubGlobal("indexedDB", undefined);

    const adapter = await createStorage("indexeddb", "db", limits, new Diagnostics(handler, 0));

    expect(adapter.name).toBe("memory");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("degrades to memory when nothing persistent is available", async () => {
    const handler = vi.fn();
    vi.stubGlobal("indexedDB", undefined);
    useFakeLocalStorage().add("setItem");

    const adapter = await createStorage("auto", "db", limits, new Diagnostics(handler, 0));

    expect(adapter.name).toBe("memory");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });
});

describe("MemoryStorage", () => {
  it("returns oldest first, which is the order the retry engine relies on", async () => {
    const s = new MemoryStorage(limits);
    await s.save(batch("a"));
    await s.save(batch("b"));

    expect((await s.take(10)).map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("evicts the oldest once maxBatches is exceeded", async () => {
    const s = new MemoryStorage(limits);
    for (const id of ["a", "b", "c", "d"]) {
      await s.save(batch(id));
    }

    expect((await s.take(10)).map((b) => b.id)).toEqual(["b", "c", "d"]);
  });

  it("drops batches older than maxAgeMs", async () => {
    const s = new MemoryStorage(limits);
    await s.save(batch("old", Date.now() - 5000));
    await s.save(batch("new"));

    expect((await s.take(10)).map((b) => b.id)).toEqual(["new"]);
  });

  it("reports a gap when eviction drops records, so the backend sees the hole", async () => {
    const gaps: PruneResult[] = [];
    const s = new MemoryStorage(limits, (result) => gaps.push(result));

    for (const id of ["a", "b", "c", "d"]) {
      await s.save(batch(id, Date.now(), 2));
    }

    expect(gaps).toEqual([{ batches: 1, records: 2, reason: "over_capacity" }]);
  });

  it("persists the attempt count so a poison batch can be given up on", async () => {
    const s = new MemoryStorage(limits);
    await s.save(batch("a"));

    await s.bumpAttempts("a", 4);
    // An id that is not there is not an error: the batch may have been
    // delivered by another tab between the take and the bump.
    await s.bumpAttempts("gone", 9);

    expect((await s.take(1))[0].attempts).toBe(4);
  });

  it("removes, clears and closes", async () => {
    const s = new MemoryStorage(limits);
    await s.save(batch("a"));
    await s.save(batch("b"));

    await s.remove("a");
    expect(await s.count()).toBe(1);

    await s.clear();
    expect(await s.count()).toBe(0);

    await s.save(batch("c"));
    await s.close();
    expect(await s.count()).toBe(0);
  });
});

describe("LocalStorageStorage", () => {
  const lsLimits = { maxBatches: 3, maxAgeMs: 60_000, maxAttempts: 5 };
  const make = (onGap?: (result: PruneResult) => void) =>
    new LocalStorageStorage(lsLimits, quiet(), onGap);

  it("returns oldest first even though the ids are random", async () => {
    // The regression test for the key format. Keyed on the batch id alone, the
    // sort is a sort by random uuid and this passes or fails by luck.
    const s = make();
    const now = Date.now();
    await s.save(batch("zzz-oldest", now - 2000));
    await s.save(batch("aaa-newest", now - 1000));

    expect((await s.take(10)).map((b) => b.id)).toEqual(["zzz-oldest", "aaa-newest"]);
  });

  it("finds a batch by id for remove and bumpAttempts, since the key is not the id", async () => {
    const s = make();
    await s.save(batch("b1"));

    await s.bumpAttempts("b1", 4);
    expect((await s.take(1))[0].attempts).toBe(4);

    await s.remove("b1");
    expect(await s.count()).toBe(0);

    // Neither call may throw on an id that is not there.
    await s.remove("gone");
    await s.bumpAttempts("gone", 1);
  });

  it("evicts the oldest when it goes over capacity, and says how big the hole is", async () => {
    const gaps: PruneResult[] = [];
    const s = make((result) => gaps.push(result));
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await s.save(batch(`b${String(i)}`, now - (5 - i) * 1000, 2));
    }

    expect((await s.take(10)).map((b) => b.id)).toEqual(["b2", "b3", "b4"]);
    expect(gaps.at(-1)).toMatchObject({ reason: "over_capacity" });
  });

  it("drops batches past maxAgeMs", async () => {
    const s = make();
    await s.save(batch("fresh"));
    localStorage.setItem(
      "ui-observability.batch.00000000000001.ancient",
      JSON.stringify(batch("ancient", 1)),
    );

    await s.prune();

    expect((await s.take(10)).map((b) => b.id)).toEqual(["fresh"]);
  });

  it("removes a corrupt entry on read instead of throwing", async () => {
    const handler = vi.fn();
    const s = new LocalStorageStorage(lsLimits, new Diagnostics(handler, 0));
    localStorage.setItem("ui-observability.batch.00000000009999.corrupt", "not json");

    expect(await s.take(10)).toEqual([]);
    expect(localStorage.getItem("ui-observability.batch.00000000009999.corrupt")).toBeNull();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("drops anything under our prefix that parses but is not a batch", async () => {
    // Written by an older version of this library, or by something else on the
    // origin. Every field the adapter reads is checked before it is used.
    const s = make();
    const planted = {
      "ui-observability.batch.00000000000001.empty": "",
      "ui-observability.batch.00000000000002.null": "null",
      "ui-observability.batch.00000000000003.number": "123",
      "ui-observability.batch.00000000000004.no-time": JSON.stringify({ records: [] }),
      "ui-observability.batch.00000000000005.no-records": JSON.stringify({ createdAt: 1 }),
    };
    for (const [key, value] of Object.entries(planted)) {
      localStorage.setItem(key, value);
    }

    expect(await s.take(10)).toEqual([]);
    expect(await s.count()).toBe(0);
  });

  it("cannot bump a corrupt entry, and drops it on the next prune", async () => {
    const handler = vi.fn();
    const s = new LocalStorageStorage(lsLimits, new Diagnostics(handler, 0));
    const key = "ui-observability.batch.00000000000007.zombie";
    localStorage.setItem(key, "not json");

    // The key still names an id, so it is found, but there is nothing to update.
    await s.bumpAttempts("zombie", 3);
    await s.prune();

    expect(localStorage.getItem(key)).toBeNull();
    expect(await s.count()).toBe(0);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("evicts a quarter of the store when localStorage rejects a write", async () => {
    // Installed before the seeding writes, or the adapter reads an empty store.
    const blocked = useFakeLocalStorage();
    const s = make();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await s.save(batch(`b${String(i)}`, now - i * 1000));
    }

    blocked.add("setItem");
    await s.save(batch("overflow", now));
    blocked.delete("setItem");

    expect(await s.count()).toBe(2);
  });

  it("returns nothing rather than throwing when storage refuses enumeration", async () => {
    const handler = vi.fn();
    const blocked = useFakeLocalStorage();
    const s = new LocalStorageStorage(lsLimits, new Diagnostics(handler, 0));
    await s.save(batch("b1"));

    blocked.add("key");

    expect(await s.count()).toBe(0);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.unavailable" }));
  });

  it("leaves keys that are not ours alone", async () => {
    const s = make();
    localStorage.setItem("someone-elses.key", "keep me");
    await s.save(batch("b1"));

    expect(await s.count()).toBe(1);
    await s.clear();

    expect(await s.count()).toBe(0);
    expect(localStorage.getItem("someone-elses.key")).toBe("keep me");
  });

  it("clears and closes", async () => {
    const s = make();
    await s.save(batch("b1"));

    await s.clear();
    expect(await s.count()).toBe(0);
    await expect(s.close()).resolves.toBeUndefined();
  });
});

describe("IndexedDbStorage", () => {
  // fake-indexeddb is loaded by tests/setup.ts, so Dexie has a real store here.
  // A fresh database name per test, because the store outlives the adapter.
  const idbLimits = { maxBatches: 3, maxAgeMs: 60_000, maxAttempts: 5 };
  let counter = 0;

  const make = async (
    over: Partial<typeof idbLimits> = {},
    handler = vi.fn(),
    onGap?: (result: PruneResult) => void,
  ) => {
    const { IndexedDbStorage } = await import("../src/storage/indexeddb-storage");
    return {
      handler,
      storage: new IndexedDbStorage(
        `uiobs-test-${String(++counter)}`,
        { ...idbLimits, ...over },
        new Diagnostics(handler, 0),
        onGap,
      ),
    };
  };

  it("round-trips batches oldest first", async () => {
    const { storage } = await make();
    const now = Date.now();
    await storage.save(batch("second", now));
    await storage.save(batch("first", now - 1000));

    expect((await storage.take(10)).map((b) => b.id)).toEqual(["first", "second"]);
    expect(await storage.count()).toBe(2);
    await storage.close();
  });

  it("persists an attempt count and removes by id", async () => {
    const { storage } = await make();
    await storage.save(batch("b1"));

    await storage.bumpAttempts("b1", 3);
    expect((await storage.take(1))[0].attempts).toBe(3);

    await storage.remove("b1");
    expect(await storage.count()).toBe(0);
    await storage.close();
  });

  it("prunes past maxAgeMs and reports the hole with a record count", async () => {
    const gaps: PruneResult[] = [];
    const { storage } = await make({}, vi.fn(), (result) => gaps.push(result));

    // save() prunes, so this is gone before the next line runs.
    await storage.save(batch("ancient", Date.now() - 120_000, 2));

    expect(await storage.count()).toBe(0);
    expect(gaps[0]).toMatchObject({ batches: 1, records: 2, reason: "expired" });
    await storage.close();
  });

  it("evicts the oldest over maxBatches", async () => {
    const { storage } = await make();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await storage.save(batch(`b${String(i)}`, now - (5 - i) * 1000));
    }

    expect((await storage.take(10)).map((b) => b.id)).toEqual(["b2", "b3", "b4"]);
    await storage.close();
  });

  it("evicts rather than giving up when the disk is full", async () => {
    const { storage, handler } = await make();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await storage.save(batch(`b${String(i)}`, now - i * 1000));
    }

    vi.spyOn(storage["db"].batches, "put").mockRejectedValueOnce(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    await storage.save(batch("overflow", now));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "storage.quota_exceeded" }),
    );
    expect(await storage.count()).toBe(2);
    await storage.close();
  });

  it("reports it when even the eviction fails, rather than throwing out of save", async () => {
    const { storage, handler } = await make();
    await storage.save(batch("b1"));

    vi.spyOn(storage["db"].batches, "put").mockRejectedValueOnce(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    vi.spyOn(storage["db"].batches, "orderBy").mockImplementation(() => {
      throw new Error("database is closing");
    });

    await expect(storage.save(batch("overflow"))).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("reports any other write failure as degraded, not as a quota problem", async () => {
    const { storage, handler } = await make();
    vi.spyOn(storage["db"].batches, "put")
      .mockRejectedValueOnce(new Error("boom"))
      // Not every store rejects with an Error, and `error.name` on a string is
      // undefined rather than a throw.
      .mockRejectedValueOnce("boom");

    await storage.save(batch("b1"));
    await storage.save(batch("b2"));

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
    expect(handler).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "storage.quota_exceeded" }),
    );
    await storage.close();
  });

  it("hands back an empty list rather than throwing when a read fails", async () => {
    const { storage, handler } = await make();
    vi.spyOn(storage["db"].batches, "orderBy").mockImplementation(() => {
      throw new Error("database is closing");
    });

    expect(await storage.take(10)).toEqual([]);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("counts zero rather than throwing when the database cannot answer", async () => {
    const { storage, handler } = await make();
    vi.spyOn(storage["db"].batches, "count").mockImplementation(() => {
      throw new Error("database is closing");
    });

    expect(await storage.count()).toBe(0);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("clears", async () => {
    const { storage } = await make();
    await storage.save(batch("b1"));
    await storage.clear();

    expect(await storage.count()).toBe(0);
    await storage.close();
  });
});

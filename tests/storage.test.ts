import { beforeEach, describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { PruneResult } from "../src/models/storage";
import { createStorage } from "../src/storage/factory";
import { IdbDriver } from "../src/storage/idb-driver";
import { LocalStorageStorage } from "../src/storage/local-storage";
import { MemoryStorage } from "../src/storage/memory-storage";
import { useFakeLocalStorage } from "./fake-storage";

const limits = { maxBatches: 3, maxAgeMs: 1000, maxAttempts: 5 };

const batch = (id: string, createdAt = Date.now(), records = 0): LogBatch => ({
  id,
  createdAt,
  attempts: 0,
  records: Array.from({ length: records }, () => ({}) as never),
});

const quiet = () => new Diagnostics(vi.fn(), 0);

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

  it("uses IndexedDB when it is there, and never loads the chunk when it is not asked to", async () => {
    const indexeddb = await createStorage("auto", "db-auto", limits, quiet());
    expect(indexeddb.name).toBe("indexeddb");
    await indexeddb.close();

    // The whole reason the import is dynamic: a consumer who asked for memory
    // must not pay to parse the IndexedDB driver.
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
      "ui-observability.batch.00000000000004.no-id": JSON.stringify({
        createdAt: 1,
        attempts: 0,
        records: [],
      }),
      "ui-observability.batch.00000000000005.no-time": JSON.stringify({
        id: "no-time",
        attempts: 0,
        records: [],
      }),
      "ui-observability.batch.00000000000006.no-attempts": JSON.stringify({
        id: "no-attempts",
        createdAt: 1,
        records: [],
      }),
      "ui-observability.batch.00000000000008.no-records": JSON.stringify({
        id: "no-records",
        createdAt: 1,
        attempts: 0,
      }),
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
    const gaps: PruneResult[] = [];
    const s = make((result) => gaps.push(result));
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await s.save(batch(`b${String(i)}`, now - i * 1000, 2));
    }

    blocked.add("setItem");
    await s.save(batch("overflow", now, 4));
    blocked.delete("setItem");

    expect(await s.count()).toBe(2);
    // The eviction, then the batch that could not be written even after it.
    expect(gaps.at(-2)).toMatchObject({ batches: 1, records: 2, reason: "quota" });
    expect(gaps.at(-1)).toMatchObject({ batches: 1, records: 4, reason: "quota" });
  });

  it("retries the write after evicting, so the batch that hit the ceiling survives", async () => {
    useFakeLocalStorage();
    const gaps: PruneResult[] = [];
    const s = make((result) => gaps.push(result));
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await s.save(batch(`b${String(i)}`, now - (3 - i) * 1000, 2));
    }

    const setItem = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await s.save(batch("overflow", now, 2));
    setItem.mockRestore();

    expect((await s.take(10)).map((b) => b.id)).toEqual(["b1", "b2", "overflow"]);
    expect(gaps.at(-1)).toMatchObject({ batches: 1, records: 2, reason: "quota" });
  });

  it("counts a corrupt entry evicted for quota as a batch holding no records", async () => {
    useFakeLocalStorage();
    const gaps: PruneResult[] = [];
    const s = make((result) => gaps.push(result));
    await s.save(batch("b1", Date.now(), 2));
    // Oldest by key, so the quota eviction reaches it first. Planted after the
    // save above, which would have pruned it.
    localStorage.setItem("ui-observability.batch.00000000000001.corrupt", "not json");

    const setItem = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await s.save(batch("overflow", Date.now(), 2));
    setItem.mockRestore();

    expect(gaps.at(-1)).toMatchObject({ batches: 1, records: 0, reason: "quota" });
    expect((await s.take(10)).map((b) => b.id)).toEqual(["b1", "overflow"]);
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
  // fake-indexeddb is loaded by tests/setup.ts, so the driver has a real store here.
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

  it("evicts and then retries the write when the disk is full", async () => {
    const { storage, handler } = await make();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await storage.save(batch(`b${String(i)}`, now - i * 1000));
    }

    vi.spyOn(storage["db"], "put").mockRejectedValueOnce(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    await storage.save(batch("overflow", now));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "storage.quota_exceeded" }),
    );
    // The eviction freed room for this batch, so the batch has to be in it.
    expect((await storage.take(10)).map((b) => b.id)).toContain("overflow");
    expect(await storage.count()).toBe(3);
    await storage.close();
  });

  it("counts a gap when the write after eviction is refused too", async () => {
    const gaps: PruneResult[] = [];
    const { storage } = await make({}, vi.fn(), (result) => gaps.push(result));
    await storage.save(batch("b1", Date.now(), 3));

    vi.spyOn(storage["db"], "put").mockRejectedValue(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    await storage.save(batch("overflow", Date.now(), 7));

    expect(gaps.at(-1)).toMatchObject({ batches: 1, records: 7, reason: "quota" });
    await storage.close();
  });

  it("reports it when even the eviction fails, rather than throwing out of save", async () => {
    const { storage, handler } = await make();
    await storage.save(batch("b1"));

    vi.spyOn(storage["db"], "put").mockRejectedValueOnce(
      Object.assign(new Error("full"), { name: "QuotaExceededError" }),
    );
    vi.spyOn(storage["db"], "takeOldest").mockImplementation(() => {
      throw new Error("database is closing");
    });

    await expect(storage.save(batch("overflow"))).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("reports any other write failure as degraded, not as a quota problem", async () => {
    const { storage, handler } = await make();
    vi.spyOn(storage["db"], "put")
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
    vi.spyOn(storage["db"], "takeOldest").mockImplementation(() => {
      throw new Error("database is closing");
    });

    expect(await storage.take(10)).toEqual([]);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
  });

  it("counts zero rather than throwing when the database cannot answer", async () => {
    const { storage, handler } = await make();
    vi.spyOn(storage["db"], "count").mockImplementation(() => {
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

describe("IdbDriver", () => {
  // A fresh database name per test, because a store outlives the driver holding it.
  let counter = 0;
  const name = (): string => `uiobs-driver-${String(++counter)}`;

  // Stands in for a request that fails. fake-indexeddb has no way to make a real
  // one fail, and every driver method funnels its failure through onerror.
  //
  // Build it inside mockImplementationOnce, never as a mockReturnValueOnce
  // argument. The microtask below is queued the moment the request is built, and
  // one built at setup time fires while the test is still awaiting something
  // else, long before promisify has assigned onerror. Nothing then settles and
  // the test times out.
  const failingRequest = <T>(error: Error | null): IDBRequest<T> => {
    const request = { error, onsuccess: null, onerror: null } as unknown as IDBRequest<T>;
    queueMicrotask(() => {
      request.onerror?.call(request, new Event("error"));
    });
    return request;
  };

  // Writes a store the way an earlier release did, at the native version Dexie used.
  const openLegacy = (dbName: string): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 10);
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore("batches", { keyPath: "id" })
          .createIndex("createdAt", "createdAt");
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error("the legacy database would not open"));
      };
    });

  it("opens the database once and hands the same connection to every call", async () => {
    const driver = new IdbDriver(name());
    const open = vi.spyOn(indexedDB, "open");

    await driver.put(batch("b1"));
    await driver.put(batch("b2"));

    expect(open).toHaveBeenCalledTimes(1);
    expect(await driver.count()).toBe(2);
    await driver.close();
  });

  it("adopts a database left by an earlier release rather than recreating its store", async () => {
    // Dexie opened this database at ten times its declared version, so an
    // installation upgrading from it is at native version 10 with data in it.
    const dbName = name();
    const legacy = await openLegacy(dbName);
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction("batches", "readwrite");
      tx.objectStore("batches").put(batch("kept", 1000));
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(new Error("the legacy write failed"));
      };
    });
    legacy.close();

    const driver = new IdbDriver(dbName);

    expect((await driver.takeOldest(10)).map((b) => b.id)).toEqual(["kept"]);
    await driver.close();
  });

  it("rejects with the request error when a read fails", async () => {
    const driver = new IdbDriver(name());
    await driver.put(batch("b1"));

    vi.spyOn(IDBObjectStore.prototype, "count").mockImplementationOnce(() =>
      failingRequest<number>(new Error("database is closing")),
    );

    await expect(driver.count()).rejects.toThrow("database is closing");
    await driver.close();
  });

  it("rejects with a stand-in when a request fails carrying no error", async () => {
    const driver = new IdbDriver(name());
    await driver.put(batch("b1"));

    vi.spyOn(IDBObjectStore.prototype, "count").mockImplementationOnce(() =>
      failingRequest<number>(null),
    );

    await expect(driver.count()).rejects.toThrow("the IndexedDB request failed");
    await driver.close();
  });

  it("rejects when the database cannot be opened at all", async () => {
    vi.spyOn(indexedDB, "open").mockImplementationOnce(
      () => failingRequest<IDBDatabase>(new Error("blocked")) as unknown as IDBOpenDBRequest,
    );

    await expect(new IdbDriver(name()).count()).rejects.toThrow("blocked");
  });

  it("leaves an id it is not holding alone rather than storing it", async () => {
    const driver = new IdbDriver(name());
    await driver.bumpAttempts("never-stored", 3);

    expect(await driver.count()).toBe(0);
    await driver.close();
  });

  it("closes without opening a database it never touched", async () => {
    const open = vi.spyOn(indexedDB, "open");

    await new IdbDriver(name()).close();

    expect(open).not.toHaveBeenCalled();
  });
});

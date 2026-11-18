import { describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import { configure, createMemoryTransport, flush, getHealth, shutdown } from "../src/index";
import { requestPersistence } from "../src/storage/persistence";

/**
 * Stubs a storage manager whose persist call is the given function.
 * @param persist Function that answers the request.
 */
const stubPersist = (persist: () => Promise<boolean>): void => {
  vi.stubGlobal("navigator", { storage: { persist } });
};

const base = {
  endpoint: null,
  serviceName: "svc",
  identity: "memory",
  bus: { mode: "off" },
} as const;

describe("requestPersistence", () => {
  it("returns the browser's answer", async () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);

    stubPersist(() => Promise.resolve(true));
    expect(await requestPersistence(diagnostics)).toBe("granted");

    stubPersist(() => Promise.resolve(false));
    expect(await requestPersistence(diagnostics)).toBe("denied");
  });

  it("reports a rejected request and gives denied", async () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);
    stubPersist(() => Promise.reject(new Error("blocked")));

    expect(await requestPersistence(diagnostics)).toBe("denied");
    expect(diagnostics.snapshot()["storage.unavailable"]).toBe(1);
  });

  it("returns unsupported without persist() or without a navigator", async () => {
    const diagnostics = new Diagnostics(vi.fn(), 0);

    vi.stubGlobal("navigator", { storage: {} });
    expect(await requestPersistence(diagnostics)).toBe("unsupported");

    vi.stubGlobal("navigator", undefined);
    expect(await requestPersistence(diagnostics)).toBe("unsupported");
  });
});

describe("storage.requestPersistent", () => {
  it("asks for persistent storage and reports each state in getHealth()", async () => {
    let answer!: (granted: boolean) => void;
    const persist = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    stubPersist(persist);
    configure({
      ...base,
      storage: { backend: "localstorage", requestPersistent: true },
      transport: createMemoryTransport().transport,
    });
    await flush();

    expect(persist).toHaveBeenCalledTimes(1);
    expect((await getHealth()).storagePersistence).toBe("pending");

    answer(true);
    await vi.waitFor(async () => {
      expect((await getHealth()).storagePersistence).toBe("granted");
    });
  });

  it("does not ask for memory storage or without the option", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    stubPersist(persist);
    const transport = createMemoryTransport().transport;

    configure({ ...base, storage: { backend: "memory", requestPersistent: true }, transport });
    await flush();
    expect((await getHealth()).storagePersistence).toBe("off");
    await shutdown();

    configure({ ...base, storage: { backend: "localstorage" }, transport });
    await flush();
    expect(persist).not.toHaveBeenCalled();
  });
});

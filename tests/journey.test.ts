import { describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import { JourneyEngine, type Journey, type JourneyOptions } from "../src/core/journey";
import { memoryStores } from "../src/utils/identity";

// This file has its own copy of both literals. A test that reads the constant that it checks cannot
// find a typo in that constant.
const STORAGE_KEY = "ui-observability.journey";
const URL_PARAM = "__uiobs_journey";

const OPTIONS: JourneyOptions = {
  maxAgeMs: 30 * 60 * 1000,
  endOnOwnerClose: false,
  urlParam: URL_PARAM,
};

function makeEngine(overrides: Partial<JourneyOptions> = {}, contextId = "ctx-1") {
  const handler = vi.fn();
  // No throttle. `journey.expired` covers three different cases. In one tick, the default throttle
  // hides each case after the first.
  const diagnostics = new Diagnostics(handler, 0);
  const onLocalChange = vi.fn();
  const engine = new JourneyEngine(
    { ...OPTIONS, ...overrides },
    diagnostics,
    contextId,
    onLocalChange,
  );
  return { diagnostics, engine, handler, onLocalChange };
}

/**
 * Encodes a token as the library does. This encoder is separate from the encoder of the library. A
 * change to either one then causes a failure here.
 */
function tokenFor(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A token for a journey that started `ageMs` ago. */
const tokenAged = (ageMs: number, name = "checkout", id = "j-1"): string =>
  tokenFor({ i: id, n: name, s: Date.now() - ageMs });

/** Point `location` at a URL, since happy-dom's own is not writable. */
const atUrl = (href: string): void => {
  vi.stubGlobal("location", { href });
};

/**
 * A sessionStorage with one named method that throws. The other methods work.
 *
 * The test replaces the whole global. It does not spy on it. The Storage of happy-dom is a Proxy.
 * Its `deleteProperty` trap refuses each key that is not a stored item. A spy on it stays after
 * `restoreMocks`. It stays around the real method for each later test.
 */
function storageThatThrowsOn(
  method: "getItem" | "setItem" | "removeItem",
): Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      if (method === "getItem") {
        throw new Error("storage is blocked");
      }
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (method === "setItem") {
        throw new Error("quota exceeded");
      }
      store.set(key, value);
    },
    removeItem(key: string): void {
      if (method === "removeItem") {
        throw new Error("blocked");
      }
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}

const stored = (): unknown => {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
};

describe("start", () => {
  it("puts a journey in force, announces it, and persists it whole", () => {
    const { engine, onLocalChange } = makeEngine();

    const journey = engine.start("checkout");

    expect(journey.name).toBe("checkout");
    expect(journey.ownerContextId).toBe("ctx-1");
    expect(journey.parentId).toBeUndefined();
    expect(engine.current()).toEqual(journey);
    expect(onLocalChange).toHaveBeenCalledWith(journey);
    expect(stored()).toEqual({ ...journey, parentId: undefined });
  });

  it("links a child journey to the one it replaced, when asked", () => {
    const { engine } = makeEngine();
    const parent = engine.start("checkout");

    const child = engine.start("payment", { parent: true });

    expect(child.parentId).toBe(parent.id);
    expect(child.id).not.toBe(parent.id);
  });

  it("has no parent to link when nothing was running", () => {
    const { engine } = makeEngine();

    expect(engine.start("payment", { parent: true }).parentId).toBeUndefined();
  });

  it("adopts an id minted elsewhere, for correlating with a system upstream", () => {
    const { engine } = makeEngine();

    expect(engine.start("checkout", { id: "from-upstream" }).id).toBe("from-upstream");
  });

  it("keeps an id of 64 characters, which still fits in a journey token", () => {
    const { engine } = makeEngine();
    const id = "a".repeat(64);
    engine.start("x".repeat(64), { id });

    expect(engine.current()?.id).toBe(id);
    expect(engine.getToken()).toBeDefined();
  });

  it("reports an id that is empty, too long or not a string, and makes a new id", () => {
    const { engine, handler } = makeEngine();
    const ids = ["", "a".repeat(65), 42 as unknown as string];

    const started = ids.map((id) => engine.start("checkout", { id }).id);

    expect(started.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)).toBe(
      true,
    );
    expect(started).not.toContain("");
    expect(handler.mock.calls.map(([event]) => (event as { code: string }).code)).toEqual([
      "config.invalid",
      "config.invalid",
      "config.invalid",
    ]);
  });

  it("replaces the previous journey rather than nesting inside it", () => {
    const { engine } = makeEngine();
    engine.start("checkout");

    const second = engine.start("research");

    expect(engine.current()).toEqual(second);
    expect(second.parentId).toBeUndefined();
  });
});

describe("end", () => {
  it("clears the journey, announces the change and forgets what was persisted", () => {
    const { engine, onLocalChange } = makeEngine();
    engine.start("checkout");
    onLocalChange.mockClear();

    engine.end();

    expect(engine.current()).toBeNull();
    expect(onLocalChange).toHaveBeenCalledWith(null);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("says nothing at all when there is no journey to end", () => {
    // An end with no journey is not an error. An announcement tells each other window to drop a
    // journey. This window never had that journey.
    const { engine, onLocalChange } = makeEngine();

    engine.end();

    expect(onLocalChange).not.toHaveBeenCalled();
  });
});

describe("applyRemote", () => {
  it("takes a journey from another context without re-announcing it", () => {
    // The rule that stops two windows ping-ponging one change between them
    // until the control plane saturates.
    const { engine, onLocalChange } = makeEngine();
    const remote: Journey = {
      id: "j-remote",
      name: "from elsewhere",
      startedAt: Date.now(),
      ownerContextId: "ctx-2",
    };

    engine.applyRemote(remote);

    expect(engine.current()).toEqual(remote);
    expect(onLocalChange).not.toHaveBeenCalled();
  });

  it("ignores an echo of the journey already in force", () => {
    // An echo that restarts the expiry timer keeps a journey alive. The journey then stays alive
    // while any window repeats the echo.
    const { engine } = makeEngine();
    const started = engine.start("checkout");

    engine.applyRemote({ ...started, name: "renamed" });

    expect(engine.current()?.name).toBe("checkout");
  });

  it("accepts a different journey over the one in force", () => {
    const { engine } = makeEngine();
    engine.start("checkout");

    engine.applyRemote({
      id: "j-other",
      name: "other",
      startedAt: Date.now(),
      ownerContextId: "ctx-2",
    });

    expect(engine.current()?.id).toBe("j-other");
  });

  it("accepts the end of a journey from another context", () => {
    const { engine, onLocalChange } = makeEngine();
    engine.start("checkout");
    onLocalChange.mockClear();

    engine.applyRemote(null);

    expect(engine.current()).toBeNull();
    expect(onLocalChange).not.toHaveBeenCalled();
  });

  it("takes a journey when this context is in none", () => {
    const { engine } = makeEngine();

    engine.applyRemote({
      id: "j-1",
      name: "n",
      startedAt: Date.now(),
      ownerContextId: "ctx-2",
    });

    expect(engine.current()?.id).toBe("j-1");
  });
});

describe("getToken", () => {
  it("issues nothing when there is no journey to hand over", () => {
    expect(makeEngine().engine.getToken()).toBeUndefined();
  });

  it("round-trips through adopt, which is the only contract the token has", () => {
    const { engine } = makeEngine();
    const started = engine.start("order-amend");
    const token = engine.getToken();

    const { engine: receiver } = makeEngine();
    expect(token).toBeDefined();
    expect(receiver.adopt(token!, "url")).toBe(true);
    expect(receiver.current()?.id).toBe(started.id);
    expect(receiver.current()?.name).toBe("order-amend");
  });

  it("carries no parent or owner, since a query string cannot absorb a chain", () => {
    const { engine } = makeEngine();
    engine.start("checkout");
    engine.start("payment", { parent: true });
    const token = engine.getToken();

    const { engine: receiver } = makeEngine();
    receiver.adopt(token!, "url");

    expect(receiver.current()?.parentId).toBeUndefined();
    expect(receiver.current()?.ownerContextId).toBe("");
  });

  it("produces a token safe to drop into a query string unencoded", () => {
    const { engine } = makeEngine();
    engine.start("naïve ünicode ✓");

    expect(engine.getToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses to issue a token past the size cap", () => {
    // This check is a limit on the query-string budget. It is not input validation. startJourney()
    // limits its id, but a journey from a bus peer has no length check on its id.
    const { diagnostics, engine } = makeEngine();
    engine.applyRemote({
      id: "x".repeat(300),
      name: "checkout",
      startedAt: Date.now(),
      parentId: undefined,
      ownerContextId: "ctx-2",
    });

    expect(engine.getToken()).toBeUndefined();
    expect(diagnostics.snapshot()["journey.token_too_large"]).toBe(1);
  });

  it("truncates a long name into the token and nowhere else", () => {
    const { engine } = makeEngine();
    const started = engine.start("n".repeat(200));

    const { engine: receiver } = makeEngine();
    receiver.adopt(engine.getToken()!, "url");

    expect(started.name).toHaveLength(200);
    expect(receiver.current()?.name).toHaveLength(64);
  });
});

describe("adopt", () => {
  it("joins the journey a token describes and reports where it came from", () => {
    const { diagnostics, engine, onLocalChange } = makeEngine();

    expect(engine.adopt(tokenAged(1000), "url")).toBe(true);
    expect(engine.current()?.id).toBe("j-1");
    expect(diagnostics.snapshot()["journey.adopted"]).toBe(1);
    // A seed at boot does not broadcast. Each window in that flow gets its own seed. A broadcast
    // replaces the seeds of the other windows.
    expect(onLocalChange).not.toHaveBeenCalled();
  });

  it("announces a journey handed over deliberately", () => {
    const { engine, onLocalChange } = makeEngine();

    engine.adopt(tokenAged(1000), "manual", true);

    expect(onLocalChange).toHaveBeenCalledWith(expect.objectContaining({ id: "j-1" }));
  });

  it("discards a seeded journey older than maxAgeMs", () => {
    const { diagnostics, engine } = makeEngine({ maxAgeMs: 1000 });

    expect(engine.adopt(tokenAged(5000), "url")).toBe(false);
    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["journey.expired"]).toBe(1);
  });

  it("reports and refuses a token that is not base64 at all", () => {
    const { diagnostics, engine } = makeEngine();

    expect(engine.adopt("!!!!", "url")).toBe(false);
    expect(diagnostics.snapshot()["config.invalid"]).toBe(1);
  });

  it.each([
    ["a number", tokenFor(123)],
    ["null", tokenFor(null)],
    ["no id", tokenFor({ n: "checkout", s: Date.now() })],
    ["an empty id", tokenFor({ i: "", n: "checkout", s: Date.now() })],
    ["no name", tokenFor({ i: "j-1", s: Date.now() })],
    ["a non-string name", tokenFor({ i: "j-1", n: 42, s: Date.now() })],
  ])("refuses a token encoding %s", (_label, token) => {
    expect(makeEngine().engine.adopt(token, "url")).toBe(false);
  });

  it("treats a token with no usable start time as starting now", () => {
    // An age that is not accurate costs less than the loss of a journey that is probably real. All
    // correlation uses the id.
    const { engine } = makeEngine({ maxAgeMs: 1000 });

    expect(engine.adopt(tokenFor({ i: "j-1", n: "checkout" }), "url")).toBe(true);
    expect(engine.current()?.startedAt).toBeGreaterThan(0);
  });
});

describe("bootstrap", () => {
  it("prefers a token in the URL, because it is the most recent thing that happened", async () => {
    atUrl(`https://app.test/orders?${URL_PARAM}=${tokenAged(1000)}`);
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: "j-stored", name: "stored", startedAt: Date.now() }),
    );
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()?.id).toBe("j-1");
  });

  it("removes the token from the URL after it adopts it, and keeps the rest of the URL", async () => {
    // A copied link with the token starts the same journey in another session.
    atUrl(`https://app.test/orders?view=grid&${URL_PARAM}=${tokenAged(1000)}#row-4`);
    const replaceState = vi.fn();
    vi.stubGlobal("history", { state: { page: 1 }, replaceState });
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()?.id).toBe("j-1");
    expect(replaceState).toHaveBeenCalledWith(
      { page: 1 },
      "",
      "https://app.test/orders?view=grid#row-4",
    );
  });

  it("keeps the token in the URL when it does not adopt it", async () => {
    atUrl(`https://app.test/orders?${URL_PARAM}=${tokenAged(50_000)}`);
    const replaceState = vi.fn();
    vi.stubGlobal("history", { state: null, replaceState });
    const { engine } = makeEngine({ maxAgeMs: 10_000 });

    await engine.bootstrap();

    expect(replaceState).not.toHaveBeenCalled();
  });

  it("keeps the journey and reports when the URL cannot change", async () => {
    atUrl(`https://app.test/orders?${URL_PARAM}=${tokenAged(1000)}`);
    vi.stubGlobal("history", {
      state: null,
      replaceState: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    const { diagnostics, engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()?.id).toBe("j-1");
    expect(diagnostics.snapshot()["platform.api_blocked"]).toBe(1);
  });

  it("falls through to the persisted journey when the URL token is too old", async () => {
    atUrl(`https://app.test/orders?${URL_PARAM}=${tokenAged(50_000)}`);
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: "j-stored",
        name: "stored",
        startedAt: Date.now(),
        ownerContextId: "ctx-1",
      }),
    );
    const { diagnostics, engine } = makeEngine({ maxAgeMs: 10_000 });

    await engine.bootstrap();

    expect(engine.current()?.id).toBe("j-stored");
    expect(diagnostics.snapshot()["journey.adopted"]).toBe(1);
  });

  it("resumes a journey persisted before a reload, keeping its parent link", async () => {
    // The engine keeps the whole journey, not the lossy token. A reload that drops the parent link
    // can never apply endOnOwnerClose again.
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: "j-stored",
        name: "stored",
        startedAt: Date.now(),
        parentId: "j-parent",
        ownerContextId: "ctx-9",
      }),
    );
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()?.parentId).toBe("j-parent");
    expect(engine.current()?.ownerContextId).toBe("ctx-9");
  });

  it("treats a persisted journey with no owner as one it does not own", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: "j-stored", name: "stored", startedAt: Date.now() }),
    );
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()?.ownerContextId).toBe("");
  });

  it("discards and clears a persisted journey that is too old", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: "j-stored",
        name: "stored",
        startedAt: Date.now() - 50_000,
      }),
    );
    const { diagnostics, engine } = makeEngine({ maxAgeMs: 10_000 });

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(diagnostics.snapshot()["journey.expired"]).toBe(1);
  });

  it("reports storage holding something that is not JSON, and starts in no journey", async () => {
    sessionStorage.setItem(STORAGE_KEY, "{ not json");
    const { diagnostics, engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["storage.degraded"]).toBe(1);
  });

  it.each([
    ["a bare number", "123"],
    ["null", "null"],
    ["no id", JSON.stringify({ name: "n", startedAt: 1 })],
    ["an empty id", JSON.stringify({ id: "", name: "n", startedAt: 1 })],
    ["a non-string name", JSON.stringify({ id: "j", name: 7, startedAt: 1 })],
    ["no start time", JSON.stringify({ id: "j", name: "n" })],
    ["a non-numeric start time", JSON.stringify({ id: "j", name: "n", startedAt: "today" })],
    // Any code on the origin can write this key. A start time that is not finite breaks each
    // comparison. An age from Infinity is never greater than maxAgeMs. Such a journey never
    // expires.
    ["an infinite start time", '{"id":"j","name":"n","startedAt":1e999}'],
  ])("refuses a persisted journey with %s", async (_label, raw) => {
    sessionStorage.setItem(STORAGE_KEY, raw);
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
  });

  it("reports unreadable storage rather than failing to boot", async () => {
    vi.stubGlobal("sessionStorage", storageThatThrowsOn("getItem"));
    const { diagnostics, engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["storage.unavailable"]).toBe(1);
  });

  it("starts in no journey when nothing seeded one", async () => {
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
  });
});

describe("reading the URL", () => {
  it("finds nothing when the seeding parameter is absent", async () => {
    atUrl("https://app.test/orders?other=1");
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
  });

  it("survives a host with no location at all, which is what rendering on a server is", async () => {
    vi.stubGlobal("location", undefined);
    const { diagnostics, engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["config.invalid"]).toBeUndefined();
  });

  it("reports a location it is not allowed to read", async () => {
    // A sandboxed frame throws on the read rather than returning nothing.
    vi.stubGlobal("location", {
      get href(): string {
        throw new Error("blocked by the sandbox");
      },
    });
    const { diagnostics, engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["config.invalid"]).toBe(1);
  });
});

describe("reading OpenFin customData", () => {
  it("adopts a token a platform provider seeded the window with", async () => {
    // A window a provider creates has no URL of its own to carry a token.
    const token = tokenAged(1000);
    vi.stubGlobal("fin", {
      me: {
        getOptions: () => Promise.resolve({ customData: { uiObsJourney: token } }),
      },
    });
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()?.id).toBe("j-1");
  });

  it("gives up on a getOptions that never settles", async () => {
    // Without this, a stalled bridge keeps bootstrap pending. The init() of the runtime then stays
    // pending too. Records stay in the boot buffer until the buffer evicts them.
    vi.useFakeTimers();
    vi.stubGlobal("fin", { me: { getOptions: () => new Promise(() => undefined) } });
    const { engine, handler } = makeEngine();

    const settled = engine.bootstrap();
    await vi.advanceTimersByTimeAsync(2001);
    await settled;

    expect(engine.current()).toBeNull();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "openfin.unavailable" }));
  });

  it("calls getOptions with fin.me as its receiver, since it is a method that reads this", async () => {
    const me = {
      seeded: tokenAged(1000),
      getOptions(this: { seeded: string }) {
        return Promise.resolve({ customData: { uiObsJourney: this.seeded } });
      },
    };
    vi.stubGlobal("fin", { me });
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()?.id).toBe("j-1");
  });

  it.each([
    ["there is no fin at all", undefined],
    ["fin exposes no me, as the Core Web adapter may not", {}],
    ["me exposes no getOptions", { me: {} }],
  ])("finds nothing when %s", async (_label, fin) => {
    vi.stubGlobal("fin", fin);
    const { diagnostics, engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["openfin.unavailable"]).toBeUndefined();
  });

  it("reports a getOptions that rejects, rather than leaving an unhandled rejection", async () => {
    vi.stubGlobal("fin", {
      me: { getOptions: () => Promise.reject(new Error("runtime is gone")) },
    });
    const { diagnostics, engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["openfin.unavailable"]).toBe(1);
  });

  it.each([
    ["the window carries no customData", {}],
    ["customData carries no token", { customData: {} }],
    ["the token is not a string", { customData: { uiObsJourney: 42 } }],
  ])("finds nothing when %s", async (_label, options) => {
    vi.stubGlobal("fin", {
      me: { getOptions: () => Promise.resolve(options) },
    });
    const { engine } = makeEngine();

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
  });
});

describe("expiry", () => {
  it("ends a journey that reaches maxAgeMs, in memory and in storage", async () => {
    vi.useFakeTimers();
    const { diagnostics, engine } = makeEngine({ maxAgeMs: 1000 });
    engine.start("checkout");

    await vi.advanceTimersByTimeAsync(1001);

    expect(engine.current()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(diagnostics.snapshot()["journey.expired"]).toBe(1);
  });

  it("measures the deadline from when the journey started, not from when it arrived", async () => {
    // A journey adopted after twenty of its thirty minutes has ten left, not
    // thirty. Every context computes the same deadline from the same start
    // time, which is why an expiry is never announced.
    vi.useFakeTimers();
    const { engine } = makeEngine({ maxAgeMs: 1000 });
    engine.applyRemote({
      id: "j-1",
      name: "checkout",
      startedAt: Date.now() - 900,
      ownerContextId: "ctx-2",
    });

    await vi.advanceTimersByTimeAsync(101);

    expect(engine.current()).toBeNull();
  });

  it("expires immediately on a journey that arrives already past its age", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine({ maxAgeMs: 1000 });

    engine.applyRemote({
      id: "j-1",
      name: "checkout",
      startedAt: Date.now() - 500_000,
      ownerContextId: "ctx-2",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(engine.current()).toBeNull();
  });

  it("does not let a replaced journey's timer end the one that replaced it", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine({ maxAgeMs: 1000 });
    engine.start("first");

    await vi.advanceTimersByTimeAsync(900);
    const second = engine.start("second");
    await vi.advanceTimersByTimeAsync(200);

    expect(engine.current()?.id).toBe(second.id);
  });

  it("stops a pending timer on destroy, so a torn-down runtime schedules nothing", async () => {
    vi.useFakeTimers();
    const { diagnostics, engine } = makeEngine({ maxAgeMs: 1000 });
    engine.start("checkout");

    engine.destroy();
    await vi.advanceTimersByTimeAsync(2000);

    expect(diagnostics.snapshot()["journey.expired"]).toBeUndefined();
  });

  it("tolerates a destroy with no timer pending", () => {
    const { engine } = makeEngine();

    expect(() => {
      engine.destroy();
    }).not.toThrow();
  });
});

describe("the expiry timer handle", () => {
  it("releases a Node-style handle, so a pending journey cannot hold a process open", () => {
    // The default is half an hour. Under server-side rendering or in a test runner, that one timer
    // keeps the process alive until it fires.
    const unref = vi.fn();
    vi.stubGlobal("setTimeout", () => ({ unref }));
    vi.stubGlobal("clearTimeout", vi.fn());
    const { engine } = makeEngine();

    engine.start("checkout");

    expect(unref).toHaveBeenCalledOnce();
  });

  it("accepts a browser's numeric handle, which has no unref and needs none", () => {
    vi.stubGlobal("setTimeout", () => 0);
    vi.stubGlobal("clearTimeout", vi.fn());
    const { engine } = makeEngine();

    // Zero is a legal handle. A truth test on it does not clear that timer when a new journey
    // replaces the old one.
    expect(() => {
      engine.start("checkout");
      engine.start("second");
    }).not.toThrow();
  });

  it("accepts an object handle with no unref on it", () => {
    vi.stubGlobal("setTimeout", () => ({}));
    vi.stubGlobal("clearTimeout", vi.fn());
    const { engine } = makeEngine();

    expect(() => {
      engine.start("checkout");
    }).not.toThrow();
  });
});

describe("ownerClosed", () => {
  it("does nothing while endOnOwnerClose is off, which is the default", () => {
    // The product decides if a journey continues after its opener closes. A journey for a trade
    // ticket ends with the ticket. A journey for a research task does not end.
    const { engine } = makeEngine();
    engine.start("checkout");

    engine.ownerClosed("ctx-1");

    expect(engine.current()).not.toBeNull();
  });

  it("ends the journey when its own context closes", () => {
    const { engine, onLocalChange } = makeEngine({ endOnOwnerClose: true });
    engine.start("checkout");
    onLocalChange.mockClear();

    engine.ownerClosed("ctx-1");

    expect(engine.current()).toBeNull();
    expect(onLocalChange).toHaveBeenCalledWith(null);
  });

  it("ignores a context that did not start this journey", () => {
    const { engine } = makeEngine({ endOnOwnerClose: true });
    engine.start("checkout");

    engine.ownerClosed("ctx-elsewhere");

    expect(engine.current()).not.toBeNull();
  });

  it("ignores a closing context while in no journey", () => {
    const { engine } = makeEngine({ endOnOwnerClose: true });

    engine.ownerClosed("ctx-1");

    expect(engine.current()).toBeNull();
  });
});

describe("storage that cannot be written", () => {
  it("keeps the journey in memory when persisting it fails", () => {
    // Storage costs continuity across a reload, never logging.
    vi.stubGlobal("sessionStorage", storageThatThrowsOn("setItem"));
    const { diagnostics, engine } = makeEngine();

    const journey = engine.start("checkout");

    expect(engine.current()).toEqual(journey);
    expect(diagnostics.snapshot()["storage.unavailable"]).toBe(1);
  });

  it("reports storage that cannot be cleared", () => {
    vi.stubGlobal("sessionStorage", storageThatThrowsOn("removeItem"));
    const { diagnostics, engine } = makeEngine();
    engine.start("checkout");

    engine.end();

    expect(engine.current()).toBeNull();
    expect(diagnostics.snapshot()["storage.unavailable"]).toBe(1);
  });

  it("reports storage it cannot clear after an expired journey is discarded", async () => {
    vi.stubGlobal("sessionStorage", storageThatThrowsOn("removeItem"));
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: "j", name: "n", startedAt: Date.now() - 50_000 }),
    );
    const { diagnostics, engine } = makeEngine({ maxAgeMs: 10_000 });

    await engine.bootstrap();

    expect(diagnostics.snapshot()["storage.unavailable"]).toBe(1);
  });
});

describe("JourneyEngine with memory identity stores", () => {
  it("does not write the journey to sessionStorage", () => {
    const engine = new JourneyEngine(
      OPTIONS,
      new Diagnostics(vi.fn(), 0),
      "ctx-1",
      vi.fn(),
      memoryStores(),
    );

    engine.start("checkout");

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps the journey in the memory store and removes it on end", () => {
    const stores = memoryStores();
    const diagnostics = new Diagnostics(vi.fn(), 0);
    const engine = new JourneyEngine(OPTIONS, diagnostics, "ctx-1", vi.fn(), stores);

    engine.start("checkout");
    expect(stores.session().getItem(STORAGE_KEY)).not.toBeNull();

    engine.end();
    expect(stores.session().getItem(STORAGE_KEY)).toBeNull();
  });

  it("does not resume a journey that sessionStorage holds", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: "j-1", name: "checkout", startedAt: Date.now(), ownerContextId: "c" }),
    );
    const engine = new JourneyEngine(
      OPTIONS,
      new Diagnostics(vi.fn(), 0),
      "ctx-1",
      vi.fn(),
      memoryStores(),
    );

    await engine.bootstrap();

    expect(engine.current()).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { LogBatch } from "../src/models/batch";
import type { LogRecord } from "../src/models/log-record";
import { MemoryStorage } from "../src/storage/memory-storage";
import { TransportError } from "../src/transport/errors";
import type { HttpTransport } from "../src/transport/http-transport";
import { RetryEngine } from "../src/transport/retry-engine";

const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 1000;
const IDLE_DELAY_MS = 500;
const MAX_ATTEMPTS = 3;
const SERVER_MAX_BYTES = 65536;

const limits = { maxBatches: 100, maxAgeMs: 60_000, maxAttempts: MAX_ATTEMPTS };

const config = resolveConfig(
  {
    endpoint: "https://x/v1/logs",
    serviceName: "svc",
    retry: { baseDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS, idleDelayMs: IDLE_DELAY_MS },
    storage: limits,
  },
  new Diagnostics(vi.fn(), 0),
);

const record = (body: string): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes: {},
  resource: { "service.name": "svc" },
});

const batch = (id: string, { attempts = 0, records = 1 } = {}): LogBatch => ({
  id,
  createdAt: Date.now(),
  attempts,
  records: Array.from({ length: records }, (_unused, index) => record(`${id}-${String(index)}`)),
});

type Send = (batch: LogBatch) => Promise<void>;

/** What a stubbed lock manager hands back: a grant, or null for one held elsewhere. */
type LockCallback = (lock: { name: string } | null) => Promise<unknown>;

/** A real MemoryStorage, a stubbed transport, and an engine wired to both. */
const makeEngine = (options: { send?: Send; batchesPerDrain?: number } = {}) => {
  const storage = new MemoryStorage(limits);
  const send = vi.fn<Send>(options.send ?? (() => Promise.resolve()));
  const handler = vi.fn<(event: DiagnosticEvent) => void>();
  const engine = new RetryEngine(
    storage,
    { send } as unknown as HttpTransport,
    new Diagnostics(handler, 0),
    config,
    options.batchesPerDrain ?? 10,
  );

  return { engine, storage, send, handler };
};

/** A promise resolved by the test, so a drain can be held mid-send. */
const gate = () => {
  // The executor runs synchronously, so `open` is the real resolver by the time
  // this returns.
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
};

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RetryEngine delivery", () => {
  it("sends a stored batch and removes it", async () => {
    const { engine, storage, send } = makeEngine();
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(await storage.count()).toBe(0);
    engine.stop();
  });

  it("drops a permanently rejected batch instead of blocking the ones behind it", async () => {
    const { engine, storage, send } = makeEngine({
      send: (sent) =>
        sent.id === "poison"
          ? Promise.reject(new TransportError("permanent", "400", 400))
          : Promise.resolve(),
    });
    await storage.save(batch("poison"));
    await storage.save(batch("good"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(send).toHaveBeenCalledTimes(2);
    expect(await storage.count()).toBe(0);
    engine.stop();
  });

  it("dead-letters a batch that has exhausted maxAttempts, and carries on", async () => {
    const { engine, storage, send, handler } = makeEngine();
    await storage.save(batch("stuck", { attempts: MAX_ATTEMPTS }));
    await storage.save(batch("fresh"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(await storage.count()).toBe(0);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "storage.dead_lettered" }),
    );
    engine.stop();
  });

  it("comes straight back when a tick fills its batch budget", async () => {
    const { engine, storage, send } = makeEngine({ batchesPerDrain: 1 });
    await storage.save(batch("a"));
    await storage.save(batch("b"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);
    // One millisecond, not zero: fake timers push a zero-delay timer armed
    // during a tick to the next millisecond, to stay out of an infinite loop.
    await tick(1);

    expect(send).toHaveBeenCalledTimes(2);
    expect(await storage.count()).toBe(0);
    engine.stop();
  });

  it("takes twenty batches a tick when the caller names no budget", async () => {
    const storage = new MemoryStorage(limits);
    const take = vi.spyOn(storage, "take");
    const send = vi.fn<Send>(() => Promise.resolve());
    const engine = new RetryEngine(
      storage,
      { send } as unknown as HttpTransport,
      new Diagnostics(vi.fn(), 0),
      config,
    );

    engine.start();
    await tick(IDLE_DELAY_MS);

    // The literal, not the constant it checks: importing it would pass on a typo.
    expect(take).toHaveBeenCalledWith(20);
    engine.stop();
  });

  it("keeps looking on the idle delay while the queue is empty", async () => {
    const { engine, storage } = makeEngine();
    const take = vi.spyOn(storage, "take");

    engine.start();
    await tick(IDLE_DELAY_MS * 2);

    // An empty queue that advanced the attempt counter would back off to a
    // shorter, jittered delay and look here more often than twice.
    expect(take).toHaveBeenCalledTimes(2);
    engine.stop();
  });

  it("stops the loop when the engine is stopped between batches", async () => {
    const { engine, storage, send } = makeEngine();
    // Wired after construction, so the stub can reach the engine it belongs to.
    send.mockImplementation(() => {
      engine.stop();
      return Promise.resolve();
    });
    await storage.save(batch("a"));
    await storage.save(batch("b"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(await storage.count()).toBe(1);
  });
});

describe("RetryEngine failure handling", () => {
  it("counts an attempt and backs off on a transient failure", async () => {
    const { engine, storage, send } = makeEngine({
      send: () => Promise.reject(new TransportError("transient", "500", 500)),
    });
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(send).toHaveBeenCalledOnce();
    expect((await storage.take(1))[0].attempts).toBe(1);
    engine.stop();
  });

  it("treats an unclassified throw as transient", async () => {
    const { engine, storage } = makeEngine({ send: () => Promise.reject(new Error("nope")) });
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect((await storage.take(1))[0].attempts).toBe(1);
    engine.stop();
  });

  it("waits exactly as long as a throttled server asked for", async () => {
    const retryAfterMs = 700;
    let throttled = true;
    const { engine, storage, send } = makeEngine({
      send: () => {
        if (throttled) {
          throttled = false;
          return Promise.reject(new TransportError("throttled", "429", 429, retryAfterMs));
        }
        return Promise.resolve();
      },
    });
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);
    expect(send).toHaveBeenCalledOnce();

    // A jittered backoff is at most `baseDelayMs * 2`, so a second send before
    // this point would mean Retry-After was ignored.
    await tick(retryAfterMs - 1);
    expect(send).toHaveBeenCalledOnce();

    await tick(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await storage.count()).toBe(0);
    engine.stop();
  });

  it("does not count an attempt against a batch it never sent", async () => {
    const { engine, storage } = makeEngine({
      send: () => Promise.reject(new TransportError("offline", "no connection")),
    });
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    const [waiting] = await storage.take(1);
    expect(waiting.attempts).toBe(0);
    engine.stop();
  });

  it("reports and backs off when the store itself throws", async () => {
    const { engine, storage, handler } = makeEngine();
    vi.spyOn(storage, "take").mockRejectedValue(new Error("store gone"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "storage.degraded" }));
    engine.stop();
  });
});

describe("RetryEngine splitting", () => {
  it("splits a batch the server called too large, rather than dropping it", async () => {
    const refused = () => new TransportError("too_large", "413", 413, undefined, SERVER_MAX_BYTES);
    const { engine, storage, handler } = makeEngine({
      send: (sent) => (sent.records.length > 1 ? Promise.reject(refused()) : Promise.resolve()),
    });
    await storage.save(batch("big", { records: 4 }));

    engine.start();
    engine.nudge();
    await tick(2000);

    expect(await storage.count()).toBe(0);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "transport.batch_split",
        detail: expect.objectContaining({ serverMaxBytes: SERVER_MAX_BYTES }),
      }),
    );
    engine.stop();
  });

  it("drops the one record no split can rescue, and says what it was", async () => {
    const { engine, storage, handler } = makeEngine({
      send: () => Promise.reject(new TransportError("too_large", "413", 413)),
    });
    await storage.save(batch("one", { records: 1 }));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(await storage.count()).toBe(0);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "transport.dropped_permanent",
        detail: { batchId: "one", bodies: ["one-0"] },
      }),
    );
    engine.stop();
  });
});

describe("RetryEngine connectivity", () => {
  it("skips the drain while the browser reports itself offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { engine, storage, send } = makeEngine();
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(send).not.toHaveBeenCalled();
    expect(await storage.count()).toBe(1);
    engine.stop();
  });

  it("drains in a host with no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);
    const { engine, storage, send } = makeEngine();
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    expect(send).toHaveBeenCalledOnce();
    engine.stop();
  });

  it("starts and stops in a host with no event target", async () => {
    vi.stubGlobal("addEventListener", undefined);
    vi.stubGlobal("removeEventListener", undefined);
    const { engine, storage, send } = makeEngine();
    await storage.save(batch("a"));

    engine.start();
    await tick(IDLE_DELAY_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(() => {
      engine.stop();
    }).not.toThrow();
  });

  it("replaces its timer on every online event rather than chaining them", () => {
    const { engine } = makeEngine();
    // Counted at the source. `vi.getTimerCount()` is origin-wide and answers for
    // the environment as well as for this engine.
    const arm = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");

    engine.start();
    for (let i = 0; i < 20; i++) {
      dispatchEvent(new Event("online"));
    }

    // One arm on start, then an arm and a clear per event. A chain would arm 21
    // times and clear none.
    expect(arm).toHaveBeenCalledTimes(21);
    expect(clear).toHaveBeenCalledTimes(20);

    engine.stop();
    expect(clear).toHaveBeenCalledTimes(21);
  });
});

describe("RetryEngine reentrancy", () => {
  it("comes back after losing the drain lock, instead of retiring itself", async () => {
    let held = true;
    vi.stubGlobal("navigator", {
      locks: {
        request: (name: string, _options: unknown, callback: LockCallback) =>
          callback(held ? null : { name }),
      },
    });
    const { engine, storage, send } = makeEngine();
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);
    expect(send).not.toHaveBeenCalled();

    held = false;
    await tick(IDLE_DELAY_MS);

    expect(send).toHaveBeenCalledOnce();
    engine.stop();
  });

  it("ignores a timer that fires while a drain is still in flight", async () => {
    const held = gate();
    const { engine, storage, send } = makeEngine({ send: () => held.promise });
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);
    expect(send).toHaveBeenCalledOnce();

    // The online handler arms a timer of its own: the one path that fires
    // during a drain.
    dispatchEvent(new Event("online"));
    await tick(0);
    expect(send).toHaveBeenCalledOnce();

    held.open();
    await tick(0);

    expect(await storage.count()).toBe(0);
    engine.stop();
  });

  it("arms nothing on a nudge during a drain", async () => {
    const held = gate();
    const { engine, storage } = makeEngine({ send: () => held.promise });
    await storage.save(batch("a"));

    engine.start();
    engine.nudge();
    await tick(BASE_DELAY_MS);

    engine.nudge();
    expect(vi.getTimerCount()).toBe(0);

    held.open();
    await tick(0);
    engine.stop();
  });

  it("arms nothing after it has been stopped", async () => {
    const { engine, storage, send } = makeEngine();
    await storage.save(batch("a"));

    engine.start();
    engine.stop();
    engine.nudge();
    await tick(MAX_DELAY_MS);

    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates a stop with no timer pending", () => {
    const { engine } = makeEngine();

    expect(() => {
      engine.stop();
      engine.stop();
    }).not.toThrow();
  });
});

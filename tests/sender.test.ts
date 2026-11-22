import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { EMERGENCY_STORAGE_KEY_PREFIX, QUERY_PARAM_EXIT_REASON } from "../src/constants";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { Sender } from "../src/core/sender";
import type { ExitTransport, ObservabilityConfig } from "../src/models/config";
import type { LossReporter } from "../src/models/drop";
import type { LogRecord } from "../src/models/log-record";
import { drainEmergencyQueue, saveToEmergencyQueue } from "../src/storage/emergency-queue";
import { RetryEngine } from "../src/transport/retry-engine";

// Keep the real queue. A test replaces one call to hold the import or to make it fail.
vi.mock(import("../src/storage/emergency-queue"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, drainEmergencyQueue: vi.fn(actual.drainEmergencyQueue) };
});

const ENDPOINT = "https://ingest.example/v1/logs";

const record = (body: string): LogRecord => ({
  timeUnixNano: "1755543600123000000",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
  severityNumber: 9,
  severityText: "INFO",
  body,
  attributes: { "log.type": "log" },
  resource: { "service.name": "svc" },
});

/** Senders that a test created. afterEach destroys them. */
const created: Sender[] = [];

/**
 * Builds a sender on memory storage.
 * @param over Config values layered over the base.
 * @returns The sender and its diagnostic events.
 */
async function setup(over: Partial<ObservabilityConfig> = {}, onSent?: (at: number) => void) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const config = resolveConfig(
    {
      endpoint: ENDPOINT,
      serviceName: "svc",
      storage: { backend: "memory" },
      compression: "none",
      ...over,
    },
    diagnostics,
  );
  const onLoss = vi.fn<LossReporter>();
  const sender = await Sender.create({
    config,
    diagnostics,
    onGap: vi.fn(),
    onLoss,
    remote: { sampling: null },
    onSent,
  });
  created.push(sender);
  return { sender, diagnostics, onLoss, codes: () => events.map((event) => event.code) };
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
let beacon: ReturnType<typeof vi.fn<(url: string, data: Blob) => boolean>>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  beacon = vi.fn(() => true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
});

afterEach(async () => {
  for (const sender of created.splice(0)) {
    await sender.destroy();
  }
  localStorage.clear();
});

describe("Sender emergency import", () => {
  it("starts before the emergency import finishes", async () => {
    vi.mocked(drainEmergencyQueue).mockReturnValueOnce(new Promise<number>(() => undefined));

    const { sender } = await setup();

    expect(sender).toBeInstanceOf(Sender);
  });

  it("imports the emergency queue after start, and nudges the retry engine", async () => {
    const nudge = vi.spyOn(RetryEngine.prototype, "nudge");
    const quiet = new Diagnostics(vi.fn(), 0);
    saveToEmergencyQueue(
      { id: "parked", createdAt: Date.now(), attempts: 0, records: [record("parked")] },
      quiet,
    );

    const { sender } = await setup();

    // The import calls nudge once the batch is in storage, so wait for that last step.
    await vi.waitFor(() => {
      expect(nudge).toHaveBeenCalled();
    });
    expect(await sender.queueDepth()).toBe(1);
  });

  it("reports an emergency import that fails, and keeps running", async () => {
    vi.mocked(drainEmergencyQueue).mockReturnValueOnce(Promise.reject(new Error("idb closed")));

    const { codes } = await setup();

    await vi.waitFor(() => {
      expect(codes()).toContain("storage.degraded");
    });
  });
});

describe("Sender stats", () => {
  it("counts a buffered record, then passes the time of the accepted send on", async () => {
    const onSent = vi.fn<(at: number) => void>();
    const { sender } = await setup({}, onSent);
    sender.push(record("one"));

    expect(sender.stats()).toEqual({
      pending: 1,
      inFlight: 0,
      lastFailureAt: null,
      consecutiveFailures: 0,
      throttledUntil: null,
    });

    const before = Date.now();
    await sender.flush();

    expect(sender.stats()).toMatchObject({ pending: 0, inFlight: 0 });
    expect(onSent.mock.calls[0][0]).toBeGreaterThanOrEqual(before);
  });

  it("counts failed sends in a row, and only an accepted batch resets the count", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 500 })));
    const { sender } = await setup();
    const before = Date.now();
    sender.push(record("one"));
    await sender.flush();
    sender.push(record("two"));
    await sender.flush();

    expect(sender.stats()).toMatchObject({ consecutiveFailures: 2 });
    expect(sender.stats().lastFailureAt).toBeGreaterThanOrEqual(before);

    // A traces batch with no tracesEndpoint makes no request, so it proves nothing.
    sender.push({ ...record("span"), attributes: { "log.type": "span" } });
    await sender.flush();
    expect(sender.stats()).toMatchObject({ consecutiveFailures: 2 });

    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    sender.push(record("three"));
    await sender.flush();

    expect(sender.stats()).toMatchObject({ consecutiveFailures: 0 });
  });

  it("reports when the latest server throttle ends", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "30" } })),
    );
    const { sender } = await setup();
    const before = Date.now();
    sender.push(record("one"));
    await sender.flush();

    expect(sender.stats().throttledUntil).toBeGreaterThanOrEqual(before + 29_000);
  });
});

describe("Sender dispatch slots", () => {
  it("frees the slot of a 413 whose body stalls, so the next batch still goes out", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(new ReadableStream<Uint8Array>(), { status: 413 })),
    );
    const { sender } = await setup({
      delivery: { requestTimeoutMs: 20, maxConcurrentRequests: 1 },
    });

    sender.push(record("stalled"));
    void sender.flush();
    await vi.waitFor(() => {
      expect(sender.stats().inFlight).toBe(0);
    });
    sender.push(record("next"));
    await sender.flush();

    const bodies = fetchMock.mock.calls.map(([, init]) => init.body as string);
    expect(bodies.some((body) => body.includes('"next"'))).toBe(true);
  });
});

describe("Sender clock offset", () => {
  /**
   * Reads the clock offset attribute from the first record of one request.
   * @param index Index of the request.
   * @returns The offset in milliseconds, or undefined when the attribute is missing.
   */
  const offsetOf = (index: number): number | undefined => {
    const body: any = JSON.parse(fetchMock.mock.calls[index][1].body as string);
    const pair = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find(
      (attribute: any) => attribute.key === "uiobs.clock_offset_ms",
    );
    return pair === undefined ? undefined : Number(pair.value.intValue);
  };

  /** Answers every request with a Date header one minute ahead of this clock. */
  const answerAhead = (): void => {
    fetchMock.mockImplementation(() => {
      const date = new Date(Date.now() + 60_000).toUTCString();
      return Promise.resolve(new Response(null, { status: 204, headers: { Date: date } }));
    });
  };

  it("adds the offset of an accepted answer to the later records", async () => {
    answerAhead();
    const { sender } = await setup();

    sender.push(record("first"));
    await sender.flush();
    sender.push(record("second"));
    await sender.flush();

    expect(offsetOf(0)).toBeUndefined();
    // The Date header has whole seconds, so the offset is only accurate to about one second.
    expect(Math.abs(offsetOf(1)! - 60_000)).toBeLessThanOrEqual(1000);
  });

  it("adds no offset with metadata.clockOffset false", async () => {
    answerAhead();
    const { sender } = await setup({ metadata: { clockOffset: false } });

    sender.push(record("first"));
    await sender.flush();
    sender.push(record("second"));
    await sender.flush();

    expect(offsetOf(1)).toBeUndefined();
  });
});

describe("Sender shutdown", () => {
  it("sends the pending records with a normal request before the exit flush", async () => {
    const { sender } = await setup();
    created.splice(0);

    sender.push(record("last"));
    await sender.destroy();

    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINT);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(false);
  });
});

describe("Sender exit flush", () => {
  it("sends the last resolved headers with a keepalive fetch on pagehide", async () => {
    const headers = () => ({ authorization: "Bearer t1" });
    const { sender } = await setup({ headers });

    sender.push(record("first"));
    await sender.flush();
    sender.push(record("second"));
    dispatchEvent(new Event("pagehide"));

    expect(beacon).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[1];
    expect(init.keepalive).toBe(true);
    expect((init.headers as Headers).get("authorization")).toBe("Bearer t1");
  });

  it("sends no second copy of a batch that a hidden page's keepalive request carries", async () => {
    // That request outlives the page. An exit copy under a new id would reach the server twice.
    let settle: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { sender, onLoss } = await setup();

    sender.push(record("in flight"));
    const sending = sender.flush();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);

    dispatchEvent(new Event("pagehide"));
    const requests = fetchMock.mock.calls.length;

    // Settle before the assertions, or a failure leaves the teardown waiting for the request.
    settle(new Response(null, { status: 204 }));
    await sending;

    expect(requests).toBe(1);
    expect(beacon).not.toHaveBeenCalled();
    expect(onLoss).not.toHaveBeenCalled();
  });

  it("keeps an exit batch that doesn't fit next to a hidden send still in flight", async () => {
    // On a navigation, hidden fires just before pagehide, and both sends use one browser budget.
    // The browser rejects a fetch over it after the document closes, when nothing reports it.
    let settle: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { sender, onLoss } = await setup({ headers: { authorization: "Bearer t1" } });

    sender.push(record("x".repeat(50_000)));
    const hiddenFlush = sender.flush();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);

    sender.push(record("y".repeat(20_000)));
    dispatchEvent(new Event("pagehide"));
    const exitRequests = fetchMock.mock.calls.length - 1;

    // Settle the hidden send before the assertions, or a failure leaves the teardown waiting.
    settle(new Response(null, { status: 204 }));
    await hiddenFlush;

    // Memory storage keeps nothing on the device, so the parked batch reaches onLoss.
    expect(exitRequests).toBe(0);
    expect(onLoss.mock.calls.map(([reason]) => reason)).toEqual(["not_stored"]);
  });
});

describe("Sender after a pagehide", () => {
  /** A pagehide or a pageshow event with its `persisted` flag. */
  const transition = (type: string, persisted: boolean): Event =>
    Object.assign(new Event(type), { persisted });

  /** Reads a request body. The exit path and the normal path both send text. */
  const textOf = (init: RequestInit): string => (typeof init.body === "string" ? init.body : "");

  /** The bodies of the requests that name an exit reason, so only the exit path counts. */
  const exitBodies = (): string[] =>
    fetchMock.mock.calls
      .filter(([url]) => new URL(url).searchParams.has(QUERY_PARAM_EXIT_REASON))
      .map(([, init]) => textOf(init));

  /** Lists the emergency queue keys. happy-dom's Storage is a Proxy, so read it by index. */
  const emergencyKeys = (): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(EMERGENCY_STORAGE_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    return keys;
  };

  it("sends a record that is logged right after pagehide with an exit send", async () => {
    const { sender } = await setup();

    dispatchEvent(new Event("pagehide"));
    sender.push(record("late record"));
    await Promise.resolve();

    // The document is closing, so a timer would never fire. No timer has advanced here.
    expect(exitBodies()).toHaveLength(1);
    expect(exitBodies()[0]).toContain("late record");
  });

  it("sends a record that a later visibilitychange listener logs with an exit send", async () => {
    // A real page leave fires pagehide, then the web-vitals reports, then visibilitychange.
    // The package listens after the library does, so its report comes after the library's flush.
    const { sender } = await setup();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const report = (): void => {
      sender.push(record("late vital"));
    };
    document.addEventListener("visibilitychange", report);
    onTestFinished(() => {
      document.removeEventListener("visibilitychange", report);
    });

    dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(exitBodies()).toHaveLength(1);
    expect(exitBodies()[0]).toContain("late vital");
  });

  it("sends several late records of one task in one exit send", async () => {
    const { sender } = await setup();

    dispatchEvent(new Event("pagehide"));
    for (const body of ["late one", "late two", "late three"]) {
      sender.push(record(body));
    }
    await Promise.resolve();

    const sends = exitBodies();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("late one");
    expect(sends[0]).toContain("late two");
    expect(sends[0]).toContain("late three");
  });

  it("doesn't send a record again that the pagehide exit flush already sent", async () => {
    const { sender } = await setup();
    sender.push(record("early record"));

    dispatchEvent(new Event("pagehide"));
    sender.push(record("late record"));
    await Promise.resolve();
    // A normal flush after the exit send must find nothing left to send.
    await sender.flush();

    const sends = exitBodies();
    expect(sends).toHaveLength(2);
    expect(sends[0]).toContain("early record");
    expect(sends[0]).not.toContain("late record");
    expect(sends[1]).toContain("late record");
    expect(sends[1]).not.toContain("early record");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parks a late record that doesn't fit the exit budget in the emergency queue", async () => {
    const { sender } = await setup({ storage: { backend: "localstorage" } });

    dispatchEvent(new Event("pagehide"));
    sender.push(record("x".repeat(61_000)));
    await Promise.resolve();

    expect(emergencyKeys()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns to the normal path when the page comes back from the cache", async () => {
    const { sender } = await setup({ batching: { logFlushIntervalMs: 100 } });

    dispatchEvent(transition("pagehide", true));
    dispatchEvent(transition("pageshow", true));
    sender.push(record("restored record"));
    await Promise.resolve();

    // The page is alive again, so the record waits for its batch timer like any other.
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).searchParams.has(QUERY_PARAM_EXIT_REASON)).toBe(false);
    expect(textOf(init)).toContain("restored record");
  });

  it("hands a late record to transportOnExit, and not to the transport", async () => {
    const transport = vi.fn(() => Promise.resolve({ status: 200 }));
    const transportOnExit = vi.fn<ExitTransport>(() => true);
    const { sender } = await setup({ transport, transportOnExit });

    dispatchEvent(new Event("pagehide"));
    sender.push(record("late record"));
    await Promise.resolve();

    expect(transportOnExit).toHaveBeenCalledOnce();
    expect(transportOnExit.mock.calls[0][0].records.map((one) => one.body)).toEqual([
      "late record",
    ]);
    expect(transport).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

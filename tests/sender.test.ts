import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import { Sender } from "../src/core/sender";
import type { ObservabilityConfig } from "../src/models/config";
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
async function setup(over: Partial<ObservabilityConfig> = {}) {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const config = resolveConfig(
    { endpoint: ENDPOINT, serviceName: "svc", storage: "memory", compression: "none", ...over },
    diagnostics,
  );
  const sender = await Sender.create({
    config,
    diagnostics,
    onGap: vi.fn(),
    onLoss: vi.fn(),
    remote: { sampling: null },
  });
  created.push(sender);
  return { sender, diagnostics, codes: () => events.map((event) => event.code) };
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

    // The import calls nudge after the batch is in storage. Wait for the last step.
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
  it("counts a buffered record, then gives the time of the accepted send", async () => {
    const { sender } = await setup();
    sender.push(record("one"));

    expect(sender.stats()).toEqual({ pending: 1, inFlight: 0, lastSendAt: null });

    const before = Date.now();
    await sender.flush();

    expect(sender.stats()).toMatchObject({ pending: 0, inFlight: 0 });
    expect(sender.stats().lastSendAt).toBeGreaterThanOrEqual(before);
  });
});

describe("Sender clock offset", () => {
  /**
   * Reads the clock offset attribute of the first record of one request.
   * @param index Index of the request.
   * @returns The offset in milliseconds, or undefined without the attribute.
   */
  const offsetOf = (index: number): number | undefined => {
    const body: any = JSON.parse(fetchMock.mock.calls[index][1].body as string);
    const pair = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find(
      (attribute: any) => attribute.key === "uiobs.clock_offset_ms",
    );
    return pair === undefined ? undefined : Number(pair.value.intValue);
  };

  /** Answers each request with a Date header one minute ahead of this clock. */
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
    // The Date header has whole seconds. The offset is correct to about one second.
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
});

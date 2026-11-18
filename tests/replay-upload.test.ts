// tests/replay-upload.test.ts
//
// Tests for the session replay uploader. It cuts events into segments by count, size and time,
// and sends one segment at a time, either to the app's callback or to the replay endpoint.

import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayUploader } from "../src/capture/replay-upload";
import { resolveConfig } from "../src/core/config";
import { type DiagnosticEvent, Diagnostics } from "../src/core/diagnostics";
import type { ObservabilityConfig, ReplayPolicy } from "../src/models/config";
import type { ReplaySegment } from "../src/models/replay";

const ENDPOINT = "https://replay.example/v1/replay";

const IDS = { replayId: "replay-1", sessionId: "session-1", tabId: "tab-1" };

/** One recorded request. */
interface Call {
  url: string;
  init: RequestInit;
}

/** Every uploader the tests created. Teardown stops them all. */
const uploaders: ReplayUploader[] = [];

afterEach(() => {
  // Don't let a send that is still in flight reach the next test's fetch stub.
  for (const uploader of uploaders.splice(0)) {
    uploader.stop();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Builds an uploader that collects its segments in a list.
 * @param replay Replay settings for the test.
 * @param over Other settings for the test.
 * @returns The uploader, the segments, the events and the config object.
 */
function setup(replay: Partial<ReplayPolicy> = {}, over: Partial<ObservabilityConfig> = {}) {
  vi.useFakeTimers();
  const events: DiagnosticEvent[] = [];
  const segments: ReplaySegment[] = [];
  const diagnostics = new Diagnostics((event) => {
    events.push(event);
  }, 0);
  const state = {
    config: resolveConfig(
      {
        endpoint: null,
        serviceName: "blotter",
        replay: {
          onSegment: (segment) => {
            segments.push(segment);
          },
          ...replay,
        },
        ...over,
      },
      diagnostics,
    ),
  };
  events.length = 0;
  const uploader = new ReplayUploader(() => state.config, diagnostics);
  uploaders.push(uploader);
  uploader.begin(IDS);

  return { uploader, segments, events, diagnostics, state };
}

/**
 * Builds an uploader that sends to the endpoint, with fetch stubbed.
 * @param answers Status for each response in order, or an error to throw. The last one repeats.
 * @param replay Replay settings for the test.
 * @param over Other settings for the test.
 * @returns Everything setup() returns, plus the requests.
 */
function http(
  answers: (number | Error | string)[],
  replay: Partial<ReplayPolicy> = {},
  over: Partial<ObservabilityConfig> = {},
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const answer = answers[Math.min(calls.length, answers.length - 1)];
      calls.push({ url, init });
      return typeof answer === "number"
        ? Promise.resolve(new Response(null, { status: answer }))
        : // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- A test rejects with a text.
          Promise.reject(answer);
    }),
  );
  const harness = setup(
    { endpoint: ENDPOINT, onSegment: null, ...replay },
    { compression: "none", ...over },
  );

  return { ...harness, calls };
}

/** Returns the messages of the events with a given code. */
const texts = (events: DiagnosticEvent[], code: string): string[] =>
  events.filter((event) => event.code === code).map((event) => event.message);

describe("segments", () => {
  it("closes a segment at the event count", async () => {
    const { uploader, segments } = setup({ batchSize: 2 });

    uploader.push(["1", "2", "3", "4", "5"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(segments.map(({ sequence, events, payload }) => [sequence, events, payload])).toEqual([
      [0, 2, "[1,2]"],
      [1, 2, "[3,4]"],
    ]);
  });

  it("closes a partial segment after the wait", async () => {
    const { uploader, segments } = setup({ batchSize: 3, flushIntervalMs: 500 });

    uploader.push(["1", "2", "3", "4"]);
    await vi.advanceTimersByTimeAsync(499);
    expect(segments).toHaveLength(1);

    // An event during the wait doesn't start a second timer. The first one closes the segment.
    uploader.push(["5"]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(segments.map(({ payload }) => payload)).toEqual(["[1,2,3]", "[4,5]"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a segment at the size, and gives one large event a segment of its own", async () => {
    const { uploader, segments } = setup({ batchBytes: 10_000 });
    const small = `"${"a".repeat(3998)}"`;
    const large = `"${"b".repeat(19_998)}"`;

    // Two small events come to 8,000 characters, so a third doesn't fit.
    uploader.push([small, small, small, large, small]);
    uploader.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(segments.map(({ events, bytes }) => [events, bytes])).toEqual([
      [2, 8003],
      [1, 4002],
      [1, 20_002],
      [1, 4002],
    ]);
  });

  it("stamps each segment with the ids, the service name and a sequence number", async () => {
    const { uploader, segments } = setup({ batchSize: 1 });

    uploader.push(['{"type":4}', '{"type":2}']);
    await vi.advanceTimersByTimeAsync(0);

    expect(segments).toEqual([
      {
        "replay.id": "replay-1",
        "session.id": "session-1",
        "tab.id": "tab-1",
        "service.name": "blotter",
        sequence: 0,
        events: 1,
        bytes: 12,
        payload: '[{"type":4}]',
      },
      expect.objectContaining({ sequence: 1, payload: '[{"type":2}]' }),
    ]);
  });

  it("continues the sequence for a later upload of one recording and starts at 0 for a new one", async () => {
    const { uploader, segments } = setup({ batchSize: 1 });

    uploader.push(["1"]);
    uploader.begin({ ...IDS, sessionId: "session-2" });
    uploader.push(["2"]);
    uploader.begin({ ...IDS, replayId: "replay-2" });
    uploader.push(["3"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      segments.map((segment) => [segment["replay.id"], segment["session.id"], segment.sequence]),
    ).toEqual([
      ["replay-1", "session-1", 0],
      ["replay-1", "session-2", 1],
      ["replay-2", "session-1", 0],
    ]);
  });

  it("cuts no segment without events or before the first begin()", async () => {
    const { segments, state, diagnostics } = setup();
    const fresh = new ReplayUploader(() => state.config, diagnostics);

    fresh.flush();
    fresh.push(["1"]);
    fresh.flush();
    await vi.advanceTimersByTimeAsync(5000);

    expect(segments).toEqual([]);
    fresh.stop();
  });

  it("reads the batch settings at each push", async () => {
    const { uploader, segments, state, diagnostics } = setup({ batchSize: 10 });

    uploader.push(["1"]);
    state.config = resolveConfig({ replay: { batchSize: 2 } }, diagnostics, state.config);
    uploader.push(["2"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(segments.map(({ payload }) => payload)).toEqual(["[1,2]"]);
  });
});

describe("send order", () => {
  it("sends one segment at a time, in order", async () => {
    const started: number[] = [];
    const finish: (() => void)[] = [];
    const { uploader } = setup({
      batchSize: 1,
      onSegment: (segment) => {
        started.push(segment.sequence);
        return new Promise<void>((resolve) => {
          finish.push(resolve);
        });
      },
    });

    uploader.push(["1", "2", "3"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0]);

    finish[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1]);

    finish[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2]);
  });

  it("drops the oldest segment that waits above the queue size and reports the count", async () => {
    const started: number[] = [];
    const { uploader, events } = setup({
      batchSize: 1,
      maxQueueBytes: 100_000,
      onSegment: (segment) => {
        started.push(segment.sequence);
        return new Promise<void>(() => undefined);
      },
    });
    const event = `"${"a".repeat(39_996)}"`;

    // Segment 0 is in flight and segments 1, 2 and 3 are queued, at 40,000 characters each.
    uploader.push([event, event, event, event]);
    await vi.advanceTimersByTimeAsync(0);

    expect(started).toEqual([0]);
    expect(texts(events, "transport.dropped_permanent")).toEqual([
      "The replay queue is above replay.maxQueueBytes. The library dropped 1 segments.",
    ]);
  });

  it("keeps one segment that alone is above the queue size", async () => {
    const { uploader, segments, events } = setup({ batchSize: 1, maxQueueBytes: 100_000 });

    uploader.push([`"${"a".repeat(150_000)}"`]);
    await vi.advanceTimersByTimeAsync(0);

    expect(segments).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("drops a segment whose function does not end in delivery.requestTimeoutMs", async () => {
    const seen: number[] = [];
    const { uploader, events } = setup(
      {
        batchSize: 1,
        onSegment: (segment) => {
          seen.push(segment.sequence);
          // The first call never settles. Without a deadline nothing after it would go out.
          return segment.sequence === 0 ? new Promise<void>(() => undefined) : undefined;
        },
      },
      { delivery: { requestTimeoutMs: 5000 } },
    );

    uploader.push(["1", "2"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(seen).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);

    expect(seen).toEqual([0, 1]);
    expect(texts(events, "capture.record_failed")).toEqual([
      "The replay.onSegment function threw an error, or it did not end in 5000 ms.",
    ]);
  });

  it("reports a segment function that throws and sends the next segment", async () => {
    const error = new Error("store is full");
    const seen: number[] = [];
    const { uploader, events } = setup({
      batchSize: 1,
      onSegment: (segment) => {
        seen.push(segment.sequence);
        if (segment.sequence === 0) {
          throw error;
        }
      },
    });

    uploader.push(["1", "2"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([0, 1]);
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      [
        "capture.record_failed",
        "The replay.onSegment function threw an error, or it did not end in 15000 ms.",
        error,
      ],
      [
        "transport.dropped_permanent",
        "The library dropped the replay segment 0 after 1 attempts.",
        undefined,
      ],
    ]);
  });

  it("drops each event and each segment at stop(), and changes nothing after a late send", async () => {
    const finish: (() => void)[] = [];
    const started: number[] = [];
    const { uploader } = setup({
      batchSize: 2,
      onSegment: (segment) => {
        started.push(segment.sequence);
        return new Promise<void>((resolve) => {
          finish.push(resolve);
        });
      },
    });

    uploader.push(["1", "2", "3", "4", "5"]);
    await vi.advanceTimersByTimeAsync(0);
    uploader.stop();
    finish[0]();
    await vi.advanceTimersByTimeAsync(60_000);

    // Segment 1 was queued and event 5 was waiting on the timer. Both are gone.
    expect(started).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);

    // The uploader still works after a stop.
    uploader.push(["6", "7"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 2]);
  });
});

/** Returns a call's request headers as a plain object with lower-case names. */
const headersOf = (call: Call): Record<string, string> =>
  Object.fromEntries(
    [...(call.init.headers as Headers).entries()].map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );

describe("endpoint request", () => {
  it("sends nothing once a later configure() turns the endpoint off", async () => {
    const { uploader, calls, state } = http([202], { batchSize: 1 });
    state.config.replay.endpoint = null;

    uploader.push(['{"type":4}']);
    await vi.advanceTimersByTimeAsync(0);

    // fetch(null) would post the segment to the page's own URL.
    expect(calls).toEqual([]);
  });

  it("posts the segment as JSON with the ids and the batch headers", async () => {
    const { uploader, calls } = http([202], { batchSize: 2 });

    uploader.push(['{"type":4}', '{"type":2}']);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].init).toMatchObject({
      method: "POST",
      // By default the app's cookies don't go to the replay endpoint.
      credentials: "omit",
      cache: "no-store",
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(headersOf(calls[0])).toEqual({
      "content-type": "application/json",
      "x-uiobs-batch-id": "replay-1-0",
      "x-uiobs-attempt": "0",
    });

    const text = calls[0].init.body as string;
    // A body with two "events" keys is invalid for a strict parser.
    expect(text.match(/"events":/g)).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({
      "replay.id": "replay-1",
      "session.id": "session-1",
      "tab.id": "tab-1",
      "service.name": "blotter",
      sequence: 0,
      bytes: 23,
      events: [{ type: 4 }, { type: 2 }],
    });
  });

  it("sends replay.headers and not the headers of the log endpoint", async () => {
    const { uploader, calls } = http(
      [200],
      { batchSize: 1, headers: { Authorization: "Bearer replay", "content-type": "text/plain" } },
      { headers: { Authorization: "Bearer logs", "X-Tenant": "a" } },
    );

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(0);

    // The log endpoint's token must not reach another host. The library sets the content type.
    expect(headersOf(calls[0])).toEqual({
      authorization: "Bearer replay",
      "content-type": "application/json",
      "x-uiobs-batch-id": "replay-1-0",
      "x-uiobs-attempt": "0",
    });
  });

  it("uses the credentials setting of the app", async () => {
    const { uploader, calls } = http([200], { batchSize: 1 }, { credentials: "include" });

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls[0].init.credentials).toBe("include");
  });

  it("compresses a large body with gzip", async () => {
    const { uploader, calls } = http([200], { batchSize: 1 }, { compression: "gzip" });
    const event = JSON.stringify({ type: 3, text: "a".repeat(2000) });

    uploader.push([event]);
    // The compression stream doesn't run on a timer, so wait for the request itself.
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    expect(headersOf(calls[0])["content-encoding"]).toBe("gzip");
    const body = JSON.parse(gunzipSync(calls[0].init.body as Uint8Array).toString()) as {
      events: unknown[];
    };
    expect(body.events).toEqual([JSON.parse(event)]);
  });

  it("sends a small body and a body with no CompressionStream as text", async () => {
    const { uploader, calls } = http([200], { batchSize: 1 }, { compression: "gzip" });

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(0);
    vi.stubGlobal("CompressionStream", undefined);
    uploader.push([JSON.stringify({ text: "a".repeat(2000) })]);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map(({ init }) => typeof init.body)).toEqual(["string", "string"]);
    expect(headersOf(calls[1])).not.toHaveProperty("content-encoding");
  });

  it("sends in a browser with no AbortSignal.timeout", async () => {
    const { uploader, calls } = http([200], { batchSize: 1 });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new TypeError("AbortSignal.timeout is not a function");
    });

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
  });

  it("stops a request that takes longer than delivery.requestTimeoutMs and sends it again", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => {
            reject(new DOMException("The request was stopped.", "AbortError"));
          });
        });
      }),
    );
    const { uploader, events } = setup(
      { endpoint: ENDPOINT, onSegment: null, batchSize: 1, maxAttempts: 1 },
      { compression: "none", delivery: { requestTimeoutMs: 5000 } },
    );

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(signals[0].aborted).toBe(true);
    // A request error's message can contain the URL, so the report only has the error name.
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["transport.http_error", "The replay request failed with AbortError.", undefined],
      [
        "transport.dropped_permanent",
        "The library dropped the replay segment 0 after 1 attempts.",
        undefined,
      ],
    ]);
  });

  it.each([[429], [500], [503]])(
    "sends a segment again after the status %d, with a longer wait each time",
    async (status) => {
      const { uploader, calls, events } = http(
        [status, status, 200],
        { batchSize: 1 },
        { delivery: { retryBaseDelayMs: 1000, retryMaxDelayMs: 1500 } },
      );

      uploader.push(["1", "2"]);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);

      // The second wait would be 2000 ms, but retryMaxDelayMs caps it at 1500 ms.
      await vi.advanceTimersByTimeAsync(1499);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(calls.map((call) => headersOf(call)["x-uiobs-attempt"])).toEqual(["0", "1", "2", "0"]);
      expect(calls.map((call) => headersOf(call)["x-uiobs-batch-id"])).toEqual([
        "replay-1-0",
        "replay-1-0",
        "replay-1-0",
        "replay-1-1",
      ]);
      expect(texts(events, "transport.http_error")).toEqual([
        `The replay endpoint returned ${String(status)}.`,
        `The replay endpoint returned ${String(status)}.`,
      ]);
      expect(texts(events, "transport.dropped_permanent")).toEqual([]);
    },
  );

  it("drops a segment after the last attempt and sends the next segment", async () => {
    const error = new TypeError("fetch failed for https://user:secret@replay.example");
    const { uploader, calls, events } = http(
      [error, "no error object", 200],
      { batchSize: 1, maxAttempts: 2 },
      { delivery: { retryBaseDelayMs: 100 } },
    );

    uploader.push(["1", "2"]);
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toHaveLength(3);
    expect(events.map(({ code, message, cause }) => [code, message, cause])).toEqual([
      ["transport.http_error", "The replay request failed with TypeError.", undefined],
      ["transport.http_error", "The replay request failed with Error.", undefined],
      [
        "transport.dropped_permanent",
        "The library dropped the replay segment 0 after 2 attempts.",
        undefined,
      ],
    ]);
    expect(events[2].detail).toEqual({ "replay.id": "replay-1", sequence: 0 });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it.each([[400], [404], [413]])(
    "drops a segment right away after the status %d",
    async (status) => {
      const { uploader, calls, events } = http([status, 200], { batchSize: 1 });

      uploader.push(["1", "2"]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toHaveLength(2);
      expect(texts(events, "transport.dropped_permanent")).toEqual([
        "The library dropped the replay segment 0 after 1 attempts.",
      ]);
    },
  );

  it.each([[401], [403]])(
    "calls the replay.headers function again after the status %d",
    async (status) => {
      let token = 0;
      const { uploader, calls } = http(
        [status, 200],
        {
          batchSize: 1,
          headers: () => Promise.resolve({ Authorization: `Bearer ${String(++token)}` }),
        },
        { delivery: { retryBaseDelayMs: 100 } },
      );

      uploader.push(["1"]);
      await vi.advanceTimersByTimeAsync(100);

      expect(calls.map((call) => headersOf(call).authorization)).toEqual(["Bearer 1", "Bearer 2"]);
    },
  );

  it("reports a replay.headers function that throws and sends nothing", async () => {
    const { uploader, calls, events } = http([200], {
      batchSize: 1,
      maxAttempts: 1,
      headers: () => {
        throw new RangeError("no token");
      },
    });

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([]);
    expect(texts(events, "transport.http_error")).toEqual([
      "The replay request failed with RangeError.",
    ]);
  });

  it("stops the request in flight and the next attempt at stop()", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        return new Promise<Response>(() => undefined);
      }),
    );
    const { uploader } = setup(
      { endpoint: ENDPOINT, onSegment: null, batchSize: 1 },
      { compression: "none" },
    );

    uploader.push(["1", "2"]);
    await vi.advanceTimersByTimeAsync(0);
    uploader.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    // The user stopped the replay, so nothing else goes to the endpoint.
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
  });

  it("sends nothing when a stop comes while the headers function waits", async () => {
    let open: (headers: Record<string, string>) => void = () => undefined;
    const { uploader, calls } = http([200], {
      batchSize: 1,
      headers: () =>
        new Promise((resolve) => {
          open = resolve;
        }),
    });

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(0);
    uploader.stop();
    open({ Authorization: "Bearer late" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toEqual([]);
  });

  it("stops the next attempt of a segment at stop()", async () => {
    const { uploader, calls } = http(
      [503],
      { batchSize: 1 },
      { delivery: { retryBaseDelayMs: 100 } },
    );

    uploader.push(["1"]);
    await vi.advanceTimersByTimeAsync(0);
    uploader.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toHaveLength(1);
  });
});

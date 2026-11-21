import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getJson,
  listRecordings,
  loadRecordingEvents,
  parseRecordingEvents,
  parseRecordingHeads,
  REPLAY_SERVICE_URL,
} from "./replay-api";

const HEAD = {
  id: "11111111-aaaa",
  service: "react-workspace",
  sessionId: "s1",
  tabId: "t1",
  startedAt: "2026-11-21T10:00:00.000Z",
  segments: 2,
  events: 5,
  bytes: 1024,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

describe("parseRecordingHeads", () => {
  it("keeps a list of recordings", () => {
    expect(parseRecordingHeads([HEAD])).toEqual([HEAD]);
  });

  it("leaves out an entry of a wrong shape", () => {
    expect(parseRecordingHeads([HEAD, { id: "x" }, null, "text", { ...HEAD, bytes: "1" }])).toEqual(
      [HEAD],
    );
  });

  it.each([[null], [{}], ["list"], [42]])("refuses %j, which is not a list", (value) => {
    expect(() => parseRecordingHeads(value)).toThrow("did not answer with a list");
  });
});

describe("parseRecordingEvents", () => {
  const event = (timestamp: number, type = 3): object => ({ type, timestamp, data: {} });

  it("joins the segments in the order of their sequence numbers", () => {
    const events = parseRecordingEvents({
      segments: [
        { sequence: 1, events: [event(30), event(40)] },
        { sequence: 0, events: [event(10, 4), event(20, 2)] },
      ],
    });

    expect(events.map((item) => item.timestamp)).toEqual([10, 20, 30, 40]);
  });

  it("returns no event for a recording without segments", () => {
    expect(parseRecordingEvents({ segments: [] })).toEqual([]);
  });

  it("leaves out a segment of a wrong shape", () => {
    const events = parseRecordingEvents({
      segments: [
        { sequence: "0", events: [event(1)] },
        { sequence: 1 },
        null,
        { sequence: 2, events: [event(5)] },
      ],
    });

    expect(events.map((item) => item.timestamp)).toEqual([5]);
  });

  it("refuses an event that the player can't read", () => {
    expect(() =>
      parseRecordingEvents({ segments: [{ sequence: 0, events: [event(1), { type: "x" }] }] }),
    ).toThrow("can't read");
  });

  it.each([[null], [{}], [{ segments: "none" }]])(
    "refuses %j, which is not a recording",
    (value) => {
      expect(() => parseRecordingEvents(value)).toThrow("did not answer with a recording");
    },
  );
});

describe("requests", () => {
  it("asks for the list and parses it", async () => {
    answer([HEAD]);

    await expect(listRecordings()).resolves.toEqual([HEAD]);
    expect(fetch).toHaveBeenCalledWith(REPLAY_SERVICE_URL, expect.anything());
  });

  it("asks for one recording by its encoded id", async () => {
    answer({ segments: [{ sequence: 0, events: [{ type: 4, timestamp: 1 }] }] });

    await expect(loadRecordingEvents("a/b c")).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(`${REPLAY_SERVICE_URL}/a%2Fb%20c`, expect.anything());
  });

  it("names the status of an answer that is not ok", async () => {
    answer({ error: "no recording has this id" }, 404);

    await expect(loadRecordingEvents("missing01")).rejects.toThrow("answered 404");
  });

  it("passes a failed request on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await expect(getJson("/x")).rejects.toThrow("Failed to fetch");
  });
});

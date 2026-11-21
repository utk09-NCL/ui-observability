// src/replay-player/replay-api.ts
//
// Reads the recordings of the replay service. REPLAY_SERVICE_URL and getJson() are the two
// things to replace when you copy this folder. The rest only checks the shape of the answers, so
// a service that answers with another shape fails with a clear error and not inside the player.
//
// The service is the mock ingest server of this repository. It keeps the segments that the
// library uploads, and it answers two requests:
//   GET <url>          a list of recordings, newest first, without events
//   GET <url>/<id>     one recording with its segments in the order of their sequence numbers

/** Where the page asks for recordings. The Vite proxy sends it to the mock ingest server. */
export const REPLAY_SERVICE_URL = "/telemetry/v1/replay/recordings";

export interface RecordingHead {
  id: string;
  service: string;
  sessionId: string;
  tabId: string;
  startedAt: string;
  segments: number;
  events: number;
  bytes: number;
}

/** One recorder event. The player needs the type and the time, and reads the rest itself. */
export interface ReplayEvent {
  type: number;
  timestamp: number;
  [key: string]: unknown;
}

/**
 * Reads one JSON answer. Replace this function when your replay service needs a token, a base
 * URL or another way to call.
 * @param url The address.
 * @returns The parsed JSON.
 */
export async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`The replay service answered ${String(response.status)}.`);
  }

  return (await response.json()) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHead(value: unknown): value is RecordingHead {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.service === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.tabId === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.segments === "number" &&
    typeof value.events === "number" &&
    typeof value.bytes === "number"
  );
}

function isEvent(value: unknown): value is ReplayEvent {
  return isObject(value) && typeof value.type === "number" && typeof value.timestamp === "number";
}

/**
 * Checks the list answer.
 * @param value The parsed JSON of the list request.
 * @returns The recordings. An entry of a wrong shape is left out.
 */
export function parseRecordingHeads(value: unknown): RecordingHead[] {
  if (!Array.isArray(value)) {
    throw new Error("The replay service did not answer with a list.");
  }

  return value.filter(isHead);
}

/**
 * Joins the segments of one recording into one list of events for the player.
 * @param value The parsed JSON of the recording request.
 * @returns The events in the order of the segments.
 */
export function parseRecordingEvents(value: unknown): ReplayEvent[] {
  if (!isObject(value) || !Array.isArray(value.segments)) {
    throw new Error("The replay service did not answer with a recording.");
  }

  const segments = value.segments.filter(
    (segment): segment is { sequence: number; events: unknown[] } =>
      isObject(segment) && typeof segment.sequence === "number" && Array.isArray(segment.events),
  );
  const events: ReplayEvent[] = [];
  for (const segment of [...segments].sort((a, b) => a.sequence - b.sequence)) {
    for (const event of segment.events) {
      if (!isEvent(event)) {
        throw new Error("A segment holds an event that the player can't read.");
      }
      events.push(event);
    }
  }

  return events;
}

/**
 * Lists the recordings.
 * @returns The recordings, newest first.
 */
export async function listRecordings(): Promise<RecordingHead[]> {
  return parseRecordingHeads(await getJson(REPLAY_SERVICE_URL));
}

/**
 * Loads the events of one recording.
 * @param id The recording id.
 * @returns The events.
 */
export async function loadRecordingEvents(id: string): Promise<ReplayEvent[]> {
  return parseRecordingEvents(await getJson(`${REPLAY_SERVICE_URL}/${encodeURIComponent(id)}`));
}

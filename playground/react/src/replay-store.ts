// playground/react/src/replay-store.ts
//
// Storage for the replay example. This is not library code: in the playground, IndexedDB
// stands in for a company's replay service, and the library itself never writes a segment to
// IndexedDB. The store is capped by bytes, count and age, and new recordings push out the oldest.

import type { ReplaySegment } from "@utk09/ui-observability";

/** Store limits. A write that goes over one of them evicts the oldest recordings. */
export const STORE_LIMITS = {
  /** Cap on the payload characters of all recordings together. */
  maxBytes: 50 * 1024 * 1024,
  /** Cap on the number of recordings. */
  maxRecordings: 20,
  /** How long a recording is kept, in ms. */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

/** Header of a stored recording. The segments live in a second object store. */
export interface RecordingHead {
  /** Recording key. */
  id: string;
  /** The recorder's replay id. */
  replayId: string;
  /** Session id from the error record. */
  sessionId: string;
  /** Tab id from the error record. */
  tabId: string;
  /** When it was saved, in epoch ms. */
  createdAt: number;
  /** Number of segments. */
  segments: number;
  /** Number of events. */
  events: number;
  /** Number of payload characters. */
  bytes: number;
}

/** A stored segment. */
interface StoredSegment {
  recordingId: string;
  sequence: number;
  payload: string;
}

/** What a save did. */
export interface SaveResult {
  /** Header of the new recording, or null if it is over the byte limit all by itself. */
  saved: RecordingHead | null;
  /** Keys of the recordings the save evicted. */
  removed: string[];
}

const DB_NAME = "uiobs-replay-spike";
const HEADS = "recordings";
const SEGMENTS = "segments";

/**
 * Wraps an IndexedDB request in a promise.
 * @param request The request.
 * @returns The request's result.
 */
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("The IndexedDB request failed."));
    };
  });
}

/**
 * Waits for a transaction to finish.
 * @param transaction The transaction.
 * @returns A promise that resolves on commit.
 */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("The IndexedDB transaction stopped."));
    };
  });
}

/**
 * Opens the database, creating its two object stores if needed.
 * @returns The database.
 */
async function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(HEADS, { keyPath: "id" });
    request.result.createObjectStore(SEGMENTS, { keyPath: ["recordingId", "sequence"] });
  };

  return result(request);
}

/**
 * Returns the key range covering one recording's segments.
 * @param id Recording key.
 * @returns The range.
 */
function segmentsOf(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

/**
 * Lists the recordings, newest first.
 * @returns The headers.
 */
export async function listRecordings(): Promise<RecordingHead[]> {
  const db = await open();
  const heads = await result<RecordingHead[]>(
    db.transaction(HEADS).objectStore(HEADS).getAll() as IDBRequest<RecordingHead[]>,
  );
  db.close();

  return heads.sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * Saves one upload as a recording, then evicts recordings that are too old and the oldest
 * ones over the count or byte limit. It all happens in a single transaction.
 * @param segments The segments of one upload, in order.
 * @returns The new header and the evicted keys.
 */
export async function saveRecording(segments: readonly ReplaySegment[]): Promise<SaveResult> {
  const bytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);

  // A recording bigger than the whole store can never fit. Leave the store as it is.
  if (segments.length === 0 || bytes > STORE_LIMITS.maxBytes) {
    return { saved: null, removed: [] };
  }

  const first = segments[0];

  const createdAt = Date.now();
  const head: RecordingHead = {
    id: `${first["replay.id"]}/${String(createdAt)}`,
    replayId: first["replay.id"],
    sessionId: first["session.id"],
    tabId: first["tab.id"],
    createdAt,
    segments: segments.length,
    events: segments.reduce((sum, segment) => sum + segment.events, 0),
    bytes,
  };

  const db = await open();
  const transaction = db.transaction([HEADS, SEGMENTS], "readwrite");
  const heads = transaction.objectStore(HEADS);
  const stored = transaction.objectStore(SEGMENTS);
  const end = committed(transaction);

  heads.put(head);
  for (const { sequence, payload } of segments) {
    stored.put({ recordingId: head.id, sequence, payload } satisfies StoredSegment);
  }

  // Oldest first. The new recording is last, so it is the last one the limits would evict.
  const all = (await result<RecordingHead[]>(heads.getAll() as IDBRequest<RecordingHead[]>)).sort(
    (left, right) => left.createdAt - right.createdAt,
  );
  const removed: string[] = [];
  let count = all.length;
  let total = all.reduce((sum, item) => sum + item.bytes, 0);

  for (const item of all) {
    const tooOld = createdAt - item.createdAt > STORE_LIMITS.maxAgeMs;
    const tooMany = count > STORE_LIMITS.maxRecordings || total > STORE_LIMITS.maxBytes;

    if (item.id === head.id || !(tooOld || tooMany)) {
      continue;
    }

    heads.delete(item.id);
    stored.delete(segmentsOf(item.id));
    removed.push(item.id);
    count--;
    total -= item.bytes;
  }

  await end;
  db.close();

  return { saved: head, removed };
}

/**
 * Reads a recording's events, in order.
 * @param id Recording key.
 * @returns The events.
 */
export async function loadEvents(id: string): Promise<unknown[]> {
  const db = await open();
  const segments = await result<StoredSegment[]>(
    db.transaction(SEGMENTS).objectStore(SEGMENTS).getAll(segmentsOf(id)) as IDBRequest<
      StoredSegment[]
    >,
  );
  db.close();

  // Key order is sequence order. Each segment payload is a JSON array of events.
  return segments.flatMap((segment) => JSON.parse(segment.payload) as unknown[]);
}

/**
 * Deletes a recording and its segments.
 * @param id Recording key.
 * @returns A promise that resolves on commit.
 */
export async function deleteRecording(id: string): Promise<void> {
  const db = await open();
  const transaction = db.transaction([HEADS, SEGMENTS], "readwrite");
  const end = committed(transaction);
  transaction.objectStore(HEADS).delete(id);
  transaction.objectStore(SEGMENTS).delete(segmentsOf(id));
  await end;
  db.close();
}

/**
 * Deletes every recording.
 * @returns A promise that resolves on commit.
 */
export async function clearRecordings(): Promise<void> {
  const db = await open();
  const transaction = db.transaction([HEADS, SEGMENTS], "readwrite");
  const end = committed(transaction);
  transaction.objectStore(HEADS).clear();
  transaction.objectStore(SEGMENTS).clear();
  await end;
  db.close();
}

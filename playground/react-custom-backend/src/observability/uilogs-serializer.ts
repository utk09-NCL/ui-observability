// src/observability/uilogs-serializer.ts
//
// A LogSerializer for an example backend that wants its own JSON. The shape is made up for this
// example, so replace the field names with the ones of your backend:
//
//   { service, userAgent?, records: [{ ts, level, logger, message, type, sessionId, tabId,
//     journeyId?, traceId, attributes }] }
//
// The library drops a whole batch that the server refuses with 400, so one record over a limit
// would lose its 99 neighbours. A split can't fix one oversize record, so the serializer cuts the
// message and the attributes of each record to the limits of the server.
//
// A batch has no fixed size. The exit flush merges the queued batches, the batches in flight and
// the buffer into one batch, so it can hold thousands of records after a burst. The serializer
// keeps every record of the batch. The server must answer 413 for a live or stored batch that is
// too large, and the library then splits the batch in two and sends the halves. A server that
// answers 400 there makes the library drop the whole batch.
//
// The exit flush never gets a 413. A body above about 60 KB goes into the emergency queue. In this
// app it stays there, because each page load starts a new security context, and isolation keeps
// the batches of the old context apart. See the app README.

import type { LogRecord, LogSerializer, SerializedBatch } from "@utk09/ui-observability";
import { MAX_ATTRIBUTE_KEYS, MAX_ATTRIBUTES_BYTES, MAX_MESSAGE_CHARS } from "./uilogs-limits";

/** Marks an attributes object that the serializer cut. The value is how many keys it removed. */
export const CUT_MARKER = "uilogs.attributes_cut";

// The record attributes that the serializer lifts to a field of its own, so they aren't sent twice.
const LIFTED_ATTRIBUTES = new Set(["app.namespace", "log.type", "journey.id"]);

const NS_PER_MS_DIGITS = 6;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const encoder = new TextEncoder();

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Returns the time of a record as an ISO string. The nanosecond string loses its last six
 * digits, because a Number can't hold it exactly.
 * @param timeUnixNano Nanoseconds since the epoch, as a decimal string.
 * @returns ISO 8601 time with milliseconds.
 */
function isoTime(timeUnixNano: string): string {
  return new Date(Number(timeUnixNano.slice(0, -NS_PER_MS_DIGITS))).toISOString();
}

/** Returns the JSON bytes that one entry takes, with its colon and comma. 0 if JSON skips it. */
function entryBytes(key: string, value: unknown): number {
  // JSON.stringify returns undefined for a value that JSON can't write, such as undefined. The
  // library types it as string, so the type is widened here.
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) {
    return 0;
  }

  return encoder.encode(JSON.stringify(key)).length + encoder.encode(json).length + 2;
}

/**
 * Keeps the entries that fit in a key count and a byte budget. An entry that doesn't fit is
 * skipped and the next one still gets its turn, so one large value can't hide the small ones.
 */
function fit(
  entries: [string, unknown][],
  maxKeys: number,
  maxBytes: number,
): { kept: Record<string, unknown>; removed: number } {
  const kept: Record<string, unknown> = {};
  let keys = 0;
  let bytes = 2;
  let removed = 0;
  for (const [key, value] of entries) {
    const size = entryBytes(key, value);
    if (size === 0) {
      // JSON can't write this value, so the body never had it. That isn't a cut.
      continue;
    }

    if (keys < maxKeys && bytes + size <= maxBytes) {
      kept[key] = value;
      keys += 1;
      bytes += size;
    } else {
      removed += 1;
    }
  }

  return { kept, removed };
}

/**
 * Cuts attributes to the key and byte limits. A cut object has one more key, CUT_MARKER, so the
 * backend can tell a cut record from a small one.
 * @param attributes The attributes of one record.
 * @returns The attributes, or a cut copy.
 */
export function cutAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(attributes);
  const whole = fit(entries, MAX_ATTRIBUTE_KEYS, MAX_ATTRIBUTES_BYTES);
  if (whole.removed === 0) {
    return whole.kept;
  }

  // Leave room for the marker, one key and about 40 bytes.
  const cut = fit(entries, MAX_ATTRIBUTE_KEYS - 1, MAX_ATTRIBUTES_BYTES - 64);

  return { ...cut.kept, [CUT_MARKER]: cut.removed };
}

/**
 * Cuts a message to the limit. A cut between the two halves of a surrogate pair would leave a
 * lone surrogate, so the cut moves one unit back.
 * @param text The message.
 * @returns The message, at most MAX_MESSAGE_CHARS long.
 */
export function cutMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) {
    return text;
  }

  const last = text.charCodeAt(MAX_MESSAGE_CHARS - 1);
  const splitsPair = last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX;

  return text.slice(0, splitsPair ? MAX_MESSAGE_CHARS - 1 : MAX_MESSAGE_CHARS);
}

function toUilogsRecord(record: LogRecord): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.attributes)) {
    if (!LIFTED_ATTRIBUTES.has(key)) {
      attributes[key] = value;
    }
  }

  return {
    ts: isoTime(record.timeUnixNano),
    level: record.severityText,
    logger: textOf(record.attributes["app.namespace"]) ?? "",
    message: cutMessage(record.body),
    type: textOf(record.attributes["log.type"]) ?? "log",
    sessionId: textOf(record.resource["session.id"]),
    tabId: textOf(record.resource["tab.id"]),
    journeyId: textOf(record.attributes["journey.id"]),
    traceId: record.traceId,
    attributes: cutAttributes(attributes),
  };
}

/**
 * Writes a batch as the example uilogs JSON.
 * @param records The batch, in log order.
 * @returns The JSON body and its content type.
 */
function serialize(records: LogRecord[]): SerializedBatch {
  const first = records.at(0);
  const body = {
    service: textOf(first?.resource["service.name"]) ?? "unknown-service",
    userAgent: textOf(first?.resource["browser.user_agent"]),
    records: records.map(toUilogsRecord),
  };

  return { body: JSON.stringify(body), contentType: "application/json" };
}

export const uilogsSerializer: LogSerializer = { name: "uilogs", serialize };

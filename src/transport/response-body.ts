// src/transport/response-body.ts
//
// Reads the small JSON answer of an ingest server on the main thread and in the worker. The
// read stops at the request's abort signal and at RESPONSE_BODY_LIMIT_BYTES, otherwise a server
// that sends the headers and then stalls or streams forever holds the dispatch slot.

import {
  HEADER_CONTENT_TYPE,
  HTTP_PAYLOAD_TOO_LARGE,
  RESPONSE_BODY_LIMIT_BYTES,
  SERVER_MESSAGE_MAX_CHARS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { BatchKind, SerializerChoice } from "../models/config";
import { isObject } from "../utils/guards";
import { truncate } from "../utils/sanitize";

/** What an OTLP server rejected or warned about in a batch it accepted. */
export interface PartialSuccess {
  /** Number of records the server rejected. 0 means a warning only. */
  rejected: number;
  /** The server's errorMessage, cut to SERVER_MESSAGE_MAX_CHARS. Empty when it sent none. */
  message: string;
}

/** OTLP names the rejected count after the signal. */
const REJECTED_FIELDS: Record<BatchKind, string> = {
  logs: "rejectedLogRecords",
  metrics: "rejectedDataPoints",
  traces: "rejectedSpans",
};

/**
 * Checks whether a batch goes out in an OTLP format. Metrics and traces always do.
 * @param kind Kind of the batch.
 * @param serializer The log serializer option.
 * @returns True for an OTLP batch.
 */
export function isOtlpBatch(kind: BatchKind, serializer: SerializerChoice): boolean {
  return kind !== "logs" || serializer === "otlp";
}

/**
 * Checks whether the library reads a response's body. A 413 can carry a size hint, and an OTLP
 * answer in JSON can carry a partialSuccess.
 * @param response Response whose headers have arrived.
 * @param otlp True when the batch went out in an OTLP format.
 * @returns True when the body has something the library uses.
 */
export function needsBody(response: Response, otlp: boolean): boolean {
  if (response.status === HTTP_PAYLOAD_TOO_LARGE) {
    return true;
  }

  const type = response.headers.get(HEADER_CONTENT_TYPE) ?? "";
  return otlp && response.ok && type.includes("json");
}

/**
 * Reads a body that only adds detail to the status. A body that fails or runs out of time gives
 * undefined, because the server has answered and a retry would send an accepted batch again.
 * @param response Response whose headers have arrived.
 * @param signal The request's abort signal. An abort ends the read.
 * @param diagnostics Reports a read that fails.
 * @returns The text, or undefined when the read fails or the body is larger than the limit.
 */
export function readOptionalBody(
  response: Response,
  signal: AbortSignal,
  diagnostics: Diagnostics,
): Promise<string | undefined> {
  return diagnostics.guardAsync(
    "transport.http_error",
    "The library could not read the response body. It uses the status code alone.",
    () => readBodyText(response, signal),
  );
}

/**
 * Reads a response body as text, up to RESPONSE_BODY_LIMIT_BYTES.
 * @param response Response whose headers have arrived.
 * @param signal The request's abort signal. An abort ends the read.
 * @returns The text, or undefined when the body is larger than the limit.
 * @throws Error when the signal aborts or the body stream fails.
 */
async function readBodyText(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  // A browser's fetch abort also fails the stream, but a body that a service worker or a test
  // builds doesn't know the signal, so race each read against it too.
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(new Error("The request ended before its body arrived."));
    };
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }

  const readChunk = () => Promise.race([reader.read(), aborted]);
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    let chunk = await readChunk();
    while (!chunk.done) {
      size += chunk.value.byteLength;
      if (size > RESPONSE_BODY_LIMIT_BYTES) {
        // Release the connection instead of downloading the rest.
        await reader.cancel();
        return undefined;
      }

      text += decoder.decode(chunk.value, { stream: true });
      chunk = await readChunk();
    }

    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Reads the optional size hint of a 413 body, for example {"maxBytes":65536}.
 * @param text The body text.
 * @returns The hint when it's a positive safe integer, otherwise undefined.
 * @throws SyntaxError when the text isn't JSON.
 */
export function maxBytesOf(text: string): number | undefined {
  const parsed: unknown = JSON.parse(text);
  const hint = isObject(parsed) ? parsed.maxBytes : undefined;

  return typeof hint === "number" && Number.isSafeInteger(hint) && hint > 0 ? hint : undefined;
}

/**
 * Reads the partialSuccess of an OTLP export answer, for example
 * {"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"..."}}.
 * @param text The answer's body text.
 * @param kind Kind of the batch, which names the count's field.
 * @returns What the server rejected or warned about, or undefined for a full success.
 * @throws SyntaxError when the text isn't JSON.
 */
export function partialSuccessOf(text: string, kind: BatchKind): PartialSuccess | undefined {
  // OTLP allows an empty body for a full success.
  if (text.trim() === "") {
    return undefined;
  }

  const parsed: unknown = JSON.parse(text);
  const partial = isObject(parsed) ? parsed.partialSuccess : undefined;
  if (!isObject(partial)) {
    return undefined;
  }

  const rejected = countOf(partial[REJECTED_FIELDS[kind]]);
  const message =
    typeof partial.errorMessage === "string"
      ? truncate(partial.errorMessage, SERVER_MESSAGE_MAX_CHARS)
      : "";
  if (rejected === 0 && message === "") {
    return undefined;
  }

  return { rejected, message };
}

/**
 * Reads an OTLP int64 count, which JSON gives as a digit string or as a number.
 * @param value The count field.
 * @returns The count, or 0 for anything that isn't a whole number above 0.
 */
function countOf(value: unknown): number {
  // Up to 15 digits always fits in a safe integer.
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) {
    return Number(value);
  }

  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

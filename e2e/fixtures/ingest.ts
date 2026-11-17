// e2e/fixtures/ingest.ts
//
// The ports and origins of a test run, the Node-side helpers for the mock ingest server's
// test APIs, and the teardown of the library. The tests assert what the server received,
// because a console line only shows what the page meant to send.

import type { Page } from "@playwright/test";

/** Port of the page under test. ALLOWED_ORIGINS in the mock server lists its origin. */
export const PAGE_PORT = 5181;

/** Port of the second page server. ALLOWED_ORIGINS in the mock server lists its origin. */
export const CROSS_ORIGIN_PORT = 5182;

/** Port of the mock ingest server. It isn't 8787, so a running playground keeps its server. */
export const INGEST_PORT = 8791;

/** Origin of the page under test. */
export const PAGE_ORIGIN = `http://localhost:${String(PAGE_PORT)}`;

/** A second origin that serves the same files, for cross-origin frames. */
export const CROSS_ORIGIN = `http://localhost:${String(CROSS_ORIGIN_PORT)}`;

/** Origin of the mock ingest server. */
export const INGEST_ORIGIN = `http://localhost:${String(INGEST_PORT)}`;

/** The same server under a second origin, which no test puts on a trace allowlist. */
export const INGEST_OTHER_ORIGIN = `http://127.0.0.1:${String(INGEST_PORT)}`;

/** Where the page under test posts its log batches. */
export const LOGS_ENDPOINT = `${INGEST_ORIGIN}/v1/logs`;

/** Path of the fixture page on both page servers. */
export const PAGE_PATH = "/e2e/fixtures/page.html";

/** One OTLP attribute value. Only the variants the tests read are listed. */
interface OtlpValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
}

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

interface OtlpLogRecord {
  timeUnixNano: string;
  severityText: string;
  severityNumber: number;
  body: { stringValue: string };
  attributes?: OtlpAttribute[];
  traceId?: string;
  spanId?: string;
}

interface OtlpLogsPayload {
  resourceLogs?: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeLogs?: { scope?: { name?: string }; logRecords?: OtlpLogRecord[] }[];
  }[];
}

/** One request the mock server answered with 204, as GET /__received returns it. */
export interface ReceivedRequest<Payload> {
  batchId: string;
  attempt: number;
  /** Reason of the exit flush, or null for a normal send. */
  exit: string | null;
  contentType: string | null;
  /** "gzip" for a compressed body, or null. The payload is always the decoded JSON. */
  contentEncoding: string | null;
  /** True when the request had a Cookie header. The server never keeps the cookie's value. */
  hasCookie: boolean;
  /** True when the server already had this batch id, which means the client sent it twice. */
  duplicate: boolean;
  payload: Payload;
}

/** Answer of GET /__received. */
export interface Received {
  "/v1/logs": ReceivedRequest<OtlpLogsPayload>[];
  "/v1/metrics": ReceivedRequest<unknown>[];
  "/v1/traces": ReceivedRequest<unknown>[];
  "/v1/replay": ReceivedRequest<unknown>[];
}

/** One received log record with its OTLP attribute lists turned into plain objects. */
export interface ReceivedLog {
  batchId: string;
  /** Content-Encoding of the request that carried the record, or null. */
  contentEncoding: string | null;
  /** Logger namespace, which OTLP carries as the scope name. */
  scope: string | undefined;
  body: string;
  severityText: string;
  traceId: string | undefined;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}

/** Clears the server's batches, batch ids and forced statuses before a test. */
export async function resetIngest(): Promise<void> {
  const response = await fetch(`${INGEST_ORIGIN}/__reset`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`mock ingest reset answered ${String(response.status)}`);
  }
}

/** Returns every request the server answered with 204 since the last reset. */
export async function readReceived(): Promise<Received> {
  const response = await fetch(`${INGEST_ORIGIN}/__received`);
  if (!response.ok) {
    throw new Error(`mock ingest read answered ${String(response.status)}`);
  }

  return (await response.json()) as Received;
}

/** Returns the plain value of one OTLP attribute. */
function unwrap(value: OtlpValue): unknown {
  // OTLP JSON writes a 64-bit integer as a decimal string, so `qty: 3` arrives as "3".
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }

  return value.stringValue ?? value.boolValue ?? value.doubleValue;
}

function toObject(attributes: OtlpAttribute[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of attributes ?? []) {
    result[attribute.key] = unwrap(attribute.value);
  }

  return result;
}

/**
 * Returns the received log records with the given body, in the order they arrived. A batch
 * that arrived twice gives its records twice, so a double send fails a length assertion.
 */
export async function readLogs(body: string): Promise<ReceivedLog[]> {
  const received = await readReceived();
  const logs: ReceivedLog[] = [];

  for (const request of received["/v1/logs"]) {
    for (const resourceLog of request.payload.resourceLogs ?? []) {
      const resource = toObject(resourceLog.resource?.attributes);
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          if (record.body.stringValue === body) {
            logs.push({
              batchId: request.batchId,
              contentEncoding: request.contentEncoding,
              scope: scopeLog.scope?.name,
              body: record.body.stringValue,
              severityText: record.severityText,
              traceId: record.traceId,
              attributes: toObject(record.attributes),
              resource,
            });
          }
        }
      }
    }
  }

  return logs;
}

/**
 * Stops the library in every frame of the page. Firefox runs the exit flush when Playwright
 * closes the context, and without this its beacon can arrive after the next test's reset.
 */
export async function stopLibrary(page: Page): Promise<void> {
  // A child stops first, so a record it still holds can reach the parent's last flush.
  for (const frame of page.frames().reverse()) {
    // A test that failed before page.goto() leaves a frame with no test page in it.
    await frame.evaluate(async () => {
      if ("e2e" in window) {
        await window.e2e.uiobs.shutdown();
      }
    });
  }
}

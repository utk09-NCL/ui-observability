import {
  HTTP_STATUS_MAX,
  HTTP_STATUS_MIN,
  TELEMETRY_SDK_VERSION,
  TRANSPORT_WORKER_PROTOCOL,
} from "../constants";
import type { LogBatch } from "../models/batch";
import type { BatchKind } from "../models/config";
import { isLogRecord } from "../models/log-record";
import { isObject } from "../utils/guards";

/** Cloneable inputs of one worker send. Functions never cross the channel. */
export interface WorkerJob {
  batch: LogBatch;
  kind: BatchKind;
  endpoint: string;
  serializer: "otlp" | "ecs";
  headers: Record<string, string>;
  compression: "gzip" | "none";
  credentials: RequestCredentials;
  priority: RequestPriority;
  timeoutMs: number;
  deadlineMs: number;
}

/** HTTP response fields that the main thread classifies. */
export interface WorkerResponse {
  status: number;
  sampling?: string | null;
  date?: string | null;
  retryAfterMs?: number;
  maxBytes?: number;
  compressionFailed?: boolean;
}

/** A worker failure has no app exception text. */
export type WorkerResult =
  WorkerResponse | { failure: "serialize" | "network" | "timeout" | "protocol" };

/** Makes a versioned message for the private channel. */
export function workerMessage(
  type: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...fields, p: TRANSPORT_WORKER_PROTOCOL, v: TELEMETRY_SDK_VERSION, t: type };
}

/** Tests the protocol and the exact library version. */
export function isWorkerMessage(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) && value.p === TRANSPORT_WORKER_PROTOCOL && value.v === TELEMETRY_SDK_VERSION
  );
}

/** Tests a finite nonnegative hint. */
function isHint(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/** Tests a nullable response header. */
function isHeader(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** Validates a result before it changes the main transport state. */
export function isWorkerResult(value: unknown): value is WorkerResult {
  if (!isObject(value)) {
    return false;
  }
  if (value.failure !== undefined) {
    return ["serialize", "network", "timeout", "protocol"].includes(value.failure as string);
  }

  return (
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= HTTP_STATUS_MIN &&
    value.status <= HTTP_STATUS_MAX &&
    isHint(value.retryAfterMs) &&
    isHint(value.maxBytes) &&
    isHeader(value.sampling) &&
    isHeader(value.date) &&
    (value.compressionFailed === undefined || typeof value.compressionFailed === "boolean")
  );
}

/** Validates the cloneable job before the worker uses an endpoint or headers. */
export function isWorkerJob(value: unknown): value is WorkerJob {
  if (!isObject(value) || !isObject(value.batch) || !isObject(value.headers)) {
    return false;
  }

  const { batch } = value;
  return (
    typeof batch.id === "string" &&
    batch.id.length > 0 &&
    typeof batch.attempts === "number" &&
    Number.isSafeInteger(batch.attempts) &&
    batch.attempts >= 0 &&
    Array.isArray(batch.records) &&
    batch.records.length > 0 &&
    batch.records.every(isLogRecord) &&
    typeof value.endpoint === "string" &&
    /^https?:\/\//i.test(value.endpoint) &&
    ["logs", "metrics", "traces"].includes(value.kind as string) &&
    ["otlp", "ecs"].includes(value.serializer as string) &&
    ["gzip", "none"].includes(value.compression as string) &&
    ["omit", "same-origin", "include"].includes(value.credentials as string) &&
    ["low", "auto", "high"].includes(value.priority as string) &&
    typeof value.timeoutMs === "number" &&
    Number.isFinite(value.timeoutMs) &&
    value.timeoutMs > 0 &&
    typeof value.deadlineMs === "number" &&
    Number.isFinite(value.deadlineMs) &&
    value.deadlineMs > 0 &&
    Object.values(value.headers).every((header) => typeof header === "string")
  );
}

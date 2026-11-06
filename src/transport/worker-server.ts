import {
  COMPRESSION_THRESHOLD_BYTES,
  ENCODING_GZIP,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
  HEADER_DATE,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLING,
  HTTP_PAYLOAD_TOO_LARGE,
  TRANSPORT_WORKER_MAX_JOBS,
  TRANSPORT_WORKER_TYPE,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { SerializedBatch } from "../models/serializer";
import { DeadlineError, withDeadline } from "../utils/deadline";
import { isObject } from "../utils/guards";
import { runAsLibraryRequest } from "../utils/library-request";
import { estimateBytes } from "../utils/sanitize";
import { gzip } from "./compression";
import { parseRetryAfter } from "./errors";
import { otlpMetricsSerializer } from "./serializers/otlp-metrics";
import { otlpTracesSerializer } from "./serializers/otlp-traces";
import { serializerFor } from "./serializers/select";
import {
  isWorkerJob,
  isWorkerMessage,
  workerMessage,
  type WorkerJob,
  type WorkerResult,
} from "./worker-protocol";

/** Serializes and sends one worker request. The main thread owns its retry policy. */
async function deliver(
  job: WorkerJob,
  signal: AbortSignal,
  diagnostics: Diagnostics,
): Promise<WorkerResult> {
  const serialized = diagnostics.guard<SerializedBatch>(
    "transport.serialize_failed",
    "The transport worker could not serialize its batch.",
    () => {
      const serializer =
        job.kind === "metrics"
          ? otlpMetricsSerializer
          : job.kind === "traces"
            ? otlpTracesSerializer
            : serializerFor(job.serializer);
      return serializer.serialize(job.batch.records);
    },
  );
  if (!serialized) {
    return { failure: "serialize" };
  }

  const headers = new Headers(job.headers);
  headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
  let body: string | Uint8Array<ArrayBuffer> = serialized.body;
  let compressionFailed = false;
  if (job.compression === ENCODING_GZIP && estimateBytes(body) >= COMPRESSION_THRESHOLD_BYTES) {
    const compressed = await diagnostics.guardAsync(
      "transport.http_error",
      "The transport worker could not compress its batch.",
      () => gzip(serialized.body),
    );
    compressionFailed = compressed === undefined;
    if (compressed) {
      body = compressed;
      headers.set(HEADER_CONTENT_ENCODING, ENCODING_GZIP);
    }
  }

  if (signal.aborted) {
    return { failure: "network" };
  }
  if (Date.now() >= job.deadlineMs) {
    return { failure: "timeout" };
  }
  const response = await runAsLibraryRequest(() =>
    fetch(job.endpoint, {
      method: "POST",
      headers,
      body,
      credentials: job.credentials,
      signal,
      cache: "no-store",
      priority: job.priority,
    }),
  );
  const maxBytes =
    response.status === HTTP_PAYLOAD_TOO_LARGE
      ? await diagnostics.guardAsync(
          "transport.http_error",
          "The transport worker could not read the 413 response.",
          async () => {
            const parsed: unknown = JSON.parse(await response.text());
            return isObject(parsed) &&
              typeof parsed.maxBytes === "number" &&
              Number.isFinite(parsed.maxBytes) &&
              parsed.maxBytes >= 0
              ? parsed.maxBytes
              : undefined;
          },
        )
      : undefined;

  return {
    status: response.status,
    sampling: response.headers.get(HEADER_SAMPLING),
    date: response.headers.get(HEADER_DATE),
    retryAfterMs: parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER)),
    maxBytes,
    compressionFailed,
  };
}

/** Serves a private port after the worker entry accepts one connection. */
export function serveWorkerPort(port: MessagePort, diagnostics: Diagnostics): () => void {
  const pending = new Map<number, AbortController>();
  let stopped = false;
  const reply = (id: number, result: WorkerResult): void => {
    diagnostics.guard(
      "transport.http_error",
      "The transport worker could not send its result.",
      () => {
        port.postMessage(workerMessage(TRANSPORT_WORKER_TYPE.result, { id, result }));
      },
    );
  };

  const run = async (id: number, job: WorkerJob): Promise<void> => {
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      const remaining = Math.min(job.timeoutMs, job.deadlineMs - Date.now());
      if (remaining <= 0) {
        reply(id, { failure: "timeout" });
        return;
      }
      const result = await withDeadline(deliver(job, controller.signal, diagnostics), remaining);
      if (pending.get(id) === controller) {
        reply(id, result);
      }
    } catch (error) {
      diagnostics.report(
        "transport.http_error",
        "The transport worker request did not complete.",
        undefined,
        error,
      );
      if (pending.get(id) === controller) {
        reply(id, { failure: error instanceof DeadlineError ? "timeout" : "network" });
      }
    } finally {
      controller.abort();
      if (pending.get(id) === controller) {
        pending.delete(id);
      }
    }
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    diagnostics.guard(
      "transport.http_error",
      "The transport worker could not read its request.",
      () => {
        const message = event.data;
        if (
          stopped ||
          !isWorkerMessage(message) ||
          typeof message.id !== "number" ||
          !Number.isSafeInteger(message.id) ||
          message.id < 1
        ) {
          return;
        }
        const id = message.id;
        if (message.t === TRANSPORT_WORKER_TYPE.cancel) {
          pending.get(id)?.abort();
          pending.delete(id);
          return;
        }
        if (message.t !== TRANSPORT_WORKER_TYPE.send) {
          return;
        }
        if (
          !isWorkerJob(message.job) ||
          pending.has(id) ||
          pending.size >= TRANSPORT_WORKER_MAX_JOBS
        ) {
          reply(id, { failure: "protocol" });
          return;
        }
        void run(id, message.job);
      },
    );
  };

  port.addEventListener("message", onMessage);
  port.start();
  port.postMessage(workerMessage(TRANSPORT_WORKER_TYPE.ready, { ok: true }));
  return () => {
    stopped = true;
    port.removeEventListener("message", onMessage);
    for (const controller of pending.values()) {
      controller.abort();
    }
    pending.clear();
  };
}

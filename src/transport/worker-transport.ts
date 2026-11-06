import {
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HTTP_FORBIDDEN,
  HTTP_SUCCESS_END,
  HTTP_SUCCESS_MIN,
  HTTP_UNAUTHORIZED,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { BatchKind, ResolvedConfig } from "../models/config";
import type { LossReporter } from "../models/drop";
import { DeadlineError, withDeadline } from "../utils/deadline";
import { isOnline } from "../utils/platform";
import { TransportError } from "./errors";
import { resetHeaders, resolveHeaders } from "./headers";
import { HttpTransport } from "./http-transport";
import { batchKind, endpointFor } from "./serializers/select";
import { StatusTransport } from "./status-transport";
import { createWorkerClient, WorkerFault, type WorkerClient } from "./worker-client";
import type { WorkerResult } from "./worker-protocol";

/** Main-thread policy around the private worker channel. */
class WorkerTransport extends StatusTransport {
  private client: WorkerClient | undefined;

  private source: ResolvedConfig["transportWorker"];

  private disabled = false;

  constructor(
    config: ResolvedConfig,
    diagnostics: Diagnostics,
    private readonly http: HttpTransport,
    onSampling: (raw: unknown) => void,
    private readonly loss: LossReporter,
    onClock: (offsetMs: number) => void,
  ) {
    super(config, diagnostics, onSampling, loss, onClock);
  }

  /** Encodes and sends in the worker. Hidden pages keep the main HTTP keepalive path. */
  async send(batch: LogBatch, onKeepalive?: () => void): Promise<void> {
    this.assertContext(batch);
    const kind = batchKind(batch, this.config);
    const endpoint = endpointFor(kind, this.config);
    if (!endpoint) {
      this.diagnostics.count("record.dropped_no_destination");
      return;
    }
    if (batch.records.length === 0) {
      return;
    }

    const client = this.workerClient();
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    if (!client || typeof this.config.serializer !== "string" || hidden) {
      await this.http.send(batch, onKeepalive);
      return;
    }

    let result: WorkerResult;
    try {
      result = await this.attempt(client, batch, kind, endpoint, this.config.serializer);
      this.assertContext(batch);
      if (
        "status" in result &&
        (result.status === HTTP_UNAUTHORIZED || result.status === HTTP_FORBIDDEN) &&
        typeof this.config.headers === "function"
      ) {
        resetHeaders(this.http);
        result = await this.attempt(client, batch, kind, endpoint, this.config.serializer);
        this.assertContext(batch);
      }
      if ("failure" in result && result.failure === "protocol") {
        throw new WorkerFault("channel");
      }
    } catch (error) {
      this.diagnostics.report(
        "transport.http_error",
        "The transport worker request failed.",
        undefined,
        error,
      );
      this.assertContext(batch);
      if (
        error instanceof DeadlineError ||
        (error instanceof WorkerFault && error.kind === "timeout")
      ) {
        this.diagnostics.report(
          "transport.timeout",
          "The transport worker request exceeded its time limit.",
        );
        throw new TransportError(
          "timeout",
          "The transport worker request exceeded its time limit.",
        );
      }
      if (error instanceof WorkerFault && error.kind === "channel") {
        if (this.client === client) {
          this.disabled = true;
          client.close();
        }
        await this.http.send(batch, onKeepalive);
        return;
      }
      throw new TransportError("transient", "The transport worker request failed.");
    }

    if ("failure" in result) {
      if (result.failure === "serialize") {
        this.diagnostics.report(
          "transport.serialize_failed",
          "The transport worker could not serialize its batch.",
          { batchId: batch.id },
        );
        this.loss("unserializable", batch.records, [batch.id]);
        return;
      }
      const timeout = result.failure === "timeout";
      this.diagnostics.report(
        timeout ? "transport.timeout" : "transport.http_error",
        "The transport worker did not send its batch.",
      );
      // An offline failure must not use a stored attempt. The HTTP path applies the same rule.
      throw new TransportError(
        timeout ? "timeout" : isOnline() ? "transient" : "offline",
        "The transport worker did not send its batch.",
      );
    }
    if (result.compressionFailed) {
      this.diagnostics.report(
        "transport.http_error",
        "The transport worker sent its batch without gzip after a compression failure.",
      );
    }
    if (result.status >= HTTP_SUCCESS_MIN && result.status < HTTP_SUCCESS_END) {
      this.accept(kind, result.sampling, result.date);
      return;
    }
    throw this.reject(result.status, batch.id, kind, {
      retryAfterMs: result.retryAfterMs,
      maxBytes: result.maxBytes,
    });
  }

  /** Keeps throttle state from both the worker and the hidden-page HTTP path. */
  override throttledForMs(batch: LogBatch): number {
    return Math.max(super.throttledForMs(batch), this.http.throttledForMs(batch));
  }

  /** Gives the last accepted send from either path. */
  override lastSendAt(): number | null {
    const last = Math.max(super.lastSendAt() ?? -Infinity, this.http.lastSendAt() ?? -Infinity);
    return Number.isFinite(last) ? last : null;
  }

  /** Stops both paths before a delivery identity change or shutdown. */
  override stop(): void {
    super.stop();
    this.client?.close();
    this.http.stop();
  }

  private workerClient(): WorkerClient | undefined {
    const factory = this.config.transportWorker;
    if (factory !== this.source) {
      this.client?.close();
      this.client = undefined;
      this.source = factory;
      this.disabled = false;
    }
    if (!factory || this.disabled) {
      return undefined;
    }
    this.client ??= createWorkerClient(factory, this.diagnostics);
    return this.client;
  }

  /** One deadline covers the main headers function and the worker operation. */
  private async attempt(
    client: WorkerClient,
    batch: LogBatch,
    kind: BatchKind,
    endpoint: string,
    serializer: "otlp" | "ecs",
  ): Promise<WorkerResult> {
    const timeoutMs = this.config.delivery.requestTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const values = await withDeadline(
      this.untilCancelled(resolveHeaders(this.http, this.config, this.diagnostics)),
      timeoutMs,
    );
    this.assertContext(batch);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DeadlineError(timeoutMs);
    }
    const headers = new Headers(values);
    headers.set(HEADER_BATCH_ID, batch.id);
    headers.set(HEADER_ATTEMPT, String(batch.attempts));
    return client.send(
      {
        batch,
        kind,
        endpoint,
        serializer,
        headers: Object.fromEntries(headers),
        compression: this.config.compression,
        credentials: this.config.credentials,
        priority: this.config.delivery.priority,
        timeoutMs: remaining,
        deadlineMs: deadline,
      },
      this.cancellation.signal,
      remaining,
    );
  }
}

/** Creates the worker adapter without adding a package entry point or a runtime dependency. */
export function createWorkerTransport(
  config: ResolvedConfig,
  diagnostics: Diagnostics,
  onSampling: (raw: unknown) => void,
  onLoss: LossReporter,
  onClock: (offsetMs: number) => void,
): { transport: StatusTransport; exitHeaders: () => Record<string, string> | undefined } {
  const http = new HttpTransport(config, diagnostics, onSampling, onLoss, onClock);
  return {
    transport: new WorkerTransport(config, diagnostics, http, onSampling, onLoss, onClock),
    exitHeaders: () => http.lastHeaders(),
  };
}

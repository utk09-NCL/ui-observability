// src/core/sender.ts
//
// Builds the delivery stack for the sender role: storage, transport, retry, pipeline and
// exit flush.
// The runtime imports this module dynamically, and only when the config sets an endpoint,
// so console-only mode never downloads it.

import { STORAGE_NAME_INDEXEDDB, STORAGE_NAME_LOCAL } from "../constants";
import type { LogBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { LossReporter } from "../models/drop";
import type { DeliveryHealth } from "../models/health";
import type { LogRecord } from "../models/log-record";
import {
  type GapReporter,
  type StorageAdapter,
  type StoragePersistence,
  storageLimits,
} from "../models/storage";
import { clearEmergencyContext, drainEmergencyQueue } from "../storage/emergency-queue";
import { createStorage, storageName } from "../storage/factory";
import { ContextStorage } from "../storage/context-storage";
import { requestPersistence } from "../storage/persistence";
import { withDeadline } from "../utils/deadline";
import { ExitFlush } from "../transport/exit-flush";
import { CustomTransport } from "../transport/custom-transport";
import { HttpTransport } from "../transport/http-transport";
import { RetryEngine } from "../transport/retry-engine";
import type { BatchTransport, StatusTransport } from "../transport/status-transport";
import type { Diagnostics } from "./diagnostics";
import { type FlushCounts, LogPipeline } from "./pipeline";
import { applyRemote, parseRemoteRules } from "./remote-rules";
import type { RemoteSlot } from "./remote-sampling";

/** Inputs to build the delivery stack. */
export interface SenderDeps {
  /** Memory store that this runtime keeps when the security context changes. */
  storage?: StorageAdapter;
  onStorage?: (storage: StorageAdapter) => void;
  /** Receives the state of the persistent-storage request. */
  onPersistence?: (state: StoragePersistence) => void;
  /** Active configuration instance. */
  config: ResolvedConfig;
  /** Diagnostics reporter. */
  diagnostics: Diagnostics;
  /** Receives a report when storage drops batches before delivery. */
  onGap: GapReporter;
  /** Receives the records lost by the transport, the retry engine and the exit flush. */
  onLoss: LossReporter;
  /** The runtime's slot for the sampling rules from the ingest server. */
  remote: RemoteSlot;
  /** Sends the open metric interval's points before the exit flush drains the buffers. */
  beforeExit?: () => void;
  /**
   * Receives the time of the last accepted batch after a send. The runtime keeps it across a
   * rotation, which builds a new sender.
   */
  onSent?: (at: number) => void;
}

/** What the sender adds to getHealth().delivery. The runtime adds the rest. */
export type SenderStats = Pick<
  DeliveryHealth,
  "pending" | "inFlight" | "lastFailureAt" | "consecutiveFailures" | "throttledUntil"
>;

/**
 * Counts the failed sends of the pipeline and the retry engine for getHealth(). The exit flush
 * can't learn its result, so it doesn't count.
 */
class SendOutcomes implements BatchTransport {
  /** Failed sends since the server last accepted a batch. */
  private failures = 0;

  /** Epoch time in milliseconds of the last failed send, or null. */
  private failedAt: number | null = null;

  /**
   * @param transport The transport that sends the batches.
   * @param onSent Receives the time of the last accepted batch after a send.
   */
  constructor(
    private readonly transport: StatusTransport,
    private readonly onSent: (at: number) => void = () => undefined,
  ) {}

  /**
   * Sends one batch and counts the result.
   * @param batch Batch to send.
   * @param onKeepalive Runs when one of the batch's requests starts with keepalive.
   * @returns Promise that resolves to the records lost in a send that ends without an error.
   * @throws TransportError when the batch isn't accepted.
   */
  async send(batch: LogBatch, onKeepalive?: () => void): Promise<number> {
    const before = this.transport.lastSendAt();
    let lost: number;
    try {
      lost = await this.transport.send(batch, onKeepalive);
    } catch (error) {
      this.failures++;
      this.failedAt = Date.now();
      throw error;
    }

    // A batch with no request, for example a traces batch with no tracesEndpoint, ends without
    // an error but proves nothing, so only an accept during this send resets the count.
    const at = this.transport.lastSendAt();
    if (at !== null && at !== before) {
      this.failures = 0;
      this.onSent(at);
    }

    return lost;
  }

  /**
   * Returns the remaining throttle delay for a batch's endpoint.
   * @param batch Batch to send.
   * @returns Milliseconds until the throttle ends, or 0.
   */
  throttledForMs(batch: LogBatch): number {
    return this.transport.throttledForMs(batch);
  }

  /**
   * Reads the failure counts.
   * @returns The failures in a row and the time of the last one.
   */
  stats(): Pick<SenderStats, "lastFailureAt" | "consecutiveFailures"> {
    return { lastFailureAt: this.failedAt, consecutiveFailures: this.failures };
  }
}

/** Delivery stack for one sender runtime. */
export class Sender {
  /** True after retire(), so a late emergency import doesn't wake the retry engine. */
  private retired = false;
  /** Emergency queue import. retire() waits for it before reading storage. */
  private emergencyImport: Promise<void> = Promise.resolve();

  /**
   * @param storage Storage adapter for undelivered batches.
   * @param retry Retry engine for stored batches.
   * @param pipeline Pipeline that batches records.
   * @param exitFlush Handler that sends pending records on unload.
   * @param diagnostics Diagnostics reporter.
   * @param transport The transport that the pipeline and the retry engine use.
   * @param outcomes Counts the failed sends of the pipeline and the retry engine.
   */
  private constructor(
    private readonly storage: ContextStorage,
    private readonly retry: RetryEngine,
    private readonly pipeline: LogPipeline,
    private readonly exitFlush: ExitFlush,
    private readonly diagnostics: Diagnostics,
    private readonly transport: StatusTransport,
    private readonly outcomes: SendOutcomes,
  ) {}

  /**
   * Builds the delivery stack and starts the retry loop. The emergency queue import runs
   * after the start, so a slow IndexedDB open doesn't hold up the boot buffer.
   * @param deps Configuration, diagnostics and gap reporter.
   * @returns Promise that resolves to the started sender.
   */
  static async create(deps: SenderDeps): Promise<Sender> {
    const { config, diagnostics } = deps;

    const backing =
      deps.storage ??
      (await createStorage(
        config.storage.backend,
        storageName(config.storage.namespace),
        storageLimits(config.retention),
        diagnostics,
        deps.onGap,
        config.storage.namespace,
      ));
    deps.onStorage?.(backing);

    // Ask only for a store that outlives the page.
    if (
      config.storage.requestPersistent &&
      (backing.name === STORAGE_NAME_INDEXEDDB || backing.name === STORAGE_NAME_LOCAL)
    ) {
      deps.onPersistence?.("pending");
      void requestPersistence(diagnostics).then(deps.onPersistence);
    }

    const storage = new ContextStorage(backing, config.securityContext, config.storage.namespace);
    const onSampling = (raw: unknown): void => {
      const update = parseRemoteRules(raw, diagnostics);

      if (update) {
        applyRemote(deps.remote, config, update);
      }
    };

    // The clock offset from the last accepted response. The pipeline adds it to new records.
    let clockOffsetMs: number | undefined;
    const onClock = (offsetMs: number): void => {
      clockOffsetMs = offsetMs;
    };

    // The stack keeps one transport for its whole life, and the runtime refuses a later change.
    // The exit flush reads the last headers and the keepalive bytes in flight from the HTTP
    // transport.
    const { onLoss } = deps;
    const worker =
      !config.transport && config.transportWorker
        ? await diagnostics.guardAsync(
            "transport.http_error",
            "The transport worker module did not load. The library uses HTTP.",
            async () =>
              (await import("../transport/worker-transport")).createWorkerTransport(
                config,
                diagnostics,
                onSampling,
                onLoss,
                onClock,
              ),
          )
        : undefined;
    const http =
      config.transport !== undefined || worker !== undefined
        ? undefined
        : new HttpTransport(config, diagnostics, onSampling, onLoss, onClock);
    const transport: StatusTransport =
      worker?.transport ??
      http ??
      new CustomTransport(config, diagnostics, onSampling, onLoss, onClock);
    const outcomes = new SendOutcomes(transport, deps.onSent);
    const retry = new RetryEngine(storage, outcomes, diagnostics, config, undefined, onLoss);
    const { batching } = config;
    const pipeline = new LogPipeline(
      outcomes,
      storage,
      retry,
      diagnostics,
      {
        logs: { flushIntervalMs: batching.logFlushIntervalMs, batchSize: batching.logBatchSize },
        metrics: {
          // Read on each batch, so a later metrics.intervalMs applies here as it does to the meter.
          get flushIntervalMs() {
            return config.metrics.intervalMs;
          },
          batchSize: batching.metricBatchSize,
        },
        // A span is the size of a log record, so the traces stream uses the log batching.
        traces: { flushIntervalMs: batching.logFlushIntervalMs, batchSize: batching.logBatchSize },
      },
      () => config.securityContext.id || undefined,
      config,
      onLoss,
      () => (config.metadata.clockOffset ? clockOffsetMs : undefined),
    );

    const exitFlush = new ExitFlush({
      config,
      diagnostics,
      drainForExit: () => pipeline.drainForExit(),
      flushAlive: () => pipeline.flushPending(),
      exitHeaders: () => (worker ? worker.exitHeaders() : http?.lastHeaders()),
      keepaliveInFlight: () => (worker ? worker.keepaliveInFlight() : http?.keepaliveInFlight()),
      onLoss,
      beforeExit: deps.beforeExit,
    });

    // If one step fails, stop both. A retry loop with no owner would keep sending after the
    // load reports failure.
    let started = false;

    try {
      exitFlush.install();
      retry.start();
      started = true;
    } finally {
      if (!started) {
        exitFlush.uninstall();
        retry.stop();
      }
    }

    const sender = new Sender(
      storage,
      retry,
      pipeline,
      exitFlush,
      diagnostics,
      transport,
      outcomes,
    );
    sender.emergencyImport = sender.importEmergency();
    return sender;
  }

  /**
   * Adds a record to the pipeline.
   * @param record Record to deliver.
   */
  push(record: LogRecord): void {
    this.pipeline.push(record);
  }

  /**
   * Stops every send while `enabled` is false, or starts again. The records stay in memory and
   * the stored batches stay in storage, so they go out after the pause.
   * @param on True to stop.
   */
  hold(on: boolean): void {
    this.pipeline.hold(on);

    if (on) {
      this.exitFlush.uninstall();
      this.retry.stop();
      return;
    }

    this.exitFlush.install();
    this.retry.start();
  }

  /**
   * Lists the records that only memory holds. Nothing sends them during a pause.
   * @returns The pipeline's records.
   */
  records(): LogRecord[] {
    return this.pipeline.records();
  }

  /**
   * Sends the records in the stream buffers, then waits for every batch in flight.
   * @returns Promise that resolves once the pipeline has sent or stored every batch.
   */
  async flush(): Promise<void> {
    await this.pipeline.flushPending();
  }

  /**
   * Sends the records in the stream buffers, then waits for this call's batches until each one
   * ends or the deadline passes.
   * @param expired Resolves at the caller's deadline.
   * @returns The records of the call's batches by their state when the wait ends.
   */
  flushUntil(expired: Promise<void>): Promise<FlushCounts> {
    return this.pipeline.flushUntil(expired);
  }

  /**
   * Counts the batches held in storage.
   * @returns Promise that resolves to the batch count, or 0 if storage fails.
   */
  async queueDepth(): Promise<number> {
    const count = await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not count the batches in storage.",
      () => this.storage.count(),
    );

    return count ?? 0;
  }

  /**
   * Reads the delivery state of the pipeline and the transport.
   * @returns Waiting records, records in requests, the failures and the throttle end.
   */
  stats(): SenderStats {
    return {
      ...this.pipeline.counts(),
      ...this.outcomes.stats(),
      throttledUntil: this.transport.throttleEnd(),
    };
  }

  /**
   * Sends pending records with a normal flush, then with the exit flush, then stops all
   * timers and listeners and closes storage. The normal flush keeps the headers, gzip and
   * the retry. The exit flush picks up the records the normal flush didn't confirm.
   * @returns Promise that resolves when storage closes.
   */
  async destroy(): Promise<void> {
    await this.diagnostics.guardAsync("pipeline.crashed", "The flush before shutdown failed.", () =>
      this.flush(),
    );

    // A held sender sends nothing, not even at shutdown.
    if (!this.pipeline.isHeld()) {
      this.exitFlush.flush("shutdown");
    }
    this.exitFlush.uninstall();
    this.retry.stop();
    this.transport.stop();
    this.pipeline.destroy();

    await this.storage.close();
  }

  /**
   * Stops every send without a flush or an exit flush, for a discard at shutdown. A request in
   * flight can still reach the server, but its result writes nothing and schedules no retry,
   * because the store accepts no write after this.
   * @returns Promise that resolves to the records in the buffers and the queue, once the
   * emergency import is done and the store is closed.
   */
  async discard(): Promise<LogRecord[]> {
    this.retired = true;
    this.exitFlush.uninstall();
    this.retry.stop();
    this.transport.stop();
    const records = this.pipeline.discard();
    // The import moves the previous page's batches into the store, so let it end before the
    // store stops writes. Otherwise a batch it claimed would be lost.
    await this.emergencyImport;
    await this.storage.retire(false);
    return records;
  }

  /**
   * Stops every send after a rotation fails, and stores the records from memory under the old
   * id. The store stays open, so the next rotation that succeeds can apply its rule to them.
   * @param contextId Identity of the closed delivery context.
   * @returns Promise that resolves once the records are stored.
   */
  async pause(contextId: string): Promise<void> {
    this.retired = true;
    this.exitFlush.uninstall();
    this.retry.stop();
    this.transport.stop();
    const drained = this.pipeline.drainForExit();
    this.pipeline.destroy();
    await this.emergencyImport;
    await this.keep(drained, contextId);
  }

  /**
   * Stores whole batches under a context id. One batch per record would fill
   * retention.maxBatches.
   * @param batches Batches from the pipeline.
   * @param contextId Identity of their delivery context.
   * @returns Promise that resolves once each batch is stored.
   */
  private async keep(batches: readonly LogBatch[], contextId: string): Promise<void> {
    for (const batch of batches) {
      await this.storage.save({
        ...batch,
        routingContextId: contextId,
        persistenceNamespace: this.storage.namespace,
      });
    }
  }

  /**
   * Stops this sender before a new delivery identity takes effect. Does not run exit delivery.
   * @param policy Rule for the old records.
   * @param timeoutMs Maximum wait for a flush, in milliseconds.
   * @param contextId Identity of the old delivery context.
   * @returns The records that were in memory and the batches that were stored, after the
   * delivery attempt.
   */
  async retire(
    policy: "discard" | "flush" | "retain" | "carry",
    timeoutMs: number,
    contextId: string,
  ): Promise<{ buffered: LogRecord[]; stored: LogBatch[] }> {
    this.retired = true;
    this.exitFlush.uninstall();
    this.retry.stop();
    // A held sender sends nothing, so "flush" acts as "discard" during a pause.
    if (policy === "flush" && !this.pipeline.isHeld()) {
      try {
        await withDeadline(Promise.all([this.flush(), this.retry.flush()]), timeoutMs);
      } catch (error) {
        // The remaining records follow the selected rule.
        this.diagnostics.report(
          "transport.timeout",
          "The flush of the old security context did not complete before its time limit.",
          undefined,
          error,
        );
      }
    }
    this.retry.stop();
    this.transport.stop();
    const drained = this.pipeline.drainForExit();
    const buffered = drained.flatMap((batch) => batch.records);
    this.pipeline.destroy();
    await this.emergencyImport;
    const stored = await this.storage.take(Number.MAX_SAFE_INTEGER);
    if (policy === "retain") {
      await this.keep(drained, contextId);
    }
    // "carry" keeps the stored batches until adopt() stores each one again under the new id.
    // If the tab closes during the carry, the rest are parked, not lost.
    const discard = policy === "discard" || policy === "flush";
    await this.storage.retire(discard);
    if (discard) {
      clearEmergencyContext(contextId, this.diagnostics, this.storage.namespace);
    }
    return { buffered, stored };
  }

  /**
   * Stores an earlier context's batches under this context, and the retry engine then sends
   * them. They don't go through the live buffer, because a large backlog would exceed its
   * budget.
   * @param batches The earlier context's stored batches.
   * @param contextId Identity of this delivery context.
   * @returns Promise that resolves when the batches are stored.
   */
  async adopt(batches: readonly LogBatch[], contextId: string): Promise<void> {
    for (const batch of batches) {
      // The same id replaces the old copy. Attempts against the old destination don't count here.
      await this.storage.save({
        ...batch,
        attempts: 0,
        routingContextId: contextId,
        persistenceNamespace: this.storage.namespace,
      });
    }

    if (batches.length > 0) {
      this.retry.nudge();
    }
  }

  /**
   * Moves the emergency queue's batches into storage, then wakes the retry engine.
   * The previous page load parked them during its unload.
   */
  private async importEmergency(): Promise<void> {
    const moved = await this.diagnostics.guardAsync(
      "storage.degraded",
      "The emergency import failed.",
      () =>
        drainEmergencyQueue(
          this.storage,
          this.diagnostics,
          (batch) => this.storage.accepts(batch),
          this.storage.namespace,
        ),
    );

    if (!this.retired && moved !== undefined && moved > 0) {
      this.retry.nudge();
    }
  }
}

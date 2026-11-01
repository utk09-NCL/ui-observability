// src/core/sender.ts
//
// This module builds the delivery stack of the sender role.
// The stack has storage, transport, retry, pipeline and exit flush.
// The runtime imports this module dynamically only when the config sets an endpoint.
// Console-only mode does not download this module.

import type { LogBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import type { LossReporter } from "../models/drop";
import type { LogRecord } from "../models/log-record";
import type { DeliveryStats } from "../models/stats";
import { type GapReporter, type StorageAdapter, storageLimits } from "../models/storage";
import { clearEmergencyContext, drainEmergencyQueue } from "../storage/emergency-queue";
import { createStorage, storageName } from "../storage/factory";
import { ContextStorage } from "../storage/context-storage";
import { withDeadline } from "../utils/deadline";
import { ExitFlush } from "../transport/exit-flush";
import { CustomTransport } from "../transport/custom-transport";
import { HttpTransport } from "../transport/http-transport";
import { RetryEngine } from "../transport/retry-engine";
import type { StatusTransport } from "../transport/status-transport";
import type { Diagnostics } from "./diagnostics";
import { LogPipeline } from "./pipeline";
import { applyRemote, parseRemoteRules } from "./remote-rules";
import type { RemoteSlot } from "./remote-sampling";

/** Inputs to build the delivery stack. */
export interface SenderDeps {
  /** Memory store that this runtime keeps when the security context changes. */
  storage?: StorageAdapter;
  onStorage?: (storage: StorageAdapter) => void;
  /** Active configuration instance. */
  config: ResolvedConfig;
  /** Diagnostics reporter. */
  diagnostics: Diagnostics;
  /** Receives a report when storage drops batches before delivery. */
  onGap: GapReporter;
  /** Receives the records that the transport, the retry engine and the exit flush lose. */
  onLoss: LossReporter;
  /** Slot of the runtime for the sampling rules from the ingest server. */
  remote: RemoteSlot;
  /** Sends the points of the open metric interval before the exit flush drains the buffers. */
  beforeExit?: () => void;
}

/** Delivery stack for one sender runtime. */
export class Sender {
  /** True after retire(). A late emergency import then does not wake the retry engine. */
  private retired = false;
  /** Emergency queue import. retire() waits for it before it reads storage. */
  private emergencyImport: Promise<void> = Promise.resolve();

  /**
   * @param storage Storage adapter for undelivered batches.
   * @param retry Retry engine for stored batches.
   * @param pipeline Pipeline that batches records.
   * @param exitFlush Handler that sends pending records on unload.
   * @param diagnostics Diagnostics reporter.
   * @param transport Transport of the pipeline and the retry engine.
   */
  private constructor(
    private readonly storage: ContextStorage,
    private readonly retry: RetryEngine,
    private readonly pipeline: LogPipeline,
    private readonly exitFlush: ExitFlush,
    private readonly diagnostics: Diagnostics,
    private readonly transport: StatusTransport,
  ) {}

  /**
   * Builds the delivery stack and starts the retry loop. The emergency queue import runs
   * after the start. A slow IndexedDB open then does not hold the boot buffer.
   * @param deps Configuration, diagnostics and gap reporter.
   * @returns Promise that resolves to the started sender.
   */
  static async create(deps: SenderDeps): Promise<Sender> {
    const { config, diagnostics } = deps;

    const backing =
      deps.storage ??
      (await createStorage(
        config.storage,
        storageName(config.persistence.namespace),
        storageLimits(config.retention),
        diagnostics,
        deps.onGap,
        config.persistence.namespace,
      ));
    deps.onStorage?.(backing);
    const storage = new ContextStorage(
      backing,
      config.securityContext,
      config.persistence.namespace,
    );
    const onSampling = (raw: unknown): void => {
      const update = parseRemoteRules(raw, diagnostics);

      if (update) {
        applyRemote(deps.remote, config, update);
      }
    };

    // The stack keeps one transport for its life. The runtime refuses a later change.
    // The exit flush reads the last headers from the HTTP transport.
    const { onLoss } = deps;
    const http = config.transport
      ? undefined
      : new HttpTransport(config, diagnostics, onSampling, onLoss);
    const transport: StatusTransport =
      http ?? new CustomTransport(config, diagnostics, onSampling, onLoss);
    const retry = new RetryEngine(storage, transport, diagnostics, config, undefined, onLoss);
    const { batching } = config;
    const pipeline = new LogPipeline(
      transport,
      storage,
      retry,
      diagnostics,
      {
        logs: { flushIntervalMs: batching.logFlushIntervalMs, batchSize: batching.logBatchSize },
        metrics: {
          flushIntervalMs: batching.metricFlushIntervalMs,
          batchSize: batching.metricBatchSize,
        },
        // A span has the size of a log record. The traces stream uses the log batching.
        traces: { flushIntervalMs: batching.logFlushIntervalMs, batchSize: batching.logBatchSize },
      },
      () => config.securityContext.id || undefined,
      config,
      onLoss,
    );

    const exitFlush = new ExitFlush({
      config,
      diagnostics,
      drainForExit: () => pipeline.drainForExit(),
      flushAlive: () => pipeline.flushPending(),
      exitHeaders: () => http?.lastHeaders(),
      onLoss,
      beforeExit: deps.beforeExit,
    });

    // If one step fails, stop both. A retry loop with no owner sends after load reports failure.
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

    const sender = new Sender(storage, retry, pipeline, exitFlush, diagnostics, transport);
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
   * Sends the records in the stream buffers. Then it waits for each batch in flight.
   * @returns Promise that resolves when the pipeline sends or stores each batch.
   */
  async flush(): Promise<void> {
    await this.pipeline.flushPending();
  }

  /**
   * Removes stored normal and emergency batches without sending them.
   * @param scope Part of storage to clear.
   * @param contextId Active delivery context id.
   * @returns Promise that resolves when removal completes.
   */
  async clearPersisted(scope: "context" | "namespace", contextId: string): Promise<void> {
    if (scope === "namespace") await this.storage.clearNamespace();
    else await this.storage.clear();
    clearEmergencyContext(
      contextId,
      this.diagnostics,
      this.storage.namespace,
      scope === "namespace",
    );
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
   * @returns Records that wait, records in requests and the last accepted send.
   */
  stats(): Omit<DeliveryStats, "stored"> {
    return { ...this.pipeline.counts(), lastSendAt: this.transport.lastSendAt() };
  }

  /**
   * Sends pending records with a normal flush, then with the exit flush. Then it stops all
   * timers and listeners. Then it closes storage. The normal flush keeps the headers, gzip
   * and the retry. The exit flush takes the records that the normal flush did not confirm.
   * @returns Promise that resolves when storage closes.
   */
  async destroy(): Promise<void> {
    await this.diagnostics.guardAsync("pipeline.crashed", "The flush before shutdown failed.", () =>
      this.flush(),
    );

    this.exitFlush.flush("shutdown");
    this.exitFlush.uninstall();
    this.retry.stop();
    this.pipeline.destroy();

    await this.storage.close();
  }

  /**
   * Stops this sender before a new delivery identity takes effect. It does not run exit delivery.
   * @param policy Rule for the old records.
   * @param timeoutMs Maximum wait for a flush, in milliseconds.
   * @param contextId Identity of the old delivery context.
   * @returns Records that were in memory, and the batches that were stored, after the delivery attempt.
   */
  async retire(
    policy: "discard" | "flush" | "retain" | "carry",
    timeoutMs: number,
    contextId: string,
  ): Promise<{ buffered: LogRecord[]; stored: LogBatch[] }> {
    this.retired = true;
    this.exitFlush.uninstall();
    this.retry.stop();
    if (policy === "flush") {
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
      // Store the drained batches whole. One batch for each record fills retention.maxBatches.
      for (const batch of drained) {
        await this.storage.save({
          ...batch,
          routingContextId: contextId,
          persistenceNamespace: this.storage.namespace,
        });
      }
    }
    // "carry" keeps the stored batches until adopt() stores each one again under the new id.
    // A tab that closes during the carry then parks the rest. It does not lose them.
    const discard = policy === "discard" || policy === "flush";
    await this.storage.retire(discard);
    if (discard) {
      clearEmergencyContext(contextId, this.diagnostics, this.storage.namespace);
    }
    return { buffered, stored };
  }

  /**
   * Stores batches of an earlier context under this context. Then the retry engine sends them.
   * The live buffer does not take them. A large backlog would exceed its budget.
   * @param batches Stored batches of the earlier context.
   * @param contextId Identity of this delivery context.
   * @returns Promise that resolves when the batches are stored.
   */
  async adopt(batches: readonly LogBatch[], contextId: string): Promise<void> {
    for (const batch of batches) {
      // The same id replaces the old copy. The attempts of the old destination do not count here.
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
   * Moves the batches of the emergency queue into storage, then wakes the retry engine.
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

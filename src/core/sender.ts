// src/core/sender.ts
//
// This module builds the delivery stack of the sender role.
// The stack has storage, transport, retry, pipeline and exit flush.
// The runtime imports this module dynamically only when the config sets an endpoint.
// Console-only mode does not download this module.

import { STORAGE_DB_NAME, STORAGE_LIMITS } from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogRecord } from "../models/log-record";
import type { GapReporter, StorageAdapter } from "../models/storage";
import { drainEmergencyQueue } from "../storage/emergency-queue";
import { createStorage } from "../storage/factory";
import { ExitFlush } from "../transport/exit-flush";
import { CustomTransport } from "../transport/custom-transport";
import { HttpTransport } from "../transport/http-transport";
import { RetryEngine } from "../transport/retry-engine";
import type { BatchTransport } from "../transport/status-transport";
import type { Diagnostics } from "./diagnostics";
import { LogPipeline } from "./pipeline";
import { applyRemote, parseRemoteRules } from "./remote-rules";
import type { RemoteSlot } from "./remote-sampling";

/** Inputs to build the delivery stack. */
export interface SenderDeps {
  /** Active configuration instance. */
  config: ResolvedConfig;
  /** Diagnostics reporter. */
  diagnostics: Diagnostics;
  /** Receives a report when storage drops batches before delivery. */
  onGap: GapReporter;
  /** Slot of the runtime for the sampling rules from the ingest server. */
  remote: RemoteSlot;
}

/** Delivery stack for one sender runtime. */
export class Sender {
  /**
   * @param storage Storage adapter for undelivered batches.
   * @param retry Retry engine for stored batches.
   * @param pipeline Pipeline that batches records.
   * @param exitFlush Handler that sends pending records on unload.
   * @param diagnostics Diagnostics reporter.
   */
  private constructor(
    private readonly storage: StorageAdapter,
    private readonly retry: RetryEngine,
    private readonly pipeline: LogPipeline,
    private readonly exitFlush: ExitFlush,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Builds the delivery stack and starts the retry loop. The emergency queue import runs
   * after the start. A slow IndexedDB open then does not hold the boot buffer.
   * @param deps Configuration, diagnostics and gap reporter.
   * @returns Promise that resolves to the started sender.
   */
  static async create(deps: SenderDeps): Promise<Sender> {
    const { config, diagnostics } = deps;

    const storage = await createStorage(
      config.storage,
      STORAGE_DB_NAME,
      STORAGE_LIMITS,
      diagnostics,
      deps.onGap,
    );
    const onSampling = (raw: unknown): void => {
      const update = parseRemoteRules(raw, diagnostics);

      if (update) {
        applyRemote(deps.remote, config, update);
      }
    };

    // The stack keeps one transport for its life. The runtime refuses a later change.
    // The exit flush reads the last headers from the HTTP transport.
    const http = config.transport ? undefined : new HttpTransport(config, diagnostics, onSampling);
    const transport: BatchTransport = http ?? new CustomTransport(config, diagnostics, onSampling);
    const retry = new RetryEngine(storage, transport, diagnostics, config);
    const pipeline = new LogPipeline(transport, storage, retry, diagnostics);

    const exitFlush = new ExitFlush({
      config,
      diagnostics,
      drainForExit: () => pipeline.drainForExit(),
      flushAlive: () => pipeline.flushPending(),
      exitHeaders: () => http?.lastHeaders(),
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

    const sender = new Sender(storage, retry, pipeline, exitFlush, diagnostics);
    void sender.importEmergency();
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
   * Moves the batches of the emergency queue into storage, then wakes the retry engine.
   * The previous page load parked them during its unload.
   */
  private async importEmergency(): Promise<void> {
    const moved = await this.diagnostics.guardAsync(
      "storage.degraded",
      "The emergency import failed.",
      () => drainEmergencyQueue(this.storage, this.diagnostics),
    );

    if (moved !== undefined && moved > 0) {
      this.retry.nudge();
    }
  }
}

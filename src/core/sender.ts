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
import { HttpTransport } from "../transport/http-transport";
import { RetryEngine } from "../transport/retry-engine";
import type { Diagnostics } from "./diagnostics";
import { LogPipeline } from "./pipeline";

/** Inputs to build the delivery stack. */
export interface SenderDeps {
  /** Active configuration instance. */
  config: ResolvedConfig;
  /** Diagnostics reporter. */
  diagnostics: Diagnostics;
  /** Receives a report when storage drops batches before delivery. */
  onGap: GapReporter;
}

/** Delivery stack for one sender runtime. */
export class Sender {
  /**
   * @param storage Storage adapter for undelivered batches.
   * @param transport HTTP transport for live delivery.
   * @param retry Retry engine for stored batches.
   * @param pipeline Pipeline that batches records.
   * @param exitFlush Handler that sends pending records on unload.
   * @param diagnostics Diagnostics reporter.
   */
  private constructor(
    private readonly storage: StorageAdapter,
    private readonly transport: HttpTransport,
    private readonly retry: RetryEngine,
    private readonly pipeline: LogPipeline,
    private readonly exitFlush: ExitFlush,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Builds the delivery stack, drains the emergency queue and starts the retry loop.
   * @param deps Configuration, diagnostics and gap reporter.
   * @returns Promise resolving to the started sender.
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
    const transport = new HttpTransport(config, diagnostics);
    const retry = new RetryEngine(storage, transport, diagnostics, config);
    const pipeline = new LogPipeline(transport, storage, retry, diagnostics);

    const exitFlush = new ExitFlush({
      config,
      diagnostics,
      drainForExit: () => pipeline.drainForExit(),
      drainPending: () => pipeline.drainPending(),
    });

    await drainEmergencyQueue(storage, diagnostics);

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

    return new Sender(storage, transport, retry, pipeline, exitFlush, diagnostics);
  }

  /**
   * Adds a record to the pipeline.
   * @param record Record to deliver.
   */
  push(record: LogRecord): void {
    this.pipeline.push(record);
  }

  /**
   * Sends the records held in the stream buffers.
   * @returns Promise resolving when the batch is sent or stored for retry.
   */
  async flush(): Promise<void> {
    const batch = this.pipeline.drainPending();

    if (!batch) {
      return;
    }

    try {
      await this.transport.send(batch);
    } catch (error) {
      await this.diagnostics.guardAsync(
        "storage.degraded",
        "The library could not store the batch that flush() drained.",
        // The retry engine classifies the failure. It splits the batch on a 413, as the drain does.
        async () => {
          await this.retry.storeFailed({ ...batch, attempts: batch.attempts + 1 }, error);
        },
      );
      this.diagnostics.report(
        "transport.http_error",
        "The send from flush() failed. The library stored the batch for a retry.",
        { batchId: batch.id, records: batch.records.length },
        error,
      );
    }
  }

  /**
   * Counts the batches held in storage.
   * @returns Promise resolving to the batch count, or 0 if storage fails.
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
   * Sends pending records and stops all timers and listeners. Then it closes storage.
   * The synchronous steps run before the first await. The runtime relies on this order.
   * @returns Promise resolving when storage is closed.
   */
  async destroy(): Promise<void> {
    this.exitFlush.flush("shutdown");
    this.exitFlush.uninstall();
    this.retry.stop();
    this.pipeline.destroy();

    await this.storage.close();
  }
}

// src/core/runtime.ts
//
// Central coordination runtime managing subsystem lifecycles, configuration, and telemetry routing.

import { Bus } from "../bus/bus";
import type { Receive, WorkerLike } from "../bus/links";
import { ErrorCapture } from "../capture/errors";
import { InteractionCapture } from "../capture/interactions";
import { NetworkCapture } from "../capture/network";
import type { Capture } from "../capture/types";
import { WebVitalsCapture } from "../capture/web-vitals";
import {
  CAPTURE_NAMESPACE,
  GAP_REPORT_THROTTLE_MS,
  RUNTIME_GLOBAL_KEY,
  STORAGE_NAMESPACE,
  TAB_ID_KEY,
} from "../constants";
import type { BusMessage } from "../models/bus";
import type { ObservabilityConfig, ResolvedConfig } from "../models/config";
import { isLogRecord, type LogRecord } from "../models/log-record";
import type { PruneResult, StorageAdapter } from "../models/storage";
import { drainEmergencyQueue } from "../storage/emergency-queue";
import { createStorage } from "../storage/factory";
import { ExitFlush } from "../transport/exit-flush";
import { HttpTransport } from "../transport/http-transport";
import { RetryEngine } from "../transport/retry-engine";
import { ConsoleSink } from "../utils/console";
import { type Identity, newId, resolveIdentity, touchSession } from "../utils/identity";
import { detectPlatform, type PlatformMetadata } from "../utils/platform";
import { Sequence } from "../utils/sequence";
import { TraceEngine } from "../utils/tracing";
import { BreadcrumbBuffer } from "./breadcrumbs";
import { applyResolvedConfig, resolveConfig } from "./config";
import { ContextStore } from "./context";
import { Diagnostics } from "./diagnostics";
import { JourneyEngine } from "./journey";
import { OneLogger } from "./logger";
import { LogPipeline } from "./pipeline";
import { RecordBuilder } from "./record";

/** Global symbol key pinning the singleton runtime instance across federated bundles. */
const RUNTIME_KEY = Symbol.for(RUNTIME_GLOBAL_KEY);

/** Central runtime managing subsystem lifecycles, bus coordination, and record delivery. */
export class ObservabilityRuntime {
  /** Diagnostics reporter for internal faults. */
  readonly diagnostics: Diagnostics;

  /** Active configuration instance mutated in place during reconfigurations. */
  readonly config: ResolvedConfig;

  /** Detected host platform metadata. */
  readonly platform: PlatformMetadata;

  /** Identity context containing session, tab, and context identifiers. */
  readonly identity: Identity;

  /** Store for ambient application context attributes. */
  readonly context = new ContextStore();

  /** Ring buffer holding contextual user breadcrumbs. */
  readonly breadcrumbs: BreadcrumbBuffer;

  /** Distributed tracing context engine. */
  readonly tracing: TraceEngine;

  /** Monotonic sequence counter for records emitted in this context. */
  readonly sequence = new Sequence();

  /** Journey tracking engine managing workflow correlation. */
  readonly journey: JourneyEngine;

  /** Record builder assembling structured log records. */
  readonly builder: RecordBuilder;

  /** Console sink for local developer output. */
  readonly console: ConsoleSink;

  /** Cross-realm communication bus. */
  readonly bus: Bus;

  /** Persistent storage adapter for offline batches (sender role only). */
  private storage?: StorageAdapter;

  /** HTTP transport instance for live log delivery (sender role only). */
  private transport?: HttpTransport;

  /** Background retry engine for redelivering failed batches (sender role only). */
  private retry?: RetryEngine;

  /** Primary log pipeline managing stream buffering and delivery (sender role only). */
  private pipeline?: LogPipeline;

  /** Exit flush handler executing atomic batch delivery on unload (sender role only). */
  private exitFlush?: ExitFlush;

  /** Active auto-capture instrumentation modules. */
  private readonly captures: Capture[] = [];

  /** Queue buffering records created before bus role resolution. */
  private bootBuffer: LogRecord[] = [];

  /** Batch buffer staging records for microtask forwarding. */
  private forwardBuffer: LogRecord[] = [];

  /** Indicates whether a microtask drain is scheduled for the forward buffer. */
  private forwardScheduled = false;

  /** Indicates whether asynchronous initialization has completed. */
  private ready = false;

  /** Indicates whether the runtime has been permanently shut down. */
  private destroyed = false;

  /** Timestamp of the last reported storage gap warning in epoch milliseconds. */
  private lastGapAt = 0;

  /**
   * @param input Initial consumer configuration options.
   */
  private constructor(input: Partial<ObservabilityConfig>) {
    this.diagnostics = new Diagnostics(input.onDiagnostic);

    this.platform = detectPlatform(this.diagnostics);
    this.config = resolveConfig(input, this.diagnostics);
    this.identity = resolveIdentity(this.diagnostics);
    this.breadcrumbs = new BreadcrumbBuffer(this.config.capture.maxBreadcrumbs);
    this.tracing = new TraceEngine(this.diagnostics);
    this.console = new ConsoleSink(this.config.console.enabled, this.config.console.level);

    this.journey = new JourneyEngine(
      this.config.journey,
      this.diagnostics,
      this.identity.contextId,
      (journey) => {
        this.bus.broadcastJourney(journey);
      },
    );

    this.builder = new RecordBuilder({
      config: this.config,
      diagnostics: this.diagnostics,
      context: this.context,
      journey: this.journey,
      tracing: this.tracing,
      sequence: this.sequence,
      identity: this.identity,
      platform: this.platform,
    });

    this.bus = new Bus(
      this.config,
      this.diagnostics,
      this.platform,
      this.identity.contextId,
      this.identity.tabId,
      {
        onRecords: (records) => {
          this.ingestForwarded(records);
        },
        onJourney: (journey) => {
          this.journey.applyRemote(journey);
        },
        onJourneyRequest: () => this.journey.current(),
        onTabConflict: () => {
          this.regenerateTabId();
        },
      },
    );
  }

  /**
   * Direct communication receiver invoked by same-origin child frames.
   * @param message Inbound bus message.
   * @param reply Direct response callback.
   */
  readonly busAccept = (message: BusMessage, reply: Receive): void => {
    if (this.destroyed) {
      return;
    }

    this.diagnostics.guard("bus.send_failed", "accepting a direct message from a child", () => {
      this.bus.acceptDirect(message, reply);
    });
  };

  /**
   * Returns the singleton runtime instance pinned to this realm.
   * @returns Active runtime instance or null.
   */
  static current(): ObservabilityRuntime | null {
    return (
      ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] as ObservabilityRuntime | undefined) ??
      null
    );
  }

  /**
   * Initializes a new runtime instance or updates the existing singleton.
   * @param input Consumer configuration options.
   * @returns Active runtime instance.
   */
  static configure(input: Partial<ObservabilityConfig>): ObservabilityRuntime {
    const existing = ObservabilityRuntime.current();
    if (existing && !existing.destroyed) {
      existing.reconfigure(input);
      return existing;
    }

    const runtime = new ObservabilityRuntime(input);
    (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = runtime;
    void runtime.init();
    return runtime;
  }

  /**
   * Updates runtime configuration and refreshes affected subsystems.
   * @param input Partial configuration to merge.
   */
  private reconfigure(input: Partial<ObservabilityConfig>): void {
    applyResolvedConfig(this.config, resolveConfig(input, this.diagnostics, this.config));
    this.diagnostics.setHandler(this.config.onDiagnostic);

    this.builder.invalidateResource();
    this.console.update(this.config.console.enabled, this.config.console.level);
    this.breadcrumbs.resize(this.config.capture.maxBreadcrumbs);
    this.pipeline?.refresh();

    if (this.ready) {
      this.reinstallCaptures();
    }

    this.diagnostics.report(
      "config.reconfigured",
      "configure() was called again, the existing runtime was updated",
    );
  }

  /** Initializes asynchronous subsystems and flushes the boot buffer. */
  private async init(): Promise<void> {
    try {
      const journeyReady = this.journey.bootstrap();
      const role = await this.bus.start();

      if (role === "sender") {
        await this.becomeSender();
      }

      await journeyReady;
      this.installCaptures();
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "startup failed, continuing in a degraded state",
        undefined,
        error,
      );
    } finally {
      // Flushes buffered boot records regardless of startup outcome.
      this.ready = true;
      this.releaseBootBuffer();
    }
  }

  /** Initializes storage, transport, pipeline, and unload listeners for sender role. */
  private async becomeSender(): Promise<void> {
    this.storage = await createStorage(
      this.config.storage.strategy,
      this.config.storage.dbName,
      this.config.storage,
      this.diagnostics,
      this.reportGap,
    );
    this.transport = new HttpTransport(this.config, this.diagnostics);
    this.retry = new RetryEngine(this.storage, this.transport, this.diagnostics, this.config);
    this.pipeline = new LogPipeline(
      this.config,
      this.transport,
      this.storage,
      this.retry,
      this.diagnostics,
    );

    this.exitFlush = new ExitFlush({
      config: this.config,
      diagnostics: this.diagnostics,
      drainPending: () => this.pipeline?.drainPending() ?? null,
    });

    await drainEmergencyQueue(this.storage, this.diagnostics);

    this.retry.start();
    this.exitFlush.install();
  }

  /** Instantiates and registers enabled auto-capture modules. */
  private installCaptures(): void {
    const ctx = {
      config: this.config,
      diagnostics: this.diagnostics,
      breadcrumbs: this.breadcrumbs,
      tracing: this.tracing,
      logger: new OneLogger(this, CAPTURE_NAMESPACE),
    };
    const settings = this.config.capture;

    if (settings.errors || settings.rejections || settings.resourceErrors) {
      this.captures.push(new ErrorCapture(ctx));
    }
    if (settings.fetch || settings.xhr) {
      this.captures.push(new NetworkCapture(ctx));
    }
    if (settings.interactions || settings.navigation) {
      this.captures.push(new InteractionCapture(ctx));
    }
    if (settings.webVitals) {
      this.captures.push(new WebVitalsCapture(ctx));
    }

    for (const capture of this.captures) {
      this.diagnostics.guard("capture.install_failed", `installing ${capture.name}`, () => {
        capture.install();
      });
    }
  }

  /** Uninstalls active capture modules and re-creates them from updated configuration. */
  private reinstallCaptures(): void {
    for (const capture of this.captures) {
      this.diagnostics.guard("capture.install_failed", `uninstalling ${capture.name}`, () => {
        capture.uninstall();
      });
    }
    this.captures.length = 0;
    this.installCaptures();
  }

  /**
   * Attaches a Web Worker or MessagePort to the bus for record forwarding.
   * @param worker Target Worker or MessagePort instance.
   */
  registerWorker(worker: WorkerLike): void {
    if (this.destroyed) {
      return;
    }

    this.diagnostics.guard("bus.send_failed", "registering a worker", () => {
      this.bus.attachWorker(worker);
    });
  }

  /** Flushes pending telemetry, unregisters listeners, and unpins the runtime instance. */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    for (const capture of this.captures) {
      capture.uninstall();
    }
    this.captures.length = 0;

    this.exitFlush?.flush("shutdown");
    this.exitFlush?.uninstall();
    this.retry?.stop();
    this.pipeline?.destroy();
    this.journey.destroy();
    this.bus.destroy();
    this.forwardBuffer = [];
    await this.storage?.close();

    if (ObservabilityRuntime.current() === this) {
      Reflect.deleteProperty(globalThis, RUNTIME_KEY);
    }
  }

  /**
   * Routes a completed log record to the pipeline or forward buffer.
   * @param record Log record to emit, or null if dropped during build.
   */
  emit(record: LogRecord | null): void {
    if (!record || this.destroyed) {
      return;
    }

    touchSession(this.identity.sessionId, this.diagnostics);

    if (!this.ready) {
      if (this.bootBuffer.length >= this.config.bus.maxBootBufferRecords) {
        this.bootBuffer.shift();
        this.diagnostics.count("record.dropped_boot_buffer_full");
      }
      this.bootBuffer.push(record);
      return;
    }

    this.route(record);
  }

  /**
   * Directs a record to the forward buffer or local pipeline based on active bus role.
   * @param record Log record to route.
   */
  private route(record: LogRecord): void {
    if (this.bus.getRole() === "forwarder") {
      this.forward(record);
      return;
    }

    this.pipeline?.push(record);
  }

  /**
   * Batches records for asynchronous transmission to the upstream sender.
   * @param record Log record to forward.
   */
  private forward(record: LogRecord): void {
    this.forwardBuffer.push(record);
    if (this.forwardScheduled) {
      return;
    }
    this.forwardScheduled = true;

    queueMicrotask(() => {
      this.forwardScheduled = false;
      const records = this.forwardBuffer;
      this.forwardBuffer = [];
      if (records.length > 0) {
        this.bus.sendRecords(records);
      }
    });
  }

  /**
   * Validates and enqueues records received from child frames or workers.
   * @param records Inbound payload from bus.
   */
  private ingestForwarded(records: unknown): void {
    if (!Array.isArray(records)) {
      this.diagnostics.count("record.dropped_malformed");
      return;
    }

    for (const record of records) {
      if (!isLogRecord(record)) {
        this.diagnostics.count("record.dropped_malformed");
        continue;
      }
      this.pipeline?.push(record);
    }
  }

  /** Flushes records buffered during startup and backfills active journey metadata. */
  private releaseBootBuffer(): void {
    const buffered = this.bootBuffer;
    this.bootBuffer = [];
    const journey = this.journey.current();

    for (const record of buffered) {
      if (journey && !record.attributes["journey.id"]) {
        record.attributes["journey.id"] = journey.id;
        record.attributes["journey.name"] = journey.name;
      }
      this.route(record);
    }
  }

  /**
   * Emits a warning log record when batches are evicted from persistent storage.
   * @param result Storage prune summary metrics.
   */
  private readonly reportGap = (result: PruneResult): void => {
    const now = Date.now();
    if (now - this.lastGapAt < GAP_REPORT_THROTTLE_MS) {
      return;
    }
    this.lastGapAt = now;

    new OneLogger(this, STORAGE_NAMESPACE).warn("stored records were dropped before delivery", {
      "gap.batches": result.batches,
      "gap.records": result.records,
      "gap.reason": result.reason,
    });
  };

  /** Generates and persists a replacement tab ID when a collision is detected. */
  private regenerateTabId(): void {
    const fresh = newId();
    this.diagnostics.report(
      "bus.role_resolved",
      "another context claimed this tab id, most likely a duplicated tab. Regenerating.",
      { was: this.identity.tabId, now: fresh },
    );

    (this.identity as { tabId: string }).tabId = fresh;
    this.diagnostics.guard("storage.unavailable", "persisting the new tab id", () => {
      sessionStorage.setItem(TAB_ID_KEY, fresh);
    });
    this.builder.invalidateResource();
  }

  /**
   * Flushes all pending records in the pipeline or forward buffer.
   * @returns Promise resolving when queued records are transmitted or handed off.
   */
  async flush(): Promise<void> {
    if (this.bus.getRole() === "forwarder") {
      const records = this.forwardBuffer;
      this.forwardBuffer = [];
      if (records.length > 0) {
        this.bus.sendRecords(records);
      }
      return;
    }

    const batch = this.pipeline?.drainPending();
    if (!batch || !this.transport) {
      return;
    }

    try {
      await this.transport.send(batch);
    } catch (error) {
      await this.diagnostics.guardAsync(
        "storage.degraded",
        "persisting the batch drained by flush()",
        async () => {
          await this.storage?.save({ ...batch, attempts: 1 });
          this.retry?.nudge();
        },
      );
      this.diagnostics.report(
        "transport.http_error",
        "the batch drained by flush() was stored for retry instead of being delivered",
        { batchId: batch.id, records: batch.records.length },
        error,
      );
    }
  }
}

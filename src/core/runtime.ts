// src/core/runtime.ts
//
// Central coordination runtime managing subsystem lifecycles, configuration, and telemetry routing.

import type { Bus } from "../bus/bus";
import type { Receive, WorkerLike } from "../bus/links";
import type { Capture, CaptureContext, CaptureOnce } from "../capture/types";
import {
  BUS_MAX_BOOT_BUFFER_RECORDS,
  CAPTURE_NAMESPACE,
  GAP_REPORT_THROTTLE_MS,
  MAX_BREADCRUMBS,
  RECORD_LIMITS,
  RUNTIME_GLOBAL_KEY,
  STORAGE_NAMESPACE,
} from "../constants";
import type { BusMessage, BusRole } from "../models/bus";
import type {
  IdentityStrategy,
  ObservabilityConfig,
  ResolvedConfig,
  StorageStrategy,
} from "../models/config";
import { isLogRecord, type LogRecord } from "../models/log-record";
import type { PruneResult } from "../models/storage";
import { ConsoleSink } from "../utils/console";
import {
  BROWSER_STORES,
  type Identity,
  type IdentityStores,
  memoryStores,
  newId,
  persistTabId,
  resolveIdentity,
  SessionTouch,
} from "../utils/identity";
import { detectPlatform, type PlatformMetadata } from "../utils/platform";
import { Sequence } from "../utils/sequence";
import { TraceEngine } from "../utils/tracing";
import { BreadcrumbBuffer } from "./breadcrumbs";
import { applyResolvedConfig, resolveConfig } from "./config";
import { ContextStore } from "./context";
import { Diagnostics } from "./diagnostics";
import { JourneyEngine, JOURNEY_OPTIONS } from "./journey";
import { OneLogger } from "./logger";
import { RecordBuilder } from "./record";
import { shouldSample } from "./sampling";
import type { Sender } from "./sender";

/** Constructor of one capture module. */
type CaptureClass = new (ctx: CaptureContext) => Capture;

/** Import of each capture module. Each import makes a separate chunk. */
const CAPTURE_LOADERS = {
  errors: async (): Promise<CaptureClass> => (await import("../capture/errors")).ErrorCapture,
  network: async (): Promise<CaptureClass> => (await import("../capture/network")).NetworkCapture,
  interactions: async (): Promise<CaptureClass> =>
    (await import("../capture/interactions")).InteractionCapture,
  webVitals: async (): Promise<CaptureClass> =>
    (await import("../capture/web-vitals")).WebVitalsCapture,
};

/** Name of one capture module. */
type CaptureName = keyof typeof CAPTURE_LOADERS;

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

  /** Stores for identity and journey keys. The runtime sets them at startup. */
  private readonly stores: IdentityStores;

  /** Identity strategy that the runtime used to make the stores. */
  private readonly identityBuiltAs: IdentityStrategy;

  /** Throttled writer of the session's last-seen timestamp. */
  private readonly sessionTouch: SessionTouch;

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

  /**
   * Cross-realm communication bus. It is null until its chunk loads.
   * In bus.mode "off", it loads only when a child frame or a worker needs it.
   */
  private bus: Bus | null = null;

  /** Load and start of the bus. Undefined until the first need. */
  private busLoad?: Promise<Bus | null>;

  /** Storage strategy the adapter was built from, set once the build starts. */
  private storageBuiltAs?: StorageStrategy;

  /** Delivery stack. The runtime sets it in the sender role with an endpoint, after the chunk loads. */
  private sender?: Sender;

  /** Load of the delivery stack. It is undefined when nothing loads. A record then has no destination. */
  private senderLoad?: Promise<void>;

  /** Records that arrive while the delivery stack loads. */
  private pendingRecords: LogRecord[] = [];

  /** Active auto-capture instrumentation modules. */
  private readonly captures: Capture[] = [];

  /** Count of capture installs. An install that a later install replaced stops after its load. */
  private captureGeneration = 0;

  /** Capture work that a rebuild of the capture modules must not repeat. */
  private readonly captureOnce: CaptureOnce = { webVitals: false, navigationTiming: false };

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
    this.identityBuiltAs = this.config.identity;
    this.stores = this.identityBuiltAs === "memory" ? memoryStores() : BROWSER_STORES;
    this.identity = resolveIdentity(this.diagnostics, this.stores);
    this.sessionTouch = new SessionTouch(this.diagnostics, this.stores);
    this.breadcrumbs = new BreadcrumbBuffer(MAX_BREADCRUMBS);
    this.tracing = new TraceEngine(this.diagnostics, undefined, this.config.otelLoader);
    // Do not await. Without OTel, records use the ambient trace. No record is lost.
    void this.tracing.loadOtel();
    this.console = new ConsoleSink(this.config.console, this.diagnostics);

    this.journey = new JourneyEngine(
      JOURNEY_OPTIONS,
      this.diagnostics,
      this.identity.contextId,
      (journey) => {
        this.bus?.broadcastJourney(journey);
      },
      this.stores,
    );

    this.builder = new RecordBuilder({
      config: this.config,
      limits: RECORD_LIMITS,
      diagnostics: this.diagnostics,
      context: this.context,
      journey: this.journey,
      tracing: this.tracing,
      sequence: this.sequence,
      identity: this.identity,
      platform: this.platform,
    });
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

    // Messages wait for the bus in arrival order. A promise runs its callbacks in order.
    void this.ensureBus().then((bus) => {
      if (!bus || this.destroyed) {
        return;
      }

      this.diagnostics.guard("bus.send_failed", "accepting a direct message from a child", () => {
        bus.acceptDirect(message, reply);
      });
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
    this.console.update(this.config.console);
    this.keepBuiltStorage();
    this.keepBuiltIdentity();

    if (this.ready) {
      this.reinstallCaptures();

      // An endpoint set after startup loads the delivery stack that console-only mode skipped.
      if (this.config.endpoint && this.role() === "sender") {
        void this.loadSender();
      }
    }

    this.diagnostics.report(
      "config.reconfigured",
      "configure() was called again, the existing runtime was updated",
    );
  }

  /**
   * Restores the storage strategy the adapter was built from. Every other key is read
   * live, but the adapter is built once: swapping it strands the batches already
   * persisted under the old one, which is worse than refusing the change.
   */
  private keepBuiltStorage(): void {
    const built = this.storageBuiltAs;

    if (built === undefined || this.config.storage === built) {
      return;
    }

    this.diagnostics.report(
      "config.invalid",
      `storage cannot change after startup, still ${built}`,
      { requested: this.config.storage },
    );
    this.config.storage = built;
  }

  /**
   * Restores the identity strategy from startup. The ids exist from startup.
   * A later change cannot move them to another store.
   */
  private keepBuiltIdentity(): void {
    const built = this.identityBuiltAs;

    if (this.config.identity === built) {
      return;
    }

    this.diagnostics.report(
      "config.invalid",
      `identity cannot change after startup. It stays ${built}.`,
      { requested: this.config.identity },
    );
    this.config.identity = built;
  }

  /** Initializes asynchronous subsystems and flushes the boot buffer. */
  private async init(): Promise<void> {
    try {
      const journeyReady = this.journey.bootstrap();
      const role = this.config.bus.mode === "off" ? "sender" : await this.startRole();

      if (role === "sender") {
        await this.becomeSender();
      }

      await journeyReady;

      await this.installCaptures();
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

  /**
   * Loads and starts the bus, then reads the role it resolved.
   * @returns Resolved role. "sender" if the bus did not load.
   */
  private async startRole(): Promise<BusRole> {
    const bus = await this.ensureBus();
    return bus?.getRole() ?? "sender";
  }

  /**
   * Starts the load of the bus one time.
   * @returns Promise resolving to the started bus, or null if it did not load.
   */
  private ensureBus(): Promise<Bus | null> {
    this.busLoad ??= this.buildBus();
    return this.busLoad;
  }

  /** Imports, builds and starts the bus. It never rejects. */
  private async buildBus(): Promise<Bus | null> {
    try {
      const { Bus } = await import("../bus/bus");

      // Guard against a shutdown during the load. A bus on a destroyed runtime leaks its links.
      if (this.destroyed) {
        return null;
      }

      const bus = new Bus(
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

      this.bus = bus;
      await bus.start();

      return bus;
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "the bus did not start. This context sends its own records.",
        undefined,
        error,
      );

      return null;
    }
  }

  /**
   * Reads the bus role. Without a bus, this context is the sender.
   * @returns Active bus role.
   */
  private role(): BusRole {
    return this.bus?.getRole() ?? "sender";
  }

  /** Loads the delivery stack for the sender role. Without an endpoint, it loads nothing. */
  private async becomeSender(): Promise<void> {
    if (!this.config.endpoint) {
      return;
    }

    await this.loadSender();
  }

  /**
   * Starts the load of the delivery stack one time.
   * @returns Promise resolving when the load completes or fails.
   */
  private loadSender(): Promise<void> {
    this.senderLoad ??= this.buildSender();
    return this.senderLoad;
  }

  /** Imports and builds the delivery stack. It then moves the held records into it. It never rejects. */
  private async buildSender(): Promise<void> {
    this.storageBuiltAs = this.config.storage;

    try {
      const { Sender } = await import("./sender");
      const sender = await Sender.create({
        config: this.config,
        diagnostics: this.diagnostics,
        onGap: this.reportGap,
      });

      // Guard against a shutdown during the load. The stack must not outlive the runtime.
      if (this.destroyed) {
        await sender.destroy();
        return;
      }

      this.sender = sender;
    } catch (error) {
      // Clear the load. A later configure() can then try again.
      this.senderLoad = undefined;
      this.diagnostics.report(
        "pipeline.crashed",
        "the delivery stack did not load. Records are not sent.",
        { held: this.pendingRecords.length },
        error,
      );
    }

    const held = this.pendingRecords;
    this.pendingRecords = [];

    for (const record of held) {
      this.sender?.push(record);
    }
  }

  /** Loads, builds and installs the enabled capture modules. It never rejects. */
  private async installCaptures(): Promise<void> {
    const generation = ++this.captureGeneration;
    const settings = this.config.capture;
    const names: CaptureName[] = [];

    if (settings.errors || settings.rejections || settings.resourceErrors) {
      names.push("errors");
    }
    if (settings.fetch || settings.xhr) {
      names.push("network");
    }
    if (settings.interactions || settings.navigation) {
      names.push("interactions");
    }
    if (settings.webVitals) {
      names.push("webVitals");
    }

    const classes = await Promise.all(names.map((name) => this.loadCapture(name)));

    // Guard against a later install or a shutdown during the load. A stale capture leaks its listeners.
    if (generation !== this.captureGeneration || this.destroyed) {
      return;
    }

    const ctx: CaptureContext = {
      config: this.config,
      diagnostics: this.diagnostics,
      breadcrumbs: this.breadcrumbs,
      tracing: this.tracing,
      logger: new OneLogger(() => this, CAPTURE_NAMESPACE),
      once: this.captureOnce,
    };

    for (const CaptureModule of classes) {
      if (CaptureModule) {
        this.captures.push(new CaptureModule(ctx));
      }
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
    void this.installCaptures();
  }

  /**
   * Imports one capture module. A failed import reports and skips that module only.
   * @param name Capture module name.
   * @returns Promise resolving to the class, or undefined if the import failed.
   */
  private loadCapture(name: CaptureName): Promise<CaptureClass | undefined> {
    return this.diagnostics.guardAsync(
      "capture.install_failed",
      `loading the ${name} capture`,
      CAPTURE_LOADERS[name],
    );
  }

  /**
   * Attaches a Web Worker or MessagePort to the bus for record forwarding.
   * @param worker Target Worker or MessagePort instance.
   */
  registerWorker(worker: WorkerLike): void {
    if (this.destroyed) {
      return;
    }

    void this.ensureBus().then((bus) => {
      if (!bus || this.destroyed) {
        return;
      }

      this.diagnostics.guard("bus.send_failed", "registering a worker", () => {
        bus.attachWorker(worker);
      });
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

    // Sender.destroy runs its synchronous steps before its first await. The exit flush
    // then runs before the journey and the bus stop, as before.
    const closing = this.sender?.destroy();
    this.journey.destroy();
    this.bus?.destroy();
    this.forwardBuffer = [];
    this.pendingRecords = [];
    await closing;

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

    this.sessionTouch.touch(this.identity.sessionId);

    if (!this.ready) {
      if (this.bootBuffer.length >= BUS_MAX_BOOT_BUFFER_RECORDS) {
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
    if (this.role() === "forwarder") {
      this.forward(record);
      return;
    }

    this.deliver(record);
  }

  /**
   * Hands a record to the delivery stack. Holds the record while the stack loads.
   * Drops the record when nothing loads, for example in console-only mode.
   * @param record Log record to deliver.
   */
  private deliver(record: LogRecord): void {
    if (this.sender) {
      this.sender.push(record);
      return;
    }

    if (!this.senderLoad) {
      return;
    }

    if (this.pendingRecords.length >= BUS_MAX_BOOT_BUFFER_RECORDS) {
      this.pendingRecords.shift();
      this.diagnostics.count("record.dropped_boot_buffer_full");
    }

    this.pendingRecords.push(record);
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
        this.bus?.sendRecords(records);
      }
    });
  }

  /**
   * Validates, samples and enqueues records received from child frames or workers.
   * A forwarded record arrives built, so this is the first point in this context
   * where sampling can run. A local record is sampled in RecordBuilder instead.
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
      if (!shouldSample(record, this.config)) {
        this.diagnostics.count("record.dropped_by_sampling");
        continue;
      }
      this.deliver(record);
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

    new OneLogger(() => this, STORAGE_NAMESPACE).warn(
      "stored records were dropped before delivery",
      {
        "gap.batches": result.batches,
        "gap.records": result.records,
        "gap.reason": result.reason,
      },
    );
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
    persistTabId(fresh, this.diagnostics, this.stores);
    this.builder.invalidateResource();
  }

  /**
   * Counts the batches held in storage after a failed or deferred delivery.
   * @returns Promise resolving to the number of stored batches. A forwarder reports 0, because it persists nothing.
   */
  async queueDepth(): Promise<number> {
    return (await this.sender?.queueDepth()) ?? 0;
  }

  /**
   * Flushes all pending records in the pipeline or forward buffer.
   * @returns Promise resolving when queued records are transmitted or handed off.
   */
  async flush(): Promise<void> {
    if (this.role() === "forwarder") {
      const records = this.forwardBuffer;
      this.forwardBuffer = [];
      if (records.length > 0) {
        this.bus?.sendRecords(records);
      }
      return;
    }

    await this.sender?.flush();
  }
}

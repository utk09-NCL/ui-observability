// src/core/runtime.ts
//
// This runtime coordinates the subsystems. It manages their lifecycles, the configuration
// and the routing of records.

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
  RUNTIME_STOPPED_KEY,
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
import type { RemoteSlot } from "./remote-sampling";
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
  longFrames: async (): Promise<CaptureClass> =>
    (await import("../capture/long-frames")).LongFrameCapture,
  console: async (): Promise<CaptureClass> => (await import("../capture/console")).ConsoleCapture,
};

/** Name of one capture module. */
type CaptureName = keyof typeof CAPTURE_LOADERS;

/** Global symbol key of the singleton runtime. All federated bundles share it. */
const RUNTIME_KEY = Symbol.for(RUNTIME_GLOBAL_KEY);

/** Global symbol key of the runtime that shutdown() stopped. */
const STOPPED_KEY = Symbol.for(RUNTIME_STOPPED_KEY);

/** Manages subsystem lifecycles, bus coordination and record delivery. */
export class ObservabilityRuntime {
  /** Diagnostics reporter for internal faults. */
  readonly diagnostics: Diagnostics;

  /** Active configuration instance. A reconfigure changes it in place. */
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

  /** Slot of the remote sampling rules. The sender or the bus fills it. */
  private readonly remote: RemoteSlot = { sampling: null };

  /** Console sink for local developer output. */
  readonly console: ConsoleSink;

  /**
   * Cross-realm communication bus. It is null until its chunk loads.
   * In bus.mode "off", it loads only when a child frame or a worker needs it.
   */
  private bus: Bus | null = null;

  /** Load and construction of the bus. It is undefined until the first need. */
  private busBuilt?: Promise<Bus | null>;

  /** Load and start of the bus. It is undefined until the first need. */
  private busLoad?: Promise<Bus | null>;

  /** Storage strategy of the adapter. The runtime sets it when the build starts. */
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
  private readonly captureOnce: CaptureOnce = {
    webVitals: false,
    navigationTiming: false,
    longFrames: false,
  };

  /** Queue buffering records created before bus role resolution. */
  private bootBuffer: LogRecord[] = [];

  /** Batch buffer staging records for microtask forwarding. */
  private forwardBuffer: LogRecord[] = [];

  /** Indicates whether a microtask drain is scheduled for the forward buffer. */
  private forwardScheduled = false;

  /** Indicates whether startup has decided the bus role. A sender load waits for it. */
  private roleResolved = false;

  /** Resolves when startup releases the boot records. flush() waits for it. init() sets it. */
  private started: Promise<void> = Promise.resolve();

  /** Indicates whether asynchronous initialization has completed. */
  private ready = false;

  /** Indicates whether shutdown stopped the runtime. */
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
      remote: this.remote,
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
   * Receives direct messages from same-origin child frames.
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

      this.diagnostics.guard(
        "bus.send_failed",
        "The bus could not accept a direct message from a child frame.",
        () => {
          bus.acceptDirect(message, reply);
        },
      );
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
   * Returns the runtime that shutdown() stopped, until the next configure().
   * @returns Stopped runtime instance or null.
   */
  static stopped(): ObservabilityRuntime | null {
    return (
      ((globalThis as Record<symbol, unknown>)[STOPPED_KEY] as ObservabilityRuntime | undefined) ??
      null
    );
  }

  /**
   * Tests whether shutdown() stopped this runtime.
   * @returns True after destroy() starts.
   */
  isDestroyed(): boolean {
    return this.destroyed;
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
    Reflect.deleteProperty(globalThis, STOPPED_KEY);
    void runtime.init();
    return runtime;
  }

  /**
   * Updates runtime configuration and refreshes affected subsystems.
   * @param input Partial configuration to merge.
   */
  private reconfigure(input: Partial<ObservabilityConfig>): void {
    const accepted = this.keepDestination(input);
    applyResolvedConfig(this.config, resolveConfig(accepted, this.diagnostics, this.config));
    this.diagnostics.setHandler(this.config.onDiagnostic);

    this.builder.invalidateResource();
    this.console.update(this.config.console);
    this.keepBuiltStorage();
    this.keepBuiltIdentity();

    // A stale capture load stops at its generation check. A reinstall is safe at any time.
    void this.installCaptures();

    if (this.roleResolved) {
      void this.syncSender();
    }

    this.diagnostics.report("config.reconfigured", "A later configure() call updated the runtime.");
  }

  /**
   * Restores the storage strategy of the built adapter. The runtime reads all other keys
   * live. It builds the adapter only one time. A new adapter strands the batches in the
   * old adapter. That loss is worse than a refused change.
   */
  private keepBuiltStorage(): void {
    const built = this.storageBuiltAs;

    if (built === undefined || this.config.storage === built) {
      return;
    }

    this.diagnostics.report(
      "config.invalid",
      `storage cannot change after startup. It stays ${built}.`,
      { requested: this.config.storage },
    );
    this.config.storage = built;
  }

  /**
   * Refuses a change that would leave the built delivery stack with nowhere to send.
   * Without a destination, the retry engine removes each stored batch as delivered.
   * @param input Partial configuration to merge.
   * @returns Input without the refused changes.
   */
  private keepDestination(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig> {
    if (this.senderLoad === undefined) {
      return input;
    }

    let accepted = input;
    const addsOrRemoves =
      "transport" in input &&
      (input.transport === undefined) !== (this.config.transport === undefined);

    // The stack selects HTTP or the custom transport one time. It cannot change to the other.
    if (addsOrRemoves) {
      this.diagnostics.report(
        "config.invalid",
        "You cannot add or remove transport after the delivery stack loads. The transport in force stays.",
      );
      accepted = { ...accepted };
      delete accepted.transport;
    }

    const removesEndpoint = accepted.endpoint === null || accepted.endpoint === "";

    if (removesEndpoint && this.config.transport === undefined) {
      this.diagnostics.report(
        "config.invalid",
        "You cannot remove the endpoint after the delivery stack loads. The endpoint in force stays.",
      );
      // An undefined endpoint keeps the endpoint in force, and keeps it in ignoreUrls.
      accepted = { ...accepted, endpoint: undefined };
    }

    return accepted;
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
    // Start the capture imports now. They download in parallel with the bus and the sender.
    const captures = this.installCaptures();

    // Set before the first await. A flush() directly after configure() then waits for it.
    this.started = this.boot();
    await this.started;
    await captures;
  }

  /** Resolves the bus role, loads the delivery stack and releases the boot records. It never rejects. */
  private async boot(): Promise<void> {
    try {
      const journeyReady = this.journey.bootstrap();

      if (this.config.bus.mode !== "off") {
        await this.ensureBus();
      }

      this.roleResolved = true;
      await this.syncSender();
      await journeyReady;
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "Startup failed. The runtime continues with reduced function.",
        undefined,
        error,
      );
    } finally {
      // Release the boot records before the captures load. The exit flush can then find them.
      this.ready = true;
      this.releaseBootBuffer();
    }
  }

  /**
   * Starts the load of the bus one time.
   * @returns Promise resolving to the started bus, or null if it did not load.
   */
  private ensureBus(): Promise<Bus | null> {
    this.busLoad ??= this.startBus();
    return this.busLoad;
  }

  /**
   * Loads and constructs the bus one time. It does not call start().
   * @returns Promise resolving to the constructed bus, or null if it did not load.
   */
  private constructBus(): Promise<Bus | null> {
    this.busBuilt ??= this.buildBus();
    return this.busBuilt;
  }

  /**
   * Starts the constructed bus. It never rejects.
   * @returns Promise resolving to the started bus, or null if it did not load or start.
   */
  private async startBus(): Promise<Bus | null> {
    const bus = await this.constructBus();

    if (!bus) {
      return null;
    }

    try {
      await bus.start();
      return bus;
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "The bus did not start. This context sends its own records.",
        undefined,
        error,
      );

      return null;
    }
  }

  /** Imports and constructs the bus. It never rejects. */
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
          remote: this.remote,
        },
      );

      this.bus = bus;

      return bus;
    } catch (error) {
      this.diagnostics.report(
        "pipeline.crashed",
        "The bus did not load. This context sends its own records.",
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

  /**
   * Loads the delivery stack if this context is the sender and has an endpoint.
   * @returns Promise resolving when the load completes, or immediately when nothing loads.
   */
  private syncSender(): Promise<void> {
    const hasDestination = Boolean(this.config.endpoint) || this.config.transport !== undefined;

    if (!hasDestination || this.role() !== "sender") {
      return Promise.resolve();
    }

    return this.loadSender();
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
      const sender = this.destroyed
        ? null
        : await Sender.create({
            config: this.config,
            diagnostics: this.diagnostics,
            onGap: this.reportGap,
            remote: this.remote,
          });

      // Guard against a shutdown during the load. The stack must not outlive the runtime.
      if (!sender || this.destroyed) {
        await sender?.destroy();
        return;
      }

      this.sender = sender;
    } catch (error) {
      // Clear the load. A later configure() can then try again.
      this.senderLoad = undefined;
      this.diagnostics.report(
        "pipeline.crashed",
        "The delivery stack did not load. The library does not send records.",
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
    if (settings.longFrames) {
      names.push("longFrames");
    }
    // An empty list wraps nothing. Do not load the chunk for it.
    const consoleOn = Array.isArray(settings.console)
      ? settings.console.length > 0
      : settings.console;

    if (consoleOn) {
      names.push("console");
    }

    const classes = await Promise.all(names.map((name) => this.loadCapture(name)));

    // Guard against a later install or a shutdown during the load. A stale capture leaks its listeners.
    if (generation !== this.captureGeneration || this.destroyed) {
      return;
    }

    // Swap the old set for the new set in one synchronous step. No interval runs without capture.
    this.uninstallCaptures();

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
      this.diagnostics.guard(
        "capture.install_failed",
        `The library could not install the ${capture.name} capture.`,
        () => {
          capture.install();
        },
      );
    }
  }

  /** Uninstalls the active capture modules. */
  private uninstallCaptures(): void {
    for (const capture of this.captures) {
      this.diagnostics.guard(
        "capture.install_failed",
        `The library could not uninstall the ${capture.name} capture.`,
        () => {
          capture.uninstall();
        },
      );
    }
    this.captures.length = 0;
  }

  /**
   * Imports one capture module. A failed import reports and skips that module only.
   * @param name Capture module name.
   * @returns Promise resolving to the class, or undefined if the import failed.
   */
  private loadCapture(name: CaptureName): Promise<CaptureClass | undefined> {
    return this.diagnostics.guardAsync(
      "capture.install_failed",
      `The library could not load the ${name} capture.`,
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

    // Attach on construction. The worker's handshake can time out while the bus starts.
    void this.constructBus().then((bus) => {
      if (!bus || this.destroyed) {
        return;
      }

      this.diagnostics.guard(
        "bus.send_failed",
        "The library could not register the worker.",
        () => {
          bus.attachWorker(worker);
        },
      );

      // Start the bus in bus.mode "off", where startup did not start it.
      void this.ensureBus();
    });
  }

  /** Flushes pending telemetry, unregisters listeners, and unpins the runtime instance. */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.uninstallCaptures();

    // Sender.destroy runs its synchronous steps before its first await. Thus the exit
    // flush runs before the journey and the bus stop.
    const closing = this.sender?.destroy();
    this.journey.destroy();
    this.bus?.destroy();
    this.forwardBuffer = [];
    this.pendingRecords = [];
    await closing;
    // A load in progress destroys its own stack. shutdown() resolves only after that.
    await this.senderLoad;

    if (ObservabilityRuntime.current() === this) {
      Reflect.deleteProperty(globalThis, RUNTIME_KEY);
      // Calls after shutdown() go to this runtime and do nothing.
      // A new default runtime would drop the app's settings.
      (globalThis as Record<symbol, unknown>)[STOPPED_KEY] = this;
    }
  }

  /**
   * Routes a completed log record to the pipeline or forward buffer.
   * @param record Log record to emit, or null when the build dropped it.
   */
  emit(record: LogRecord | null): void {
    if (!record || this.destroyed) {
      return;
    }

    this.sessionTouch.touch(this.identity.sessionId);

    if (!this.ready) {
      this.pushCapped(this.bootBuffer, record);
      return;
    }

    this.route(record);
  }

  /**
   * Sends a record to the forward buffer or to the local pipeline. The bus role selects
   * the path.
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

    this.pushCapped(this.pendingRecords, record);
  }

  /**
   * Adds a record to a hold buffer. It drops the oldest record when the buffer is full.
   * @param buffer Hold buffer.
   * @param record Record to hold.
   */
  private pushCapped(buffer: LogRecord[], record: LogRecord): void {
    if (buffer.length >= BUS_MAX_BOOT_BUFFER_RECORDS) {
      buffer.shift();
      this.diagnostics.count("record.dropped_boot_buffer_full");
    }

    buffer.push(record);
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
   * Validates, samples and queues records from child frames or workers.
   * A forwarded record arrives built. This is the first point in this context where
   * sampling can run. RecordBuilder samples a local record.
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
      if (!shouldSample(record, this.config, this.remote.sampling?.current() ?? null)) {
        this.diagnostics.count("record.dropped_by_sampling");
        continue;
      }
      this.deliver(record);
    }
  }

  /** Flushes the startup records. It adds the active journey to records without a journey. */
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
   * Emits a warning record when storage evicts batches.
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

  /** Makes and stores a new tab ID after a tab ID collision. */
  private regenerateTabId(): void {
    const fresh = newId(this.diagnostics);
    this.diagnostics.report(
      "bus.role_resolved",
      "Another context uses this tab id. A duplicated tab is the usual cause. The library makes a new tab id.",
      { was: this.identity.tabId, now: fresh },
    );

    (this.identity as { tabId: string }).tabId = fresh;
    persistTabId(fresh, this.diagnostics, this.stores);
    this.builder.invalidateResource();
  }

  /**
   * Counts the batches held in storage after a failed or deferred delivery.
   * @returns Promise resolving to the number of stored batches. A forwarder stores
   * nothing and reports 0.
   */
  async queueDepth(): Promise<number> {
    await this.senderLoad;
    return (await this.sender?.queueDepth()) ?? 0;
  }

  /**
   * Flushes all pending records in the pipeline or forward buffer.
   * @returns Promise resolving when queued records are transmitted or handed off.
   */
  async flush(): Promise<void> {
    // A record logged during startup waits in the boot buffer. Without this wait, flush() misses it.
    // After startup, do not wait. The handover of the forward buffer then stays synchronous.
    if (!this.ready) {
      await this.started;
    }

    if (this.role() === "forwarder") {
      const records = this.forwardBuffer;
      this.forwardBuffer = [];
      if (records.length > 0) {
        this.bus?.sendRecords(records);
      }
      return;
    }

    await this.senderLoad;
    await this.sender?.flush();
  }
}

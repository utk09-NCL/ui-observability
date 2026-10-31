// src/core/runtime.ts
//
// This runtime coordinates the subsystems. It manages their lifecycles, the configuration
// and the routing of records.

import type { Bus } from "../bus/bus";
import type { Receive, WorkerLike } from "../bus/links";
import type { Capture, CaptureContext, CaptureOnce } from "../capture/types";
import {
  CAPTURE_NAMESPACE,
  GAP_REPORT_THROTTLE_MS,
  MAX_BREADCRUMBS,
  METRIC_NAMESPACE,
  RUNTIME_GLOBAL_KEY,
  RUNTIME_STOPPED_KEY,
  STORAGE_NAMESPACE,
  TELEMETRY_SDK_VERSION,
  TRACE_FLAGS_SAMPLED,
  TRACE_NAMESPACE,
} from "../constants";
import type { LogBatch } from "../models/batch";
import type { BusMessage, BusRole } from "../models/bus";
import type {
  CaptureOptions,
  IdentityStrategy,
  ObservabilityConfig,
  ResolvedConfig,
  StorageStrategy,
} from "../models/config";
import type { LossReporter } from "../models/drop";
import type { InstrumentDef, MetricAttributes } from "../models/metric";
import type { CapturePlugin, PluginContext } from "../models/plugin";
import { isLogRecord, type LogRecord } from "../models/log-record";
import type { DeliveryStats } from "../models/stats";
import type { PruneResult } from "../models/storage";
import { ConsoleSink } from "../utils/console";
import { isObject } from "../utils/guards";
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
import { runAsLibraryRequest } from "../utils/library-request";
import { detectPlatform, type PlatformMetadata } from "../utils/platform";
import { sanitize, truncate } from "../utils/sanitize";
import { Sequence } from "../utils/sequence";
import { TraceEngine } from "../utils/tracing";
import { type Breadcrumb, BreadcrumbBuffer } from "./breadcrumbs";
import { applyResolvedConfig, resolveConfig } from "./config";
import { ContextStore } from "./context";
import { Diagnostics } from "./diagnostics";
import { DropReporter } from "./drops";
import { HoldBuffer } from "./hold-buffer";
import { JourneyEngine, JOURNEY_OPTIONS, type JourneyOptions } from "./journey";
import { OneLogger } from "./logger";
import { makeCounter, makeHistogram, Meter, type RecordMetric } from "./meter";
import { RecordBuilder } from "./record";
import type { RemoteSlot } from "./remote-sampling";
import { sampleKey, shouldSample } from "./sampling";
import type { Sender } from "./sender";
import { rootSpan, type SpanData, spanFields } from "./spans";

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

/** Constructor of the WebSocket capture plugin. */
type WebSocketClass = new (diagnostics: Diagnostics) => CapturePlugin;

/** Id of each plugin object. A new plugin object then changes the capture key. */
const pluginIds = new WeakMap<CapturePlugin, number>();

/** Last plugin id that pluginId() gave. */
let lastPluginId = 0;

/**
 * Gives the id of a plugin object. The capture key must not hold the plugin. A plugin can hold
 * a cycle, and JSON.stringify then throws.
 * @param plugin Plugin of the app.
 * @returns The id of the object.
 */
function pluginId(plugin: CapturePlugin): number {
  let id = pluginIds.get(plugin);

  if (id === undefined) {
    id = ++lastPluginId;
    pluginIds.set(plugin, id);
  }

  return id;
}

/** Global symbol key of the singleton runtime. All federated bundles share it. */
const RUNTIME_KEY = Symbol.for(RUNTIME_GLOBAL_KEY);

/** Global symbol key of the runtime that shutdown() stopped. */
const STOPPED_KEY = Symbol.for(RUNTIME_STOPPED_KEY);

/** Config sections that the delivery stack reads one time, when it loads. */
const SENDER_SECTIONS = ["batching", "retention"] as const;

/** Config sections that a later configure() cannot change. */
type StartupSection = (typeof SENDER_SECTIONS)[number] | "limits";

/**
 * Makes a text key of the capture section. A later configure() reinstalls the capture
 * modules only when the key changes. A reinstall unpatches and patches each host function.
 * @param capture Capture section.
 * @returns The key. A function and a RegExp give a fixed text.
 */
function captureKey(capture: CaptureOptions): string {
  return JSON.stringify({
    ...capture,
    webVitalsLoader: capture.webVitalsLoader !== undefined,
    ignoreUrls: capture.ignoreUrls.map(String),
    propagateTraceHeaderTo: capture.propagateTraceHeaderTo.map(String),
    plugins: capture.plugins.map(pluginId),
  });
}

/**
 * Removes the delivery settings from a configuration. A console-only runtime must not send
 * or join a bus. The runtime of the other version does both.
 * @param input Consumer configuration options.
 * @returns The options with no endpoint, no transport and bus mode "off".
 */
function consoleOnly(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig> {
  return {
    ...input,
    endpoint: null,
    transport: undefined,
    transportOnExit: undefined,
    bus: { ...input.bus, mode: "off" },
  };
}

/**
 * Tests if a runtime on a global key comes from this version of the library.
 * @param runtime Runtime on the global key. A runtime before 0.9.0 has no sdkVersion.
 * @returns True if this copy can call the methods of the runtime.
 */
function ownVersion(runtime: ObservabilityRuntime): boolean {
  return runtime.sdkVersion === TELEMETRY_SDK_VERSION;
}

/** Manages subsystem lifecycles, bus coordination and record delivery. */
export class ObservabilityRuntime {
  /**
   * Runtime of this copy of the library when another version owns the page runtime.
   * It stays off the global key.
   */
  private static local: ObservabilityRuntime | null = null;

  /**
   * Library version of this runtime. Another copy reads it from the global key.
   * Two versions with one runtime call methods that the other version does not have.
   */
  readonly sdkVersion: string = TELEMETRY_SDK_VERSION;

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

  /** Collects lost records into onDrop summaries. */
  private readonly drops: DropReporter;

  /** Sums the values of the counter and histogram instruments. */
  private readonly meter: Meter;

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
  private readonly pendingRecords = new HoldBuffer((record) => {
    this.dropHeld(record);
  });

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
  private readonly bootBuffer = new HoldBuffer((record) => {
    this.dropHeld(record);
  });

  /** Batch buffer staging records for microtask forwarding. */
  private forwardBuffer: LogRecord[] = [];

  /** True if a microtask drain of the forward buffer is pending. */
  private forwardScheduled = false;

  /** True if startup has decided the bus role. A sender load waits for it. */
  private roleResolved = false;

  /** Resolves when startup releases the boot records. flush() waits for it. init() sets it. */
  private started: Promise<void> = Promise.resolve();

  /** True if asynchronous initialization is complete. */
  private ready = false;

  /** True if shutdown stopped the runtime. */
  private destroyed = false;

  /** Timestamp of the last reported storage gap warning in epoch milliseconds. */
  private lastGapAt = 0;

  /** Record limits of the builder and the console. The first configure() of the app sets them. */
  private readonly limits: ResolvedConfig["limits"];

  /** Lifetime rules of the journey engine. The first configure() of the app sets the age. */
  private readonly journeyOptions: JourneyOptions;

  /** False in a runtime that an early log call started. The first configure() then sets limits. */
  private tunablesLocked = true;

  /**
   * @param input Initial consumer configuration options.
   * @param degraded True for a console-only runtime next to another version. It installs
   * no capture.
   */
  private constructor(
    input: Partial<ObservabilityConfig>,
    private readonly degraded = false,
  ) {
    this.diagnostics = new Diagnostics(input.onDiagnostic);

    this.platform = detectPlatform(this.diagnostics);
    this.config = resolveConfig(input, this.diagnostics);
    this.identityBuiltAs = this.config.identity;
    this.stores = this.identityBuiltAs === "memory" ? memoryStores() : BROWSER_STORES;
    this.identity = resolveIdentity(this.diagnostics, this.stores);
    this.sessionTouch = new SessionTouch(this.diagnostics, this.stores);
    this.breadcrumbs = new BreadcrumbBuffer(MAX_BREADCRUMBS);
    // Sample a span by its trace. The whole trace stays or goes.
    const keeps = (traceId: string): boolean =>
      sampleKey(traceId, this.config.sampling.defaultRate);
    this.tracing = new TraceEngine(this.diagnostics, undefined, this.config.otelLoader, {
      enabled: () => this.config.tracesEndpoint !== "",
      keeps,
      onEnd: (ended) => {
        if (keeps(ended.traceId)) {
          this.recordSpan(rootSpan(ended));
        }
      },
    });
    // Do not await. Without OTel, records use the ambient trace. The library loses no record.
    void this.tracing.loadOtel();
    // The startup values stay. A later configure() cannot change the limits or the journey age.
    this.limits = { ...this.config.limits };
    this.console = new ConsoleSink(this.config.console, this.diagnostics, this.limits);
    this.drops = new DropReporter(this.config, this.diagnostics);
    this.journeyOptions = { ...JOURNEY_OPTIONS, maxAgeMs: this.config.journey.maxAgeMs };

    this.journey = new JourneyEngine(
      this.journeyOptions,
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
      limits: this.limits,
      diagnostics: this.diagnostics,
      context: this.context,
      journey: this.journey,
      tracing: this.tracing,
      sequence: this.sequence,
      identity: this.identity,
      platform: this.platform,
    });

    this.meter = new Meter(
      () => this.config.batching.metricFlushIntervalMs,
      (name, attributes, fields) => {
        this.emitPoint(name, attributes, fields);
      },
      this.diagnostics,
    );
  }

  /**
   * Adds a breadcrumb from app code. It copies the data now. A later change of the object of the
   * app then does not change the trail.
   * @param message Description of the event. A JavaScript caller can pass a value that is not a
   * string. The library converts it.
   * @param data Optional metadata.
   */
  addBreadcrumb(message: unknown, data?: Record<string, unknown>): void {
    // A message with a toString() that throws, or a data getter that throws, must not throw
    // into the call of the app.
    this.diagnostics.guard(
      "record.sanitize_failed",
      "The library could not add the breadcrumb.",
      () => {
        const crumb: Breadcrumb = {
          t: Date.now(),
          category: "custom",
          message: truncate(String(message), this.limits.maxBodyChars),
        };

        if (data !== undefined) {
          const clean = sanitize(data, this.limits, this.diagnostics);
          crumb.data = isObject(clean) ? clean : { value: clean };
        }

        this.breadcrumbs.push(crumb);
      },
    );
  }

  /**
   * Adds a value to a counter or a histogram. The meter sends one point at each interval.
   * @param def Definition of the instrument.
   * @param value Value to add.
   * @param attributes Attribute set of the value.
   */
  recordMetric(def: InstrumentDef, value: number, attributes?: MetricAttributes): void {
    // Guard against a value after shutdown. Its interval timer would outlive the runtime.
    if (!this.destroyed) {
      this.meter.record(def, value, attributes);
    }
  }

  /**
   * Builds and emits the record of one span. The console does not print it. minLevel does not
   * drop it. The trace engine sampled the trace before the span existed.
   * @param span The span data.
   */
  private recordSpan(span: SpanData): void {
    if (this.config.tracesEndpoint === "") {
      return;
    }

    const { record } = this.builder.build({
      level: "INFO",
      type: "span",
      body: span.name,
      namespace: TRACE_NAMESPACE,
      payload: span.attributes,
      fixed: spanFields(span),
      trace: { traceId: span.traceId, spanId: span.spanId, traceFlags: TRACE_FLAGS_SAMPLED },
    });
    this.emit(record);
  }

  /**
   * Builds and emits the record of one aggregated point. The console does not print it.
   * @param name Metric name.
   * @param attributes Attributes of the call. The record limits apply to them.
   * @param fields Metric fields of the point. The record limits do not cut them.
   */
  private emitPoint(
    name: string,
    attributes: MetricAttributes,
    fields: Record<string, unknown>,
  ): void {
    const { record } = this.builder.build({
      level: "INFO",
      type: "metric",
      body: name,
      namespace: METRIC_NAMESPACE,
      payload: attributes,
      fixed: fields,
      aggregated: true,
    });
    this.emit(record);
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
   * Returns the runtime on the global key of this realm. Another copy of the library can own it.
   * @returns Pinned runtime instance or null.
   */
  private static pinned(): ObservabilityRuntime | null {
    return (
      ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] as ObservabilityRuntime | undefined) ??
      null
    );
  }

  /**
   * Returns the local runtime of this copy. Without one, it returns the pinned runtime.
   * A pinned runtime of another version gives null. A log call then starts the local runtime.
   * @returns Active runtime instance or null.
   */
  static current(): ObservabilityRuntime | null {
    const local = ObservabilityRuntime.local;
    if (local) {
      return local.destroyed ? null : local;
    }

    const pinned = ObservabilityRuntime.pinned();
    return pinned && ownVersion(pinned) ? pinned : null;
  }

  /**
   * Returns the runtime that shutdown() stopped, until the next configure().
   * A stopped runtime of another version gives null.
   * @returns Stopped runtime instance or null.
   */
  static stopped(): ObservabilityRuntime | null {
    const local = ObservabilityRuntime.local;
    if (local?.destroyed) {
      return local;
    }

    const stopped = (globalThis as Record<symbol, unknown>)[STOPPED_KEY] as
      ObservabilityRuntime | undefined;
    return stopped && ownVersion(stopped) ? stopped : null;
  }

  /**
   * Tests if shutdown() stopped this runtime.
   * @returns True after destroy() starts.
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Initializes a new runtime instance or updates the existing singleton.
   * @param input Consumer configuration options.
   * @param implicit True for the default runtime that an early log call starts.
   * @returns Active runtime instance.
   */
  static configure(input: Partial<ObservabilityConfig>, implicit = false): ObservabilityRuntime {
    const local = ObservabilityRuntime.local;
    if (local && !local.destroyed) {
      // The local runtime stays console-only. React StrictMode calls configure() two times.
      local.reconfigure(consoleOnly(input));
      return local;
    }
    ObservabilityRuntime.local = null;

    const pinned = ObservabilityRuntime.pinned();
    if (pinned) {
      // A runtime before 0.9.0 has no sdkVersion. It is also another version.
      if (!ownVersion(pinned)) {
        return ObservabilityRuntime.startDegraded(input, pinned.sdkVersion);
      }

      if (!pinned.destroyed) {
        pinned.reconfigure(input);
        return pinned;
      }
    }

    const runtime = new ObservabilityRuntime(input);
    // The first configure() of the app sets the limits of a default runtime.
    runtime.tunablesLocked = !implicit;
    (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = runtime;
    Reflect.deleteProperty(globalThis, STOPPED_KEY);
    void runtime.init();
    return runtime;
  }

  /**
   * Starts a console-only runtime next to the runtime of another version. It sends nothing,
   * joins no bus and installs no capture. The other version keeps the page runtime.
   * @param input Consumer configuration options.
   * @param found sdkVersion of the pinned runtime. A runtime before 0.9.0 has none.
   * @returns The local runtime.
   */
  private static startDegraded(
    input: Partial<ObservabilityConfig>,
    found: unknown,
  ): ObservabilityRuntime {
    const runtime = new ObservabilityRuntime(consoleOnly(input), true);
    ObservabilityRuntime.local = runtime;

    const foundText = typeof found === "string" ? found : "before 0.9.0";
    runtime.diagnostics.report(
      "runtime.version_mismatch",
      `Another copy of the library, version ${foundText}, owns the page runtime. This copy, version ${TELEMETRY_SDK_VERSION}, runs in console-only mode and installs no capture. Load one version of the library on the page.`,
      { found: foundText, own: TELEMETRY_SDK_VERSION },
    );

    void runtime.init();
    return runtime;
  }

  /**
   * Updates runtime configuration and refreshes affected subsystems.
   * @param input Partial configuration to merge.
   */
  private reconfigure(input: Partial<ObservabilityConfig>): void {
    const accepted = this.keepDestination(input);
    const capturesBefore = captureKey(this.config.capture);
    const next = resolveConfig(accepted, this.diagnostics, this.config);
    this.keepStartupTunables(next);
    applyResolvedConfig(this.config, next);
    this.diagnostics.setHandler(this.config.onDiagnostic);

    this.builder.invalidateResource();
    this.console.update(this.config.console);
    this.keepBuiltStorage();
    this.keepBuiltIdentity();

    // Reinstall only on a change. A reinstall unpatches and patches each host function.
    // A stale capture load stops at its generation check. A reinstall is safe at any time.
    if (captureKey(this.config.capture) !== capturesBefore) {
      void this.installCaptures();
    }

    if (this.roleResolved) {
      void this.syncSender();
    }

    this.diagnostics.report("config.reconfigured", "A later configure() call updated the runtime.");
  }

  /**
   * Restores the startup tunables in the next config. A part of the runtime reads each tunable
   * one time. A later change has no effect. The runtime then refuses it.
   * @param next Resolved config of a later configure() call.
   */
  private keepStartupTunables(next: ResolvedConfig): void {
    if (this.senderLoad !== undefined) {
      this.keepSections(next, SENDER_SECTIONS);
    }

    // An early log call starts a runtime with defaults. The first configure() of the app sets
    // the limits and the journey age of that runtime.
    if (!this.tunablesLocked) {
      this.tunablesLocked = true;
      Object.assign(this.limits, next.limits);
      this.journeyOptions.maxAgeMs = next.journey.maxAgeMs;
      return;
    }

    this.keepSections(next, ["limits"]);

    const { maxAgeMs } = this.config.journey;
    if (next.journey.maxAgeMs !== maxAgeMs) {
      this.diagnostics.report(
        "config.invalid",
        `journey.maxAgeMs cannot change after startup. It stays ${String(maxAgeMs)}.`,
        { requested: next.journey.maxAgeMs },
      );
      next.journey.maxAgeMs = maxAgeMs;
    }
  }

  /**
   * Refuses a change of config sections. It restores the values in force in the next config.
   * @param next Resolved config of a later configure() call.
   * @param sections Sections that cannot change.
   */
  private keepSections(next: ResolvedConfig, sections: readonly StartupSection[]): void {
    for (const section of sections) {
      if (JSON.stringify(next[section]) === JSON.stringify(this.config[section])) {
        continue;
      }

      this.diagnostics.report(
        "config.invalid",
        `${section} cannot change after startup. The values in force stay.`,
        { requested: next[section] },
      );
      Object.assign(next, { [section]: this.config[section] });
    }
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
   * Refuses a change that leaves the built delivery stack with no destination.
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
   * @returns Promise that resolves to the started bus, or null if it did not load.
   */
  private ensureBus(): Promise<Bus | null> {
    this.busLoad ??= this.startBus();
    return this.busLoad;
  }

  /**
   * Loads and constructs the bus one time. It does not call start().
   * @returns Promise that resolves to the constructed bus, or null if it did not load.
   */
  private constructBus(): Promise<Bus | null> {
    this.busBuilt ??= this.buildBus();
    return this.busBuilt;
  }

  /**
   * Starts the constructed bus. It never rejects.
   * @returns Promise that resolves to the started bus, or null if it did not load or start.
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
   * @returns Promise that resolves when the load completes, or immediately when nothing loads.
   */
  private syncSender(): Promise<void> {
    if (!this.hasDestination() || this.role() !== "sender") {
      return Promise.resolve();
    }

    return this.loadSender();
  }

  /**
   * Tests if the config names a destination for the records.
   * @returns True with an endpoint or a custom transport.
   */
  private hasDestination(): boolean {
    return Boolean(this.config.endpoint) || this.config.transport !== undefined;
  }

  /**
   * Starts the load of the delivery stack one time.
   * @returns Promise that resolves when the load completes or fails.
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
            onLoss: this.reportLoss,
            remote: this.remote,
            beforeExit: () => {
              this.meter.collect();
              this.tracing.end();
            },
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
      this.drops.add("load_failed", this.pendingRecords.records);
    }

    for (const record of this.pendingRecords.take()) {
      this.sender?.push(record);
    }
  }

  /** Loads, builds and installs the enabled capture modules. It never rejects. */
  private async installCaptures(): Promise<void> {
    // A console-only runtime next to another version patches nothing. The other version does.
    if (this.degraded) {
      return;
    }

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

    const [classes, WebSocketCapture] = await Promise.all([
      Promise.all(names.map((name) => this.loadCapture(name))),
      settings.webSocket ? this.loadWebSocket() : undefined,
    ]);

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
      recordMetric: (def, value, attributes) => {
        this.recordMetric(def, value, attributes);
      },
      recordSpan: (span) => {
        this.recordSpan(span);
      },
    };

    for (const CaptureModule of classes) {
      if (CaptureModule) {
        this.captures.push(new CaptureModule(ctx));
      }
    }

    const plugins = WebSocketCapture
      ? [...settings.plugins, new WebSocketCapture(this.diagnostics)]
      : settings.plugins;

    for (const plugin of plugins) {
      this.captures.push(this.pluginCapture(plugin));
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
   * Imports the WebSocket capture plugin. A failed import reports and skips it.
   * @returns Promise that resolves to the class, or undefined if the import failed.
   */
  private loadWebSocket(): Promise<WebSocketClass | undefined> {
    return this.diagnostics.guardAsync(
      "capture.install_failed",
      "The library could not load the webSocket capture.",
      async () => (await import("../capture/web-socket")).WebSocketCapture,
    );
  }

  /**
   * Wraps a plugin as a capture module. The plugin gets public tools only.
   * @param plugin Plugin of the app, or a built-in plugin.
   * @returns The capture module.
   */
  private pluginCapture(plugin: CapturePlugin): Capture {
    const { name } = plugin;
    const record: RecordMetric = (def, value, attributes) => {
      this.recordMetric(def, value, attributes);
    };
    const ctx: PluginContext = {
      logger: new OneLogger(() => this, `${CAPTURE_NAMESPACE}.${name}`),
      counter: (metric, options = {}) => makeCounter(metric, options, record),
      histogram: (metric, options = {}) => makeHistogram(metric, options, record),
      addBreadcrumb: (message, data) => {
        this.addBreadcrumb(message, data);
      },
      ownRequest: runAsLibraryRequest,
    };

    return {
      name,
      install: () => {
        plugin.install(ctx);
      },
      uninstall: () => {
        plugin.uninstall();
      },
    };
  }

  /**
   * Imports one capture module. A failed import reports and skips that module only.
   * @param name Capture module name.
   * @returns Promise that resolves to the class, or undefined if the import failed.
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

    // The points of the open interval and the root span go out with the final flush.
    this.meter.collect();
    this.tracing.end();
    this.destroyed = true;

    this.uninstallCaptures();

    // Sender.destroy awaits a normal flush, then runs the exit flush. The records hold
    // their journey already. The journey and the bus can stop first.
    const closing = this.sender?.destroy();
    this.journey.destroy();
    // A record in the forward buffer waits for its microtask. The bus takes it before it stops.
    this.sendForwarded();
    this.bus?.destroy();
    // The delivery stack did not load before shutdown(). The held records are lost.
    this.drops.add("load_failed", this.pendingRecords.take());
    await closing;
    // A load in progress destroys its own stack. shutdown() resolves only after that.
    await this.senderLoad;

    // A local runtime must not remove the runtime of the other version from the global key.
    if (ObservabilityRuntime.pinned() === this) {
      Reflect.deleteProperty(globalThis, RUNTIME_KEY);
      // Calls after shutdown() go to this runtime and do nothing.
      // A new default runtime drops the settings of the app.
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
      this.bootBuffer.push(record);
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

    // Console-only mode has no destination. Count the drop. If not, no counter shows the loss.
    if (!this.senderLoad) {
      this.diagnostics.count("record.dropped_no_destination");
      // After a failed load, the config has a destination but no delivery stack.
      if (this.hasDestination()) {
        this.drops.add("load_failed", [record]);
      }
      return;
    }

    this.pendingRecords.push(record);
  }

  /**
   * Counts a record that a full hold buffer drops. It gives the record to the onDrop report.
   * @param record Dropped record.
   */
  private dropHeld(record: LogRecord): void {
    this.diagnostics.count("record.dropped_boot_buffer_full");
    this.drops.add("buffer_full", [record]);
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
      this.sendForwarded();
    });
  }

  /** Gives the records of the forward buffer to the bus. */
  private sendForwarded(): void {
    const records = this.forwardBuffer;
    this.forwardBuffer = [];
    if (records.length > 0) {
      this.bus?.sendRecords(records);
    }
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
    const buffered = this.bootBuffer.take();
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
   * Gives lost records to the onDrop report.
   * @param reason Cause of the loss.
   * @param records Lost records.
   * @param batchIds Ids of the lost batches.
   */
  private readonly reportLoss: LossReporter = (reason, records, batchIds) => {
    this.drops.add(reason, records, batchIds);
  };

  /**
   * Gives the evicted batches to the onDrop report. It also emits a warning record. A throttle
   * limits the warning records.
   * @param result Storage prune summary metrics.
   * @param dropped The evicted batches.
   */
  private readonly reportGap = (result: PruneResult, dropped: readonly LogBatch[]): void => {
    this.drops.add(
      result.reason,
      dropped.flatMap((batch) => batch.records),
      dropped.map((batch) => batch.id),
    );

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
   * Starts a new session in this context. Other tabs and frames read the new id at their next
   * startup. It ends the active journey and starts a new trace.
   */
  newSession(): void {
    if (this.destroyed) {
      return;
    }

    const fresh = newId(this.diagnostics);
    (this.identity as { sessionId: string }).sessionId = fresh;
    this.sessionTouch.restart(fresh);
    this.builder.invalidateResource();

    this.journey.end();
    this.tracing.rotate("explicit");
  }

  /**
   * Reads the delivery state of this context.
   * @returns Promise that resolves to the counts and the time of the last accepted send.
   */
  async stats(): Promise<DeliveryStats> {
    // queueDepth() waits for a loading delivery stack. The held records are then in the pipeline.
    const stored = await this.queueDepth();
    const delivery = this.sender?.stats() ?? { pending: 0, inFlight: 0, lastSendAt: null };
    const held = this.bootBuffer.length + this.pendingRecords.length + this.forwardBuffer.length;

    return { ...delivery, pending: delivery.pending + held, stored };
  }

  /**
   * Counts the batches held in storage after a failed or deferred delivery.
   * @returns Promise that resolves to the number of stored batches. A forwarder stores
   * nothing and reports 0.
   */
  async queueDepth(): Promise<number> {
    await this.senderLoad;
    return (await this.sender?.queueDepth()) ?? 0;
  }

  /**
   * Flushes all pending records in the pipeline or forward buffer.
   * @returns Promise that resolves when the library sends or hands off the queued records.
   */
  async flush(): Promise<void> {
    this.meter.collect();

    // A record logged during startup waits in the boot buffer. Without this wait, flush() misses it.
    // After startup, do not wait. The handover of the forward buffer then stays synchronous.
    if (!this.ready) {
      await this.started;
    }

    if (this.role() === "forwarder") {
      this.sendForwarded();
      return;
    }

    await this.senderLoad;
    await this.sender?.flush();
  }
}

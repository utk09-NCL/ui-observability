// src/core/runtime.ts
//
// This runtime coordinates the subsystems. It manages their lifecycles, the configuration
// and the routing of records.

import type { Bus } from "../bus/bus";
import type { Receive, WorkerLike } from "../bus/links";
import type { Capture, CaptureContext, CaptureOnce } from "../capture/types";
import {
  ATTR_BREADCRUMBS,
  ATTR_PAGE_URL,
  CAPTURE_NAMESPACE,
  DIAGNOSTICS_NAMESPACE,
  GAP_REPORT_THROTTLE_MS,
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
import type { FrameOptions, SourceOptions } from "../models/bus";
import type {
  CaptureOptions,
  IdentityStrategy,
  ObservabilityConfig,
  ResolvedConfig,
  StorageStrategy,
  SecurityContextUpdate,
  SecurityContextRotationOptions,
} from "../models/config";
import type { LossReporter } from "../models/drop";
import type { InstrumentDef, MetricAttributes } from "../models/metric";
import type { CapturePlugin, PluginContext } from "../models/plugin";
import { isLogRecord, type LogRecord } from "../models/log-record";
import type { DeliveryStats } from "../models/stats";
import type { DebugBundle, ObservabilityHealth } from "../models/health";
import type { PruneResult, StorageAdapter, StoragePersistence } from "../models/storage";
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
import { DebugBuffer } from "./debug-buffer";
import {
  type DiagnosticCode,
  type DiagnosticEvent,
  type DiagnosticHandler,
  Diagnostics,
} from "./diagnostics";
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
  uncleanExit: async (): Promise<CaptureClass> =>
    (await import("../capture/unclean-exit")).UncleanExitCapture,
  userTiming: async (): Promise<CaptureClass> =>
    (await import("../capture/user-timing")).UserTimingCapture,
};

/** Name of one capture module. */
type CaptureName = keyof typeof CAPTURE_LOADERS;

/** Constructor of the WebSocket capture plugin. */
type WebSocketClass = new (diagnostics: Diagnostics, config: ResolvedConfig) => CapturePlugin;

/** Id of each plugin object. A new plugin object then changes the capture key. */
const pluginIds = new WeakMap<object, number>();

/** Last plugin id that pluginId() gave. */
let lastPluginId = 0;

/**
 * Gives the id of a plugin object. The capture key must not hold the plugin. A plugin can hold
 * a cycle, and JSON.stringify then throws.
 * @param plugin Plugin of the app.
 * @returns The id of the object.
 */
function pluginId(plugin: object): number {
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

/** Delivery settings that a rotation resets when the update omits them. */
const DELIVERY_RESET = {
  endpoint: null,
  metricsEndpoint: "",
  tracesEndpoint: "",
  headers: undefined,
  credentials: "omit",
  transport: undefined,
  transportOnExit: undefined,
} as const;

/** Delivery settings that configure() cannot change while isolation is on. */
const ROUTING_KEYS = Object.keys(DELIVERY_RESET) as (keyof typeof DELIVERY_RESET)[];

/** Diagnostic codes that report a normal event, not a fault. Their records have the level INFO. */
const NOTICE_CODES: ReadonlySet<DiagnosticCode> = new Set([
  "bus.role_resolved",
  "config.reconfigured",
  "security.rotated",
  "journey.adopted",
  "journey.expired",
]);

/**
 * Makes a text key of the capture section. A later configure() reinstalls the capture
 * modules only when the key changes. A reinstall unpatches and patches each host function.
 * @param capture Capture section.
 * @returns The key. A function and a RegExp give a fixed text.
 */
function captureKey(capture: CaptureOptions): string {
  return JSON.stringify({
    ...capture,
    urlTransform: capture.urlTransform ? pluginId(capture.urlTransform) : undefined,
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
    metricsEndpoint: "",
    tracesEndpoint: "",
    transport: undefined,
    transportOnExit: undefined,
    bus: { ...input.bus, mode: "off" },
  };
}

/**
 * Tests if a configuration names a destination.
 * @param input Consumer configuration options.
 * @returns True with an endpoint, a signal endpoint or a transport.
 */
function sends(input: Partial<ObservabilityConfig>): boolean {
  return (
    Boolean(input.endpoint) ||
    Boolean(input.metricsEndpoint) ||
    Boolean(input.tracesEndpoint) ||
    input.transport !== undefined
  );
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
  /** True while the runtime changes the security context. */
  private rotating = false;
  /** True while the runtime collects the last records of the old context. */
  private closingContext = false;
  /** Version of another SDK copy that owns the page runtime, or null. */
  private mismatchVersion: string | null = null;
  /** True if the configured context id differs from the owner context id. */
  private contextMismatch = false;
  /** Current context change. Shutdown waits for this promise. */
  private rotation?: Promise<void>;
  /** Memory store kept for later context changes. */
  private memoryStorage?: StorageAdapter;
  /** State of the request for persistent storage. getHealth() reports it. */
  private storagePersistence: StoragePersistence = "off";
  /** True while a diagnostic record goes out. A diagnostic during that time gives no record. */
  private recordingDiagnostic = false;
  /** Logger of the records that diagnostics.records gives. */
  private readonly diagnosticLogger = new OneLogger(() => this, DIAGNOSTICS_NAMESPACE);
  /** Records that minLevel or sampling dropped. An error of this context sends them first. */
  private readonly debugBuffer = new DebugBuffer(() => this.config.debugBuffer);
  /** True if the app supplied a context id at startup. */
  private explicitSecurityContext: boolean;
  /** True after this forwarder takes a context id from its owner. */
  private ownerAdopted = false;

  /**
   * Checks if a security context change is in progress.
   * @returns True until the current change completes.
   */
  isRotating(): boolean {
    return this.rotating;
  }

  /**
   * Locks or unlocks configuration at the request of the app. Other code of this origin can
   * call this method. The lock does not control access.
   * @param locked True to refuse changes through configure().
   */
  setConfigurationLocked(locked: boolean): void {
    if (typeof locked === "boolean") this.config.lockConfiguration = locked;
  }
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
    uncleanExit: false,
    userTiming: false,
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
   * True for a console-only runtime. It sends nothing, joins no bus and installs no capture.
   * Another version of the library on the page, or a server, makes it console-only.
   */
  private readonly degraded: boolean;

  /** True after the report of a destination on a server. The runtime reports it one time. */
  private serverReported = false;

  /**
   * Ends the root span of a forwarder when its document unloads. The exit flush ends it only in
   * the sender. Without this, the client spans of a frame or a view have no parent.
   */
  private readonly onPageHide = (): void => {
    if (this.role() !== "forwarder") {
      return;
    }

    this.tracing.end();
    this.sendForwarded();
  };

  /**
   * @param input Initial consumer configuration options.
   * @param mismatch True for a console-only runtime next to another version.
   */
  private constructor(input: Partial<ObservabilityConfig>, mismatch = false) {
    this.diagnostics = new Diagnostics(input.onDiagnostic);

    this.platform = detectPlatform(this.diagnostics);
    // A server has no page to capture and no storage. It writes to the console only.
    this.degraded = mismatch || this.onServer();
    this.config = resolveConfig(this.allowed(input), this.diagnostics);
    this.explicitSecurityContext = Boolean(input.securityContext?.id);
    this.config.securityContext.id ||= newId(this.diagnostics);
    this.diagnostics.setPolicy(
      this.config.diagnostics.throttleMs,
      this.config.diagnostics.consoleFallback,
    );
    this.identityBuiltAs = this.config.identity;
    this.stores =
      this.identityBuiltAs === "memory" || this.onServer() ? memoryStores() : BROWSER_STORES;
    this.identity = resolveIdentity(
      this.diagnostics,
      this.stores,
      this.config.correlation.sessionIdleMs,
    );
    this.sessionTouch = new SessionTouch(
      this.diagnostics,
      this.stores,
      this.config.correlation.sessionTouchMs,
      this.config.correlation.sessionIdleMs,
    );
    this.breadcrumbs = new BreadcrumbBuffer(this.config.capturePolicy.breadcrumbs);
    // Sample a span by its trace. The whole trace stays or goes.
    const keeps = (traceId: string): boolean =>
      sampleKey(traceId, this.config.sampling.defaultRate);
    this.tracing = new TraceEngine(
      this.diagnostics,
      this.config.correlation.traceMaxAgeMs || Infinity,
      this.config.otelLoader,
      {
        enabled: () => this.config.tracesEndpoint !== "",
        keeps,
        onEnd: (ended) => {
          if (keeps(ended.traceId)) {
            this.recordSpan(rootSpan(ended));
          }
        },
      },
    );
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
      debug: this.debugBuffer,
    });

    this.meter = new Meter(
      () => this.config.batching.metricFlushIntervalMs,
      (name, attributes, fields) => {
        this.emitPoint(name, attributes, fields);
      },
      this.diagnostics,
      this.config.metrics,
    );
    // The record builder exists now. A diagnostic can become a record.
    this.diagnostics.setHandler(this.diagnosticHandler());
  }

  /**
   * Gives the handler of the diagnostics. With diagnostics.records, it also sends each event
   * as a record.
   * @returns The handler, or undefined without onDiagnostic and without diagnostic records.
   */
  private diagnosticHandler(): DiagnosticHandler | undefined {
    if (this.config.diagnostics.records === false) {
      return this.config.onDiagnostic;
    }

    return (event) => {
      this.recordDiagnostic(event);
      this.config.onDiagnostic?.(event);
    };
  }

  /**
   * Sends a diagnostic event as a record when diagnostics.records selects its code.
   * A diagnostic during that send gives no record. That stops a loop.
   * @param event Diagnostic event.
   */
  private recordDiagnostic(event: DiagnosticEvent): void {
    const { records } = this.config.diagnostics;
    const selected = records === true || (records !== false && records.includes(event.code));
    if (!selected || this.recordingDiagnostic) {
      return;
    }

    this.recordingDiagnostic = true;
    try {
      const write = NOTICE_CODES.has(event.code)
        ? this.diagnosticLogger.info
        : this.diagnosticLogger.warn;
      write(event.message, {
        "diagnostic.code": event.code,
        "diagnostic.count": event.count,
        "diagnostic.detail": event.detail,
      });
    } finally {
      this.recordingDiagnostic = false;
    }
  }

  /**
   * Adds a breadcrumb from app code. It copies the data now. A later change of the object of the
   * app then does not change the trail.
   * @param message Description of the event. A JavaScript caller can pass a value that is not a
   * string. The library converts it.
   * @param data Optional metadata.
   */
  addBreadcrumb(message: unknown, data?: Record<string, unknown>): void {
    if (this.rotating || this.destroyed) return;
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
    if (!this.destroyed && !this.rotating) {
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
   * Checks the source policy before a direct child link opens.
   * @param source Child window.
   * @param origin Origin of the child window.
   * @returns True if the bus permits this source.
   */
  readonly busCanAccept = (source: Window, origin: string): boolean =>
    this.bus?.isRegistered(source, origin) ?? false;

  /**
   * Receives direct messages from same-origin child frames.
   * @param message Inbound bus message.
   * @param reply Direct response callback.
   * @param source Window of the child frame.
   */
  readonly busAccept = (message: BusMessage, reply: Receive, source?: Window): void => {
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
          bus.acceptDirect(message, reply, source);
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
      local.reconfigure(input);
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
    const runtime = new ObservabilityRuntime(input, true);
    ObservabilityRuntime.local = runtime;

    const foundText = typeof found === "string" ? found : "before 0.9.0";
    runtime.mismatchVersion = foundText;
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
    if (this.rotating) {
      this.diagnostics.report(
        "config.locked",
        "Configuration cannot change during security-context rotation.",
      );
      return;
    }
    if (this.config.lockConfiguration) {
      const next = resolveConfig(input, this.diagnostics, this.config);
      if (!sameConfig(this.config, next))
        this.diagnostics.report(
          "config.locked",
          "Runtime configuration is locked. Use setConfigurationLocked(false) to unlock it explicitly.",
        );
      return;
    }
    const accepted = this.keepDestination(this.keepRouting(this.allowed(input)));
    // The first configure() after an implicit start is the startup of the app. Its id is explicit.
    if (!this.tunablesLocked && accepted.securityContext?.id) {
      this.explicitSecurityContext = true;
    }
    for (const key of ["correlation", "persistence"] as const) {
      // The sender reads the namespace when it loads. Before that, the first configure() can set it.
      if (key === "persistence" && !this.tunablesLocked && this.senderLoad === undefined) {
        continue;
      }
      if (
        accepted[key] &&
        !sameConfig({ ...this.config[key], ...accepted[key] }, this.config[key])
      ) {
        this.diagnostics.report("config.invalid", `${key} cannot change after startup.`);
        Object.assign(accepted, { [key]: this.config[key] });
      }
    }
    const capturesBefore = captureKey(this.config.capture);
    const next = resolveConfig(accepted, this.diagnostics, this.config);
    this.keepStartupTunables(next);
    applyResolvedConfig(this.config, next);
    this.breadcrumbs.resize(this.config.capturePolicy.breadcrumbs);
    this.diagnostics.setHandler(this.diagnosticHandler());
    this.diagnostics.setPolicy(
      this.config.diagnostics.throttleMs,
      this.config.diagnostics.consoleFallback,
    );

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
   * Tests if the runtime runs on a server, for example Node during server-side rendering.
   * @returns True on Node.
   */
  private onServer(): boolean {
    return this.platform.platform === "node";
  }

  /**
   * Removes the delivery settings from the input of a console-only runtime. On a server, it
   * reports a destination one time.
   * @param input Consumer configuration options.
   * @returns The options that the runtime accepts.
   */
  private allowed(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig> {
    if (!this.degraded) {
      return input;
    }

    if (this.onServer() && !this.serverReported && sends(input)) {
      this.serverReported = true;
      this.diagnostics.report(
        "config.invalid",
        "The library runs console-only on Node. It sends no record and installs no capture. It ignores endpoint, metricsEndpoint, tracesEndpoint and transport.",
      );
    }

    return consoleOnly(input);
  }

  /**
   * Removes delivery and identity changes while isolation is on. The other settings still apply.
   * @param input Consumer configuration options.
   * @returns The options without the refused delivery or identity changes.
   */
  private keepRouting(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig> {
    if (!this.tunablesLocked || this.degraded || !this.config.securityContext.isolation) {
      return input;
    }

    // Compare resolved values. An unset endpoint keeps the endpoint in force. It is not a change.
    // A separate reporter prevents a second count of the diagnostics of the real resolve.
    const probe = resolveConfig(input, new Diagnostics(), this.config);
    const refused: string[] = ROUTING_KEYS.filter(
      (key) => !sameConfig(probe[key], this.config[key]),
    );
    if (probe.securityContext.id !== this.config.securityContext.id) {
      refused.push("securityContext.id");
    }
    if (refused.length === 0) {
      return input;
    }

    const kept: Partial<ObservabilityConfig> = { ...input };
    for (const key of ROUTING_KEYS) {
      if (refused.includes(key)) {
        Reflect.deleteProperty(kept, key);
      }
    }
    if (refused.includes("securityContext.id")) {
      const context = { ...input.securityContext };
      Reflect.deleteProperty(context, "id");
      kept.securityContext = context;
    }

    this.diagnostics.report(
      "config.invalid",
      `Isolation refuses changes to ${refused.join(", ")}. Use rotateSecurityContext() for these changes. To permit them, set securityContext.isolation: false in a separate configure() call. The other settings apply.`,
    );
    return kept;
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
      if (sameConfig(next[section], this.config[section])) {
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
    // A console-only runtime never forwards. Node has no addEventListener.
    if (!this.degraded) {
      addEventListener("pagehide", this.onPageHide);
    }

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
          onSecurityContext: (id) => {
            if (this.explicitSecurityContext && this.config.securityContext.id !== id) {
              this.contextMismatch = true;
              this.diagnostics.report(
                "security.context_mismatch",
                "The configured security context differs from the upstream owner.",
              );
              return false;
            }
            this.contextMismatch = false;
            if (this.config.securityContext.id !== id) {
              // The first owner id keeps the startup records and the context of the app. Those
              // records had no other identity. A later change retires them, also before ready.
              if (this.ownerAdopted) {
                this.drops.add("security_context", [
                  ...this.bootBuffer.take(),
                  ...this.pendingRecords.take(),
                  ...this.forwardBuffer,
                ]);
                this.forwardBuffer = [];
                this.context.clear();
                this.breadcrumbs.clear();
                // collect() removes the open measurements. emit() refuses them during this reset.
                const rotating = this.rotating;
                this.rotating = true;
                this.meter.collect();
                // A same-origin owner stores its new session before it sends the new id. Use that
                // session. Without it, each frame starts a different session.
                const shared = this.sessionTouch.stored();
                this.resetSession(
                  shared !== undefined && shared !== this.identity.sessionId
                    ? shared
                    : newId(this.diagnostics),
                );
                this.rotating = rotating;
              }
              this.config.securityContext.id = id;
            }
            this.ownerAdopted = true;
            return true;
          },
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
            storage: this.memoryStorage,
            onStorage: (storage) => {
              if (storage.name === "memory") this.memoryStorage = storage;
            },
            onPersistence: (state) => {
              this.storagePersistence = state;
            },
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
    if (settings.uncleanExit) {
      names.push("uncleanExit");
    }
    if (settings.userTiming) {
      names.push("userTiming");
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
      isActive: () => !this.destroyed && !this.rotating,
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
      sessionId: () => this.identity.sessionId,
    };

    for (const CaptureModule of classes) {
      if (CaptureModule) {
        this.captures.push(new CaptureModule(ctx));
      }
    }

    const plugins = WebSocketCapture
      ? [...settings.plugins, new WebSocketCapture(this.diagnostics, this.config)]
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
  registerWorker(worker: WorkerLike, options: SourceOptions = {}): () => void {
    let cancelled = false;
    let detach: (() => void) | undefined;
    if (this.destroyed) {
      return () => undefined;
    }

    // Attach on construction. The worker's handshake can time out while the bus starts.
    void this.constructBus().then((bus) => {
      if (!bus || this.destroyed || cancelled) {
        return;
      }

      this.diagnostics.guard(
        "bus.send_failed",
        "The library could not register the worker.",
        () => {
          detach = bus.attachWorker(worker, options);
        },
      );

      // Start the bus in bus.mode "off", where startup did not start it.
      void this.ensureBus();
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }

  /**
   * Registers a frame after the bus loads. Early removal cancels the registration.
   * @param frame Child frame or window.
   * @param options Expected origin and source permissions.
   * @returns Function that removes this registration.
   */
  registerFrame(frame: HTMLIFrameElement | Window, options: FrameOptions): () => void {
    let cancelled = false;
    let detach: (() => void) | undefined;
    void this.constructBus().then((bus) => {
      if (!bus || this.destroyed || cancelled) return;
      detach = this.diagnostics.guard("bus.send_failed", "The frame could not be registered.", () =>
        bus.registerFrame(frame, options),
      );
      void this.ensureBus();
    });
    return () => {
      cancelled = true;
      detach?.();
    };
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

    if (!this.degraded) {
      removeEventListener("pagehide", this.onPageHide);
    }

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
    await this.rotation?.catch(() => undefined);
    await this.memoryStorage?.close();

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
    if (!record || this.destroyed || (this.rotating && !this.closingContext)) {
      return;
    }

    this.sessionTouch.touch(this.identity.sessionId);

    // An error first sends the records that minLevel or sampling dropped before it.
    const error = record.severityText === "ERROR" || record.severityText === "FATAL";
    const records = error ? [...this.debugBuffer.drain(), record] : [record];

    for (const one of records) {
      if (this.ready) {
        this.route(one);
      } else {
        this.bootBuffer.push(one);
      }
    }
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
    if (this.destroyed) return;
    if (!Array.isArray(records)) {
      this.diagnostics.count("record.dropped_malformed");
      return;
    }
    const accepted: LogRecord[] = [];
    for (const record of records) {
      if (!isLogRecord(record)) {
        this.diagnostics.count("record.dropped_malformed");
        continue;
      }
      if (!shouldSample(record, this.config, this.remote.sampling?.current() ?? null)) {
        this.diagnostics.count("record.dropped_by_sampling");
        continue;
      }

      // A child context without redact forwards raw records. The sender is the last gate.
      const redacted = this.builder.redactForwarded(record);
      if (redacted) {
        accepted.push(redacted);
      }
    }

    // Records that arrive while the context changes belong to neither identity. Report the loss
    // after sampling and redact. onDrop must not get action names or journey ids that redact masks.
    if (this.rotating) {
      this.drops.add("security_context", accepted);
      return;
    }

    for (const record of accepted) {
      this.deliver(record);
    }
  }

  /** Flushes the startup records. It adds the active journey to records without a journey. */
  private releaseBootBuffer(): void {
    const buffered = this.bootBuffer.take();
    // A hook already saw each record. A key added now does not pass redact.
    const { processors, redact } = this.config;
    const journey = processors.length === 0 && redact === undefined ? this.journey.current() : null;

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
   * Starts a new session in this context. It sends the open metric points, starts a new trace,
   * ends the active journey and clears the breadcrumbs. Other tabs read the new id at their next
   * startup.
   */
  newSession(): void {
    if (this.destroyed) {
      return;
    }

    this.resetSession(newId(this.diagnostics));
  }

  /**
   * Closes the work of the old session and starts the given session.
   * @param sessionId Id of the session to start.
   */
  private resetSession(sessionId: string): void {
    // Close the work of the old session first. Its points and its root span keep the old id.
    this.meter.collect();
    this.tracing.rotate("explicit");
    this.journey.end();
    // A shared machine: the next user must not see the trail of the previous user.
    this.breadcrumbs.clear();
    this.debugBuffer.clear();

    (this.identity as { sessionId: string }).sessionId = sessionId;
    this.sessionTouch.restart(sessionId);
    this.builder.invalidateResource();
  }

  /**
   * Changes the delivery context in one operation. A second change must wait for this change.
   * @param update New identity, delivery settings and context attributes.
   * @param options Rule for records of the old context and the flush deadline.
   * @returns Promise that resolves when the change completes. Invalid settings reject it.
   */
  rotateSecurityContext(
    update: SecurityContextUpdate,
    options: SecurityContextRotationOptions = {},
  ): Promise<void> {
    // Check the promise, not the flag. "carry" clears the flag before it stores old batches again.
    if (this.rotation)
      return Promise.reject(new Error("A security-context rotation is already running."));
    const pending = options.pending ?? "discard";
    const timeoutMs = options.timeoutMs ?? 5000;
    if (
      !isObject(update) ||
      !isObject(update.delivery) ||
      !["discard", "flush", "retain", "carry"].includes(pending) ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      (update.id !== undefined && (typeof update.id !== "string" || update.id.length === 0))
    ) {
      return Promise.reject(new Error("Invalid security-context rotation options."));
    }
    if (this.destroyed) return Promise.reject(new Error("The runtime has stopped."));
    this.rotating = true;
    this.rotation = this.rotateContext(update, pending, timeoutMs).finally(() => {
      this.rotating = false;
      this.rotation = undefined;
    });
    return this.rotation;
  }

  /**
   * Checks new settings, stops old delivery and starts the new context.
   * @param update New identity, delivery settings and attributes.
   * @param pending Rule for the old records.
   * @param timeoutMs Maximum wait for an old-context flush, in milliseconds.
   * @returns Promise that resolves when the context change completes.
   */
  private async rotateContext(
    update: SecurityContextUpdate,
    pending: "discard" | "flush" | "retain" | "carry",
    timeoutMs: number,
  ): Promise<void> {
    await this.started;
    if (this.role() === "forwarder")
      throw new Error(
        "Rotate the security context on the upstream owner, or use bus.mode: sender for an independent identity.",
      );
    await this.senderLoad;
    const previous = this.config.securityContext.id;
    const nextId = update.id ?? newId(this.diagnostics);
    if (nextId === previous)
      throw new Error("A rotation requires a different security-context id.");
    // Check the new settings before the old sender stops. Invalid settings keep the old sender.
    const delivery = { ...DELIVERY_RESET, ...update.delivery };
    const before = this.diagnostics.snapshot()["config.invalid"] ?? 0;
    // The base has no old delivery values. An invalid new value cannot fall back to an old one.
    const next = resolveConfig(
      this.allowed({ ...delivery, securityContext: { id: nextId } }),
      this.diagnostics,
      { ...this.config, ...DELIVERY_RESET },
    );
    if ((this.diagnostics.snapshot()["config.invalid"] ?? 0) !== before)
      throw new Error("Invalid delivery settings for the next security context.");
    // Copy the context now. A getter that throws then rejects before the old sender stops.
    const context = update.context ? Object.fromEntries(Object.entries(update.context)) : undefined;

    // The base above has no endpoints. Remove the old endpoints from the ignore list here.
    // If they stay, network capture ignores calls to the old destination.
    const oldUrls = new Set<unknown>([
      this.config.endpoint,
      this.config.metricsEndpoint,
      this.config.tracesEndpoint,
    ]);
    const newUrls = new Set<unknown>([next.endpoint, next.metricsEndpoint, next.tracesEndpoint]);
    next.capture.ignoreUrls = next.capture.ignoreUrls.filter(
      (url) => !oldUrls.has(url) || newUrls.has(url),
    );

    this.closingContext = true;
    try {
      this.meter.collect();
      this.tracing.end();
      this.journey.end();
    } finally {
      this.closingContext = false;
    }
    const held = [...this.bootBuffer.take(), ...this.pendingRecords.take(), ...this.forwardBuffer];
    this.forwardBuffer = [];
    const old = this.sender;
    this.sender = undefined;
    this.senderLoad = undefined;
    const retired = (await old?.retire(pending, timeoutMs, previous)) ?? {
      buffered: [],
      stored: [],
    };
    if (this.destroyed) return;
    const live = [...held, ...retired.buffered];
    const stored = retired.stored.flatMap((batch) => batch.records);
    if (pending !== "retain" && pending !== "carry") {
      this.drops.add("security_context", [...live, ...stored]);
    }
    // Keep a lock change that the app made during the rotation.
    next.lockConfiguration = this.config.lockConfiguration;
    // Replace all delivery settings together. Do not keep old credentials or signal endpoints.
    applyResolvedConfig(this.config, next);
    this.remote.sampling = null;
    this.context.clear();
    if (context) this.context.setMany(context);
    this.breadcrumbs.clear();
    this.newSession();
    this.builder.invalidateResource();
    await this.syncSender();
    this.bus?.rotateContext();
    if (pending === "carry") {
      // New calls go to the new sender while it stores the old batches again. A long carry then
      // drops no logger call.
      this.rotating = false;
      await this.carry(live, retired.stored);
    }
    this.diagnostics.report("security.rotated", "The runtime rotated its security context.", {
      pending,
    });
  }

  /**
   * Moves the records of the old context into the new context.
   * @param live Records that were in memory. They go through the live buffer.
   * @param stored Batches that were stored. The new sender stores them again.
   * @returns Promise that resolves when the stored batches are stored again.
   */
  private async carry(live: LogRecord[], stored: LogBatch[]): Promise<void> {
    for (const record of live) {
      this.route(record);
    }

    // The live buffer does not take the stored backlog. It would exceed the buffer budget.
    // Without a new sender, the stored batches stay parked under the old id. Nothing is lost.
    if (this.sender) {
      await this.sender.adopt(stored, this.config.securityContext.id);
    }
  }

  /**
   * Collects the state of this runtime for a support ticket. The app decides where to send it.
   * @param health Health snapshot from the facade, with the logger cache counts.
   * @returns Promise that resolves to the JSON-safe bundle.
   */
  async debugBundle(health: ObservabilityHealth): Promise<DebugBundle> {
    const { configSummary } = await import("./debug-bundle");
    // Build the breadcrumbs as a record. The privacy hooks then run, as in an error record.
    const { record } = this.builder.build(
      {
        level: "INFO",
        type: "system",
        body: "debug bundle",
        namespace: DIAGNOSTICS_NAMESPACE,
        payload: { [ATTR_BREADCRUMBS]: this.breadcrumbs.snapshot() },
      },
      true,
    );
    const attributes = record?.attributes ?? {};
    const crumbs = attributes[ATTR_BREADCRUMBS];
    const pageUrl = attributes[ATTR_PAGE_URL];

    return {
      createdAt: new Date().toISOString(),
      sdkVersion: this.sdkVersion,
      health,
      diagnostics: this.diagnostics.snapshot(),
      resource: record?.resource ?? {},
      pageUrl: typeof pageUrl === "string" ? pageUrl : "",
      breadcrumbs: Array.isArray(crumbs) ? crumbs : [],
      debugBuffer: this.debugBuffer.snapshot(),
      config: configSummary(this.config, this.limits, this.diagnostics),
    };
  }

  /**
   * Reads the state of this runtime. It does not wait for startup or the sender to load.
   * @returns State, delivery counts and policies. The facade adds the logger cache counts.
   */
  async health(): Promise<Omit<ObservabilityHealth, "loggerCache">> {
    const delivery = this.sender?.stats() ?? { pending: 0, inFlight: 0, lastSendAt: null };
    const issues: ObservabilityHealth["issues"] = [];
    if (this.mismatchVersion) issues.push("runtime.version_mismatch");
    if (this.contextMismatch) issues.push("security.context_mismatch");
    if (this.ready && this.hasDestination() && this.role() === "sender" && !this.sender)
      issues.push("sender.unavailable");
    const {
      sourcePolicy,
      validation,
      maxMessageBytes,
      maxRecordsPerMessage,
      maxMessagesPerSecond,
      maxTrackedSources,
    } = this.config.bus;
    return {
      ...delivery,
      pending:
        delivery.pending +
        this.bootBuffer.length +
        this.pendingRecords.length +
        this.forwardBuffer.length,
      stored: (await this.sender?.queueDepth()) ?? 0,
      sdkVersion: this.sdkVersion,
      owningSdkVersion: this.mismatchVersion,
      status: this.destroyed
        ? "stopped"
        : this.rotating
          ? "rotating"
          : issues.length
            ? "degraded"
            : !this.ready
              ? "starting"
              : "ready",
      mode:
        this.role() === "forwarder"
          ? "forwarder"
          : this.hasDestination()
            ? "sender"
            : "console-only",
      senderReady: this.sender !== undefined && !this.destroyed && !this.rotating,
      configurationLocked: this.config.lockConfiguration,
      issues,
      securityContext: { ...this.config.securityContext },
      storagePersistence: this.storagePersistence,
      bus: {
        sourcePolicy,
        validation,
        maxMessageBytes,
        maxRecordsPerMessage,
        maxMessagesPerSecond,
        maxTrackedSources,
      },
    };
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
   * Removes stored records of one context or all contexts in the application namespace.
   * @param scope Part of storage to clear.
   * @returns Promise that resolves when removal completes.
   */
  async clearPersisted(scope: "context" | "namespace"): Promise<void> {
    await this.senderLoad;
    if (this.sender) {
      await this.sender.clearPersisted(scope, this.config.securityContext.id);
      return;
    }
    const [
      { createStorage, storageName },
      { ContextStorage },
      { storageLimits },
      { clearEmergencyContext },
    ] = await Promise.all([
      import("../storage/factory"),
      import("../storage/context-storage"),
      import("../models/storage"),
      import("../storage/emergency-queue"),
    ]);
    const namespace = this.config.persistence.namespace;
    const backing =
      this.memoryStorage ??
      (await createStorage(
        this.config.storage,
        storageName(namespace),
        storageLimits(this.config.retention),
        this.diagnostics,
        undefined,
        namespace,
      ));
    const store = new ContextStorage(backing, this.config.securityContext, namespace);
    try {
      if (scope === "namespace") await store.clearNamespace();
      else await store.clear();
      clearEmergencyContext(
        this.config.securityContext.id,
        this.diagnostics,
        namespace,
        scope === "namespace",
      );
    } finally {
      if (backing !== this.memoryStorage) await store.close();
    }
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

/**
 * Compares resolved settings without JSON conversion. Functions keep their object identity.
 * The seen map stops a cycle from causing a repeated comparison.
 * @param a First value.
 * @param b Second value.
 * @param seen Object pairs already compared.
 * @returns True if the values are equal.
 */
function sameConfig(a: unknown, b: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (key) => Object.hasOwn(b, key) && sameConfig(Reflect.get(a, key), Reflect.get(b, key), seen),
    )
  );
}

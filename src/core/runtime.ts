// src/core/runtime.ts
//
// Coordinates the subsystems. Manages their lifecycles, the configuration and record routing.

import type { Bus } from "../bus/bus";
import type { Receive, WorkerLike } from "../bus/links";
import type { Capture, CaptureContext, CaptureOnce } from "../capture/types";
import {
  ATTR_BREADCRUMBS,
  ATTR_DEBUG_BUFFER,
  ATTR_PAGE_URL,
  CAPTURE_NAMESPACE,
  REMOTE_CAPTURE_FLAGS,
  DIAGNOSTICS_NAMESPACE,
  GAP_REPORT_THROTTLE_MS,
  METRIC_NAMESPACE,
  RUNTIME_GLOBAL_KEY,
  RUNTIME_STOPPED_KEY,
  STORAGE_NAMESPACE,
  TELEMETRY_SDK_VERSION,
  TRACE_FLAGS_SAMPLED,
  TRACE_NAMESPACE,
  INSTRUMENT_OPTIONS_FAULT,
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
import type { InstrumentDef, Measure, MetricAttributes } from "../models/metric";
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
import { detectPlatform, type PlatformMetadata, recordedUrl } from "../utils/platform";
import { sanitize, truncate } from "../utils/sanitize";
import { unrefTimer } from "../utils/unref";
import { Sequence } from "../utils/sequence";
import { TraceEngine } from "../utils/tracing";
import { type Breadcrumb, BreadcrumbBuffer } from "./breadcrumbs";
import { applyResolvedConfig, resolveConfig } from "./config";
import { ContextStore } from "./context";
import { DebugBuffer } from "./debug-buffer";
import { cancelDeferred, drainDeferred } from "./deferred";
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
import { createMeasure } from "./measure";
import { makeCounter, makeHistogram, Meter, type RecordMetric } from "./meter";
import { profilerCore, type ProfilerSink } from "./profiler";
import { RecordBuilder } from "./record";
import type { RemoteSlot } from "./remote-sampling";
import { sampleKey, shouldSample } from "./sampling";
import type { Sender } from "./sender";
import { rootSpan, type SpanData, spanFields } from "./spans";

/** Constructor for a capture module. */
type CaptureClass = new (ctx: CaptureContext) => Capture;

/** The import for each capture module. Each one is its own chunk. */
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
  reports: async (): Promise<CaptureClass> => (await import("../capture/reports")).ReportCapture,
  resourceTiming: async (): Promise<CaptureClass> =>
    (await import("../capture/resource-timing")).ResourceTimingCapture,
  lifecycle: async (): Promise<CaptureClass> =>
    (await import("../capture/lifecycle")).LifecycleCapture,
  framePhases: async (): Promise<CaptureClass> =>
    (await import("../capture/profiler-frames")).FramePhasesCapture,
  framePacing: async (): Promise<CaptureClass> =>
    (await import("../capture/profiler-frames")).FramePacingCapture,
  replay: async (): Promise<CaptureClass> => (await import("../capture/replay")).ReplayCapture,
};

/** Name of a capture module. */
type CaptureName = keyof typeof CAPTURE_LOADERS;

/** The parts of the session replay capture the runtime calls. */
interface ReplayControl extends Capture {
  /** Loads the recorder and starts it. */
  start(): Promise<void>;
  /** Stops the recorder and drops whatever hasn't been sent. */
  stop(): void;
  /** Drops the buffer and, if the recorder was running, starts a fresh recording. */
  reset(): void;
}

/** Constructor for the WebSocket capture plugin. */
type WebSocketClass = new (diagnostics: Diagnostics, config: ResolvedConfig) => CapturePlugin;

/** An id per plugin object, so a new plugin object changes the capture key. */
const pluginIds = new WeakMap<object, number>();

/** The last id pluginId() handed out. */
let lastPluginId = 0;

/**
 * Returns a plugin object's id. The capture key can't hold the plugin itself, because a
 * plugin can contain a cycle and JSON.stringify would throw.
 * @param plugin The app's plugin.
 * @returns The object's id.
 */
function pluginId(plugin: object): number {
  let id = pluginIds.get(plugin);

  if (id === undefined) {
    id = ++lastPluginId;
    pluginIds.set(plugin, id);
  }

  return id;
}

/** Global symbol key for the singleton runtime. All federated bundles share it. */
const RUNTIME_KEY = Symbol.for(RUNTIME_GLOBAL_KEY);

/** Global symbol key for the runtime that shutdown() stopped. */
const STOPPED_KEY = Symbol.for(RUNTIME_STOPPED_KEY);

/** Config sections the delivery stack reads once, when it loads. */
const SENDER_SECTIONS = ["batching", "retention"] as const;

/** Config sections a later configure() can't change. */
type StartupSection = (typeof SENDER_SECTIONS)[number] | "limits";

/** Delivery settings a rotation resets when the update leaves them out. */
const DELIVERY_RESET = {
  endpoint: null,
  metricsEndpoint: "",
  tracesEndpoint: "",
  headers: undefined,
  credentials: "omit",
  transport: undefined,
  transportOnExit: undefined,
  transportWorker: undefined,
} as const;

/** Delivery settings configure() can't change while isolation is on. */
const ROUTING_KEYS = Object.keys(DELIVERY_RESET) as (keyof typeof DELIVERY_RESET)[];

/** Diagnostic codes for a normal event rather than a fault. Their records are logged at INFO. */
const NOTICE_CODES: ReadonlySet<DiagnosticCode> = new Set([
  "bus.role_resolved",
  "config.reconfigured",
  "security.rotated",
  "journey.adopted",
  "journey.expired",
]);

/**
 * Builds a text key for the capture section. A later configure() reinstalls the capture
 * modules only when the key changes, because a reinstall unpatches and repatches every host
 * function.
 * @param capture Capture section.
 * @returns The key. A function or a RegExp becomes fixed text.
 */
function captureKey(capture: CaptureOptions): string {
  return JSON.stringify({
    ...capture,
    urlTransform: capture.urlTransform ? pluginId(capture.urlTransform) : undefined,
    webVitalsLoader: capture.webVitalsLoader !== undefined,
    ignoreUrls: capture.ignoreUrls.map(String),
    propagateTraceHeaderTo: capture.propagateTraceHeaderTo.map(String),
    userTimingInclude: capture.userTimingInclude.map(String),
    plugins: capture.plugins.map(pluginId),
  });
}

/**
 * Trims the URL fields of a diagnostic detail, because their query can hold a key.
 * onDiagnostic stays local and keeps them.
 * @param detail A diagnostic event's detail.
 * @returns The detail to put in a record.
 */
function recordDetail(detail: unknown): unknown {
  if (!isObject(detail)) {
    return detail;
  }

  const copy = { ...detail };
  for (const key of ["url", "endpoint"]) {
    const value = copy[key];
    if (typeof value === "string") {
      copy[key] = recordedUrl(value, false);
    }
  }

  return copy;
}

/**
 * Removes the delivery settings from a configuration. A console-only runtime must not send
 * or join a bus, because the other version's runtime does both.
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
    transportWorker: undefined,
    bus: { ...input.bus, mode: "off" },
  };
}

/**
 * Checks whether a configuration names a destination.
 * @param input Consumer configuration options.
 * @returns True if it has an endpoint, a signal endpoint or a transport.
 */
function sends(input: Partial<ObservabilityConfig>): boolean {
  return (
    Boolean(input.endpoint) ||
    Boolean(input.metricsEndpoint) ||
    Boolean(input.tracesEndpoint) ||
    input.transport !== undefined ||
    input.transportWorker !== undefined
  );
}

/**
 * Checks whether a runtime on a global key comes from this version of the library.
 * @param runtime Runtime on the global key. A runtime older than 0.9.0 has no sdkVersion.
 * @returns True if this copy can call the runtime's methods.
 */
function ownVersion(runtime: ObservabilityRuntime): boolean {
  return runtime.sdkVersion === TELEMETRY_SDK_VERSION;
}

/** Manages subsystem lifecycles, bus coordination and record delivery. */
export class ObservabilityRuntime {
  /** True while the security context is changing. */
  private rotating = false;
  /**
   * True while this runtime has the profiler core attached. Tracking it keeps configure() from
   * restarting the sampling every time, and keeps a runtime with the profiler off from ever
   * creating the core and its global symbol.
   */
  private profilerOn = false;
  /** True while the old context's last records are being collected. */
  private closingContext = false;
  /** Version of another SDK copy that owns the page runtime, or null. */
  private mismatchVersion: string | null = null;
  /** True if the configured context id differs from the owner's context id. */
  private contextMismatch = false;
  /** The context change in progress. Shutdown waits for this promise. */
  private rotation?: Promise<void>;
  /** Memory store kept for later context changes. */
  private memoryStorage?: StorageAdapter;
  /** State of the persistent storage request. getHealth() reports it. */
  private storagePersistence: StoragePersistence = "off";
  /** True while a diagnostic record goes out. Diagnostics raised meanwhile produce no record. */
  private recordingDiagnostic = false;
  /** Logger for the records that diagnostics.records produces. */
  private readonly diagnosticLogger = new OneLogger(() => this, DIAGNOSTICS_NAMESPACE);
  /** Records that minLevel or sampling dropped. An error in this context sends them first. */
  private readonly debugBuffer = new DebugBuffer(() => this.config.debugBuffer);
  /** True if the app supplied a context id at startup. */
  private explicitSecurityContext: boolean;
  /** True once this forwarder has taken a context id from its owner. */
  private ownerAdopted = false;

  /**
   * Checks whether a security context change is in progress.
   * @returns True until the current change completes.
   */
  isRotating(): boolean {
    return this.rotating;
  }

  /**
   * Locks or unlocks configuration when the app asks. Any other code on this origin can call
   * this too, so the lock is not access control.
   * @param locked True to refuse changes through configure().
   */
  setConfigurationLocked(locked: boolean): void {
    if (typeof locked === "boolean") this.config.lockConfiguration = locked;
  }
  /**
   * This copy's runtime when another version of the library owns the page runtime.
   * It stays off the global key.
   */
  private static local: ObservabilityRuntime | null = null;

  /**
   * This runtime's library version. Another copy reads it from the global key, because two
   * versions sharing one runtime would call methods the other version doesn't have.
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

  /** Stores for identity and journey keys, set at startup. */
  private readonly stores: IdentityStores;

  /** The identity strategy the stores were built with. */
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

  /** Slot for the remote sampling rules. The sender or the bus fills it. */
  private readonly remote: RemoteSlot = {
    sampling: null,
    changed: () => {
      this.refreshCaptures();
    },
  };

  /** Number of delivery identity changes. A context's first id doesn't count as a change. */
  private identityEpoch = 0;

  /** Session replay's hook. It gets every ERROR and FATAL record. */
  private errorHook: ((record: LogRecord) => void) | undefined;

  /**
   * True after startReplay(), false after stopReplay(), undefined until either is called. The
   * app's last choice survives a reinstall of the capture modules.
   */
  private replayConsent: boolean | undefined;

  /** The installed session replay capture. */
  private replay: ReplayControl | undefined;

  /** Timer that restores the local capture switches once the remote TTL ends. */
  private remoteCaptureTimer: ReturnType<typeof setTimeout> | undefined;

  /** Settings of the current capture load or install. */
  private installedCaptureKey = "";

  /** The replay settings the running replay capture was built with. */
  private replayBuiltKey = "";

  /** Console sink for local developer output. */
  readonly console: ConsoleSink;

  /** Collects lost records into onDrop summaries. */
  private readonly drops: DropReporter;

  /** Sums the values of the counter and histogram instruments. */
  private readonly meter: Meter;

  /**
   * Cross-realm communication bus. Null until its chunk loads. In bus.mode "off", it loads
   * only when a child frame or a worker needs it.
   */
  private bus: Bus | null = null;

  /** Promise for the bus load and construction. Undefined until first needed. */
  private busBuilt?: Promise<Bus | null>;

  /** Promise for the bus load and start. Undefined until first needed. */
  private busLoad?: Promise<Bus | null>;

  /** The adapter's storage strategy, set when the build starts. */
  private storageBuiltAs?: StorageStrategy;

  /**
   * Delivery stack. Set in the sender role with an endpoint or a custom transport, once the
   * chunk has loaded.
   */
  private sender?: Sender;

  /** The delivery stack load. Undefined when nothing loads, so records have no destination. */
  private senderLoad?: Promise<void>;

  /** Records that arrive while the delivery stack loads. */
  private readonly pendingRecords = new HoldBuffer((record) => {
    this.dropHeld(record);
  });

  /** Active auto-capture instrumentation modules. */
  private readonly captures: Capture[] = [];

  /** Number of capture installs. An install replaced by a later one stops after its load. */
  private captureGeneration = 0;

  /** Capture work that rebuilding the capture modules must not repeat. */
  private readonly captureOnce: CaptureOnce = {
    webVitals: false,
    navigationTiming: false,
    longFrames: false,
    uncleanExit: false,
    userTiming: false,
  };

  /** Holds records created before the bus role is resolved. */
  private readonly bootBuffer = new HoldBuffer((record) => {
    this.dropHeld(record);
  });

  /** Records staged for forwarding on the next microtask. */
  private forwardBuffer: LogRecord[] = [];

  /** True if a microtask drain of the forward buffer is pending. */
  private forwardScheduled = false;

  /** True once startup has decided the bus role. A sender load waits for it. */
  private roleResolved = false;

  /** Resolves when startup releases the boot records. Set by init(), awaited by flush(). */
  private started: Promise<void> = Promise.resolve();

  /** True if asynchronous initialization is complete. */
  private ready = false;

  /** True if shutdown stopped the runtime. */
  private destroyed = false;

  /** When the last storage gap warning was reported, in epoch milliseconds. */
  private lastGapAt = 0;

  /** Record limits for the builder and the console. The app's first configure() sets them. */
  private readonly limits: ResolvedConfig["limits"];

  /** Lifetime rules for the journey engine. The app's first configure() sets the age. */
  private readonly journeyOptions: JourneyOptions;

  /** False in a runtime started by an early log call. The first configure() then sets limits. */
  private tunablesLocked = true;

  /**
   * True for a console-only runtime, which sends nothing, joins no bus and installs no capture.
   * That happens next to another version of the library on the page, or on a server.
   */
  private readonly degraded: boolean;

  /** True once a destination on a server has been reported. It is reported only once. */
  private serverReported = false;

  /**
   * Ends a forwarder's root span when its document unloads. The exit flush only ends it in the
   * sender, so without this the client spans of a frame or a view have no parent.
   */
  private readonly onPageHide = (): void => {
    drainDeferred(this);
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
    // A server has no page to capture and no storage, so it only writes to the console.
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
    // Sample a span by its trace, so the whole trace stays or goes.
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
    // Don't await. Without OTel, records use the ambient trace and nothing is lost.
    void this.tracing.loadOtel();
    // The startup values stick. A later configure() can't change the limits or the journey age.
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
    // The record builder exists now, so a diagnostic can become a record.
    this.diagnostics.setHandler(this.diagnosticHandler());
    this.syncProfiler();
  }

  /**
   * Returns the diagnostics handler. With diagnostics.records, it also sends every event as
   * a record.
   * @returns The handler, or undefined with no onDiagnostic and no diagnostic records.
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
   * A diagnostic raised during that send produces no record, which stops a loop.
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
        "diagnostic.detail": recordDetail(event.detail),
      });
    } finally {
      this.recordingDiagnostic = false;
    }
  }

  /**
   * Adds a breadcrumb from app code. The data is copied now, so a later change to the app's
   * object doesn't change the trail.
   * @param message Description of the event. A JavaScript caller can pass a non-string, which
   * is converted.
   * @param data Optional metadata.
   */
  addBreadcrumb(message: unknown, data?: Record<string, unknown>): void {
    if (this.rotating || this.destroyed) return;
    // A message whose toString() throws, or a data getter that throws, must not throw into
    // the app's call.
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
   * Adds a value to a counter or a histogram. The meter sends one point per interval.
   * @param def The instrument's definition.
   * @param value Value to add.
   * @param attributes The value's attribute set.
   */
  recordMetric(def: InstrumentDef, value: number, attributes?: MetricAttributes): void {
    // Guard against a value after shutdown, whose interval timer would outlive the runtime.
    if (!this.destroyed && !this.rotating) {
      this.meter.record(def, value, attributes);
    }
  }

  /**
   * Starts a timed operation. Its values are dropped if the runtime has shut down or a rotation
   * is running when it ends. With `securityContext.isolation`, a new delivery identity before
   * the end drops them too.
   * @param name Operation name.
   * @param attributes Attribute set for every histogram point.
   * @returns The operation's handle.
   */
  startMeasure(name: string, attributes?: MetricAttributes): Measure {
    const epoch = this.identityEpoch;
    const current = (): boolean =>
      !this.destroyed &&
      !this.rotating &&
      (!this.config.securityContext.isolation || this.identityEpoch === epoch);
    const copied = this.diagnostics.guard(
      "record.sanitize_failed",
      "The library could not read the attributes of the measure.",
      () => ({ ...attributes }),
    );

    // The name's toString() can throw. If it does, the measure gets an empty name.
    const label = this.diagnostics.guard(
      "record.sanitize_failed",
      "The library could not read the name of the measure.",
      () => "".concat(name),
    );

    return createMeasure(label ?? "", copied ?? {}, this.tracing.request().span, {
      metric: (def, value, points) => {
        if (current()) {
          this.recordMetric(def, value, points);
        }
      },
      span: (span) => {
        if (current()) {
          this.recordSpan(span);
        }
      },
    });
  }

  /**
   * Builds and emits the record for one span. The console doesn't print it and minLevel
   * doesn't drop it. The trace engine already sampled the trace before the span existed.
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
   * Builds and emits the record for one aggregated point. The console doesn't print it.
   * @param name Metric name.
   * @param attributes The call's attributes. The record limits apply to them.
   * @param fields The point's metric fields. The record limits don't truncate them.
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
   * Turns the profiler on or off to match profiler.enabled. Before switching off it sends the
   * points that are waiting, because the switch would otherwise drop them.
   */
  private syncProfiler(): void {
    const { enabled } = this.config.profiler;
    if (enabled === this.profilerOn) {
      return;
    }

    this.profilerOn = enabled;
    const core = profilerCore();
    if (!enabled) {
      core.collect(false);
      core.detach();
      return;
    }

    // Profiler points take the same path as meter points, so hooks and transports apply.
    const sink: ProfilerSink = {
      capacity: this.config.profiler.maxProbes,
      intervalMs: () => this.config.profiler.flushIntervalMs,
      emit: (name, attributes, fields) => {
        this.emitPoint(name, attributes, fields);
      },
      diagnostics: this.diagnostics,
      // Same rule as emit(): the first collect of a rotation still goes to the old sender.
      ready: () => !this.rotating || this.closingContext,
      outlier: (name, ms) => {
        this.breadcrumbs.push({
          t: Date.now(),
          category: "profile",
          message: `${name} ${String(Math.round(ms))} ms`,
        });
      },
    };
    core.attach(sink);
  }

  /**
   * Gives or withdraws consent for session replay, and starts or stops the recorder if the
   * capture is installed.
   * @param consent True starts the recorder, false stops it.
   */
  setReplay(consent: boolean): void {
    this.replayConsent = consent;

    if (consent) {
      void this.replay?.start();
    } else {
      this.replay?.stop();
    }
  }

  /**
   * Sends the open interval of the meter and the profiler. The profiler doesn't calibrate here,
   * which keeps flush and the exit path short and synchronous.
   */
  private collectPoints(): void {
    this.meter.collect();
    if (this.profilerOn) {
      profilerCore().collect(false);
    }
  }

  /**
   * Starts a new identity epoch. With isolation on, the profiler also drops its data and open
   * spans, so a span from the old identity can't add to the new one.
   */
  private advanceIdentity(): void {
    this.identityEpoch++;
    if (this.profilerOn && this.config.securityContext.isolation) {
      profilerCore().reset();
    }
  }

  /**
   * Checks the source policy before a direct child link opens.
   * @param source Child window.
   * @param origin The child window's origin.
   * @returns True if the bus allows this source.
   */
  readonly busCanAccept = (source: Window, origin: string): boolean =>
    this.bus?.isRegistered(source, origin) ?? false;

  /**
   * Receives direct messages from same-origin child frames.
   * @param message Inbound bus message.
   * @param reply Direct response callback.
   * @param source The child frame's window.
   */
  readonly busAccept = (message: BusMessage, reply: Receive, source?: Window): void => {
    if (this.destroyed) {
      return;
    }

    // Messages wait for the bus in arrival order, because a promise runs its callbacks in order.
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
   * Returns the runtime on this realm's global key. Another copy of the library can own it.
   * @returns Pinned runtime instance or null.
   */
  private static pinned(): ObservabilityRuntime | null {
    return (
      ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] as ObservabilityRuntime | undefined) ??
      null
    );
  }

  /**
   * Returns this copy's local runtime, or the pinned runtime if there is none. A pinned
   * runtime from another version returns null, and a log call then starts the local runtime.
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
   * A stopped runtime from another version returns null.
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
   * Checks whether shutdown() stopped this runtime.
   * @returns True once destroy() starts.
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
      // The local runtime stays console-only. React StrictMode calls configure() twice.
      local.reconfigure(input);
      return local;
    }
    ObservabilityRuntime.local = null;

    const pinned = ObservabilityRuntime.pinned();
    if (pinned) {
      // A runtime older than 0.9.0 has no sdkVersion, which also counts as another version.
      if (!ownVersion(pinned)) {
        return ObservabilityRuntime.startDegraded(input, pinned.sdkVersion);
      }

      if (!pinned.destroyed) {
        pinned.reconfigure(input);
        return pinned;
      }
    }

    const runtime = new ObservabilityRuntime(input);
    // The app's first configure() sets the limits of a default runtime.
    runtime.tunablesLocked = !implicit;
    (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = runtime;
    Reflect.deleteProperty(globalThis, STOPPED_KEY);
    void runtime.init();
    return runtime;
  }

  /**
   * Starts a console-only runtime next to another version's runtime. It sends nothing, joins
   * no bus and installs no capture. The other version keeps the page runtime.
   * @param input Consumer configuration options.
   * @param found The pinned runtime's sdkVersion. A runtime older than 0.9.0 has none.
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
    drainDeferred(this);
    const accepted = this.keepDestination(this.keepRouting(this.allowed(input)));
    // The first configure() after an implicit start is the app's startup, so its id is explicit.
    if (!this.tunablesLocked && accepted.securityContext?.id) {
      this.explicitSecurityContext = true;
    }
    for (const key of ["correlation", "persistence"] as const) {
      // The sender reads the namespace when it loads. Until then, the first configure() can set it.
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
    const next = resolveConfig(accepted, this.diagnostics, this.config);
    this.keepStartupTunables(next);
    const { redact, processors } = this.config;
    applyResolvedConfig(this.config, next);
    // A kept record only saw the hooks from its own log call. New hooks must not miss it.
    if (this.config.redact !== redact || this.config.processors !== processors) {
      this.debugBuffer.clear();
    }
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
    // The handler and the resource are up to date now, and points and diagnostics use both.
    this.syncProfiler();

    // Reinstall only on a change, because a reinstall unpatches and repatches every host
    // function. A stale capture load stops at its generation check, so a reinstall is safe
    // at any time.
    this.refreshCaptures();

    if (this.roleResolved) {
      void this.syncSender();
    }

    this.diagnostics.report("config.reconfigured", "A later configure() call updated the runtime.");
  }

  /**
   * Checks whether the runtime is on a server, for example Node during server-side rendering.
   * @returns True on Node.
   */
  private onServer(): boolean {
    return this.platform.platform === "node";
  }

  /**
   * Removes the delivery settings from a console-only runtime's input. On a server, it
   * reports a destination once.
   * @param input Consumer configuration options.
   * @returns The options the runtime accepts.
   */
  private allowed(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig> {
    if (!this.degraded) {
      return input;
    }

    if (this.onServer() && !this.serverReported && sends(input)) {
      this.serverReported = true;
      this.diagnostics.report(
        "config.invalid",
        "The library runs console-only on Node. It sends no record and installs no capture. It ignores endpoint, metricsEndpoint, tracesEndpoint, transport and transportWorker.",
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

    // Compare resolved values. An unset endpoint keeps the current endpoint, so it isn't a
    // change. A separate reporter keeps the real resolve's diagnostics from being counted twice.
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
   * Restores the startup tunables in the next config. Each tunable is read once by some part
   * of the runtime, so a later change would have no effect and is refused.
   * @param next The resolved config from a later configure() call.
   */
  private keepStartupTunables(next: ResolvedConfig): void {
    if (this.senderLoad !== undefined) {
      this.keepSections(next, SENDER_SECTIONS);
    }

    // An early log call starts a runtime with defaults. The app's first configure() sets that
    // runtime's limits and journey age.
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

    const { maxProbes } = this.config.profiler;
    if (next.profiler.maxProbes !== maxProbes) {
      this.diagnostics.report(
        "config.invalid",
        `profiler.maxProbes cannot change after startup. It stays ${String(maxProbes)}.`,
        { requested: next.profiler.maxProbes },
      );
      next.profiler.maxProbes = maxProbes;
    }
  }

  /**
   * Refuses a change to config sections by restoring the current values in the next config.
   * @param next The resolved config from a later configure() call.
   * @param sections Sections that can't change.
   */
  private keepSections(next: ResolvedConfig, sections: readonly StartupSection[]): void {
    for (const section of sections) {
      if (sameConfig(next[section], this.config[section])) {
        continue;
      }

      this.diagnostics.report(
        "config.invalid",
        `${section} cannot change after startup. The current values stay.`,
        { requested: next[section] },
      );
      Object.assign(next, { [section]: this.config[section] });
    }
  }

  /**
   * Restores the built adapter's storage strategy. Every other key is read live, but the
   * adapter is built only once. A new adapter would strand the batches in the old one, and
   * that loss is worse than a refused change.
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
   * Without one, the retry engine removes every stored batch as if it were delivered.
   * @param input Partial configuration to merge.
   * @returns Input without the refused changes.
   */
  private keepDestination(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig> {
    if (this.senderLoad === undefined) {
      return input;
    }

    let accepted = input;
    // The stack picks its transport once. A rotation can pick another one.
    for (const key of ["transport", "transportWorker"] as const) {
      const addsOrRemoves =
        key in input && (input[key] === undefined) !== (this.config[key] === undefined);
      if (addsOrRemoves) {
        this.diagnostics.report(
          "config.invalid",
          `You cannot add or remove ${key} after the delivery stack loads. The current transport stays.`,
        );
        accepted = { ...accepted };
        Reflect.deleteProperty(accepted, key);
      }
    }

    const removesEndpoint = accepted.endpoint === null || accepted.endpoint === "";

    if (removesEndpoint && this.config.transport === undefined) {
      this.diagnostics.report(
        "config.invalid",
        "You cannot remove the endpoint after the delivery stack loads. The current endpoint stays.",
      );
      // An undefined endpoint keeps the current endpoint, and keeps it in ignoreUrls.
      accepted = { ...accepted, endpoint: undefined };
    }

    return accepted;
  }

  /**
   * Restores the identity strategy from startup. The ids have existed since startup, and a
   * later change can't move them to another store.
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
    // A console-only runtime never forwards, and Node has no addEventListener.
    if (!this.degraded) {
      addEventListener("pagehide", this.onPageHide);
    }

    // Start the capture imports now so they download in parallel with the bus and the sender.
    const captures = this.installCaptures();

    // Set before the first await, so a flush() right after configure() waits for it.
    this.started = this.boot();
    await this.started;
    await captures;
  }

  /**
   * Resolves the bus role, loads the delivery stack and releases the boot records.
   * Never rejects.
   */
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
      // Release the boot records before the captures load, so the exit flush can find them.
      this.ready = true;
      this.releaseBootBuffer();
    }
  }

  /**
   * Starts the bus load once.
   * @returns Promise that resolves to the started bus, or null if it didn't load.
   */
  private ensureBus(): Promise<Bus | null> {
    this.busLoad ??= this.startBus();
    return this.busLoad;
  }

  /**
   * Loads and constructs the bus once. Does not call start().
   * @returns Promise that resolves to the constructed bus, or null if it didn't load.
   */
  private constructBus(): Promise<Bus | null> {
    this.busBuilt ??= this.buildBus();
    return this.busBuilt;
  }

  /**
   * Starts the constructed bus. Never rejects.
   * @returns Promise that resolves to the started bus, or null if it didn't load or start.
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

  /** Imports and constructs the bus. Never rejects. */
  private async buildBus(): Promise<Bus | null> {
    try {
      const { Bus } = await import("../bus/bus");

      // A shutdown can happen during the load, and a bus on a destroyed runtime leaks its links.
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
              // The first owner id keeps the startup records and the app's context, because
              // those records had no other identity. A later change retires them, even before
              // ready.
              if (this.ownerAdopted) {
                drainDeferred(this);
                this.drops.add("security_context", [
                  ...this.bootBuffer.take(),
                  ...this.pendingRecords.take(),
                  ...this.forwardBuffer,
                ]);
                this.forwardBuffer = [];
                this.context.clear();
                this.breadcrumbs.clear();
                // collect() removes the open measurements, and emit() refuses them during this
                // reset.
                const rotating = this.rotating;
                this.rotating = true;
                this.collectPoints();
                // The profiler holds on to its data while emit() refuses records. Don't let the
                // old owner's data reach the new owner.
                if (this.profilerOn) {
                  profilerCore().reset();
                }
                // A same-origin owner stores its new session before it sends the new id, so use
                // that session. Otherwise every frame starts a different session.
                const shared = this.sessionTouch.stored();
                this.resetSession(
                  shared !== undefined && shared !== this.identity.sessionId
                    ? shared
                    : newId(this.diagnostics),
                );
                this.rotating = rotating;
                this.advanceIdentity();
                // The old owner's rules must not apply to the new identity.
                this.remote.sampling = null;
                this.refreshCaptures();
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
   * Loads the delivery stack if this context is the sender and has a destination, that is an
   * endpoint or a custom transport.
   * @returns Promise that resolves when the load completes, or immediately when nothing loads.
   */
  private syncSender(): Promise<void> {
    if (!this.hasDestination() || this.role() !== "sender") {
      return Promise.resolve();
    }

    return this.loadSender();
  }

  /**
   * Checks whether the config names a destination for the records.
   * @returns True if it has an endpoint or a custom transport.
   */
  private hasDestination(): boolean {
    return Boolean(this.config.endpoint) || this.config.transport !== undefined;
  }

  /**
   * Starts the delivery stack load once.
   * @returns Promise that resolves when the load completes or fails.
   */
  private loadSender(): Promise<void> {
    this.senderLoad ??= this.buildSender();
    return this.senderLoad;
  }

  /**
   * Imports and builds the delivery stack, then moves the held records into it.
   * Never rejects.
   */
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
              drainDeferred(this);
              this.collectPoints();
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
      // Clear the load so a later configure() can try again.
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

  /** Refreshes temporary switches and restores local settings when their TTL ends. */
  private refreshCaptures(): void {
    clearTimeout(this.remoteCaptureTimer);
    this.remoteCaptureTimer = undefined;
    if (this.destroyed) {
      return;
    }

    const wire = this.remote.sampling?.wire();
    if (wire) {
      this.remoteCaptureTimer = setTimeout(() => {
        this.refreshCaptures();
      }, wire.ttlMs);
      unrefTimer(this.remoteCaptureTimer);
    }

    if (this.captureState(this.effectiveCapture()) !== this.installedCaptureKey) {
      void this.installCaptures();
    }
  }

  /**
   * Serializes the current capture settings and profiler observers into one string. When the
   * string changes, the captures are reinstalled.
   * @param settings Current capture settings.
   * @returns The string.
   */
  private captureState(settings: CaptureOptions): string {
    const { enabled, framePhases, framePacing } = this.config.profiler;

    return `${captureKey(settings)}${String(enabled && framePhases)}${String(enabled && framePacing)}${this.replayState(settings)}`;
  }

  /**
   * Serializes what the replay recorder reads when it starts. The replay capture has its own
   * key because a restart drops the buffer, so an unrelated capture change must not cause one.
   * The other replay values are read on use and apply without a restart.
   * @param settings Current capture settings.
   * @returns The string. Empty while replay is off, so a replay change then installs nothing.
   */
  private replayState(settings: CaptureOptions): string {
    const { replay } = this.config;

    if (!replay.enabled) {
      return "";
    }

    // Functions and recordOptions go in by identity: a function doesn't stringify, and the
    // app's recordOptions can have a cycle or a throwing getter. The endpoint and onSegment are
    // in, so a buffer never goes to a destination it wasn't recorded for. fullUrls and
    // ignoreUrls are in because the kept capture reads them from its install-time settings,
    // and a buffer recorded with full URLs must not survive the app turning them off.
    // replay.headers stays out, so a refreshed token doesn't drop the buffer.
    return JSON.stringify([
      replay.loader && pluginId(replay.loader),
      replay.onSegment && pluginId(replay.onSegment),
      pluginId(replay.recordOptions),
      replay.endpoint,
      replay.requireConsent,
      replay.mode,
      replay.maskText,
      replay.maskInputs,
      replay.maskSelectors,
      replay.blockSelectors,
      replay.recordCanvas,
      replay.bufferMs,
      replay.plugins.map(pluginId),
      settings.fullUrls,
      settings.ignoreUrls.map(String),
    ]);
  }

  /** Returns local capture settings with the permitted remote switches. */
  private effectiveCapture(): CaptureOptions {
    const settings = { ...this.config.capture };
    const remote = this.remote.sampling?.current()?.capture;
    for (const key of REMOTE_CAPTURE_FLAGS) {
      const value = remote?.[key];
      if (settings.remoteToggles.includes(key) && value !== undefined) {
        if (value && typeof settings[key] === "object") {
          continue;
        }
        settings[key] = value;
      }
    }

    return settings;
  }

  /** Loads, builds and installs the enabled capture modules. Never rejects. */
  private async installCaptures(): Promise<void> {
    // A console-only runtime next to another version patches nothing. The other version does.
    if (this.degraded) {
      return;
    }

    const generation = ++this.captureGeneration;
    const settings = this.effectiveCapture();
    this.installedCaptureKey = this.captureState(settings);
    const replayKey = this.replayState(settings);

    // The recorder reads the live config whenever it starts, and newSession() or startReplay()
    // can restart it at any time. So once any install has asked for different settings, the
    // running recorder may no longer match the key it was built with, and it is never kept.
    if (replayKey !== this.replayBuiltKey) {
      this.replayBuiltKey = "";
    }

    // A running recorder whose start settings didn't change stays as it is. Reinstalling it
    // would drop the buffer, and with it the "before" of the next error.
    const kept = replayKey !== "" && replayKey === this.replayBuiltKey ? this.replay : undefined;
    const names: CaptureName[] = [];
    const { profiler } = this.config;

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
    // An empty list wraps nothing, so don't load the chunk for it.
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

    if (settings.reports) {
      names.push("reports");
    }
    if (settings.resourceTiming) {
      names.push("resourceTiming");
    }
    if (settings.lifecycle) {
      names.push("lifecycle");
    }
    // The profiler's observers share one chunk, and it only loads with the profiler on.
    if (profiler.enabled && profiler.framePhases) {
      names.push("framePhases");
    }
    if (profiler.enabled && profiler.framePacing) {
      names.push("framePacing");
    }
    if (this.config.replay.enabled && !kept) {
      names.push("replay");
    }

    const [classes, WebSocketCapture] = await Promise.all([
      Promise.all(names.map((name) => this.loadCapture(name))),
      settings.webSocket ? this.loadWebSocket() : undefined,
    ]);

    // Guard against a later install or a shutdown during the load. A stale capture would
    // leak its listeners.
    if (generation !== this.captureGeneration || this.destroyed) {
      return;
    }

    // Swap the old set for the new one in one synchronous step, leaving no gap without capture.
    this.uninstallCaptures(kept);

    const ctx: CaptureContext = {
      isActive: () => !this.destroyed && !this.rotating,
      config: Object.assign(Object.create(this.config) as ResolvedConfig, { capture: settings }),
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
      onError: (hook) => {
        this.errorHook = hook;
      },
      setContext: (key, value) => {
        if (value === undefined) {
          this.context.remove(key);
        } else {
          this.context.set(key, value);
        }
      },
      replayConsent: () => this.replayConsent,
    };

    classes.forEach((CaptureModule, index) => {
      if (CaptureModule) {
        const capture = new CaptureModule(ctx);
        this.captures.push(capture);

        // Find the replay capture by its loader, not by its name. A plugin could use that name.
        if (names[index] === "replay") {
          this.replay = capture as ReplayControl;
          this.replayBuiltKey = replayKey;
        }
      }
    });

    const plugins = WebSocketCapture
      ? [...settings.plugins, new WebSocketCapture(this.diagnostics, ctx.config)]
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

  /**
   * Uninstalls the active capture modules.
   * @param kept A replay capture that stays installed, if there is one.
   */
  private uninstallCaptures(kept?: ReplayControl): void {
    for (const capture of this.captures) {
      if (capture !== kept) {
        this.diagnostics.guard(
          "capture.install_failed",
          `The library could not uninstall the ${capture.name} capture.`,
          () => {
            capture.uninstall();
          },
        );
      }
    }
    this.captures.length = 0;
    this.replay = kept;

    if (kept) {
      this.captures.push(kept);
    }
  }

  /**
   * Imports the WebSocket capture plugin. A failed import is reported and skipped.
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
   * Wraps a plugin as a capture module. The plugin only gets public tools.
   * @param plugin The app's plugin, or a built-in one.
   * @returns The capture module.
   */
  private pluginCapture(plugin: CapturePlugin): Capture {
    const { name } = plugin;
    const record: RecordMetric = (def, value, attributes) => {
      this.recordMetric(def, value, attributes);
    };
    const fault = (error: unknown): void => {
      this.diagnostics.report("config.invalid", INSTRUMENT_OPTIONS_FAULT, undefined, error);
    };
    const ctx: PluginContext = {
      logger: new OneLogger(() => this, `${CAPTURE_NAMESPACE}.${name}`),
      counter: (metric, options = {}) => makeCounter(metric, options, record, fault),
      histogram: (metric, options = {}) => makeHistogram(metric, options, record, fault),
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
   * Imports one capture module. A failed import is reported and skips only that module.
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

    // Attach on construction, because the worker's handshake can time out while the bus starts.
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

      // In bus.mode "off" startup didn't start the bus, so start it now.
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

    // The open interval's points and the root span go out with the final flush.
    drainDeferred(this);
    this.collectPoints();
    // After shutdown() probes stop reading the clock until the next configure().
    if (this.profilerOn) {
      this.profilerOn = false;
      profilerCore().detach();
    }
    this.tracing.end();
    this.destroyed = true;
    cancelDeferred(this);
    clearTimeout(this.remoteCaptureTimer);
    this.remoteCaptureTimer = undefined;

    if (!this.degraded) {
      removeEventListener("pagehide", this.onPageHide);
    }

    this.uninstallCaptures();

    // Sender.destroy awaits a normal flush, then runs the exit flush. The records already
    // hold their journey, so the journey and the bus can stop first.
    const closing = this.sender?.destroy();
    this.journey.destroy();
    // A record in the forward buffer waits for its microtask, so the bus takes it before it stops.
    this.sendForwarded();
    this.bus?.destroy();
    // The delivery stack didn't load before shutdown(), so the held records are lost.
    this.drops.add("load_failed", this.pendingRecords.take());
    await closing;
    // A load in progress destroys its own stack, and shutdown() resolves only after that.
    await this.senderLoad;
    await this.rotation?.catch(() => undefined);
    await this.memoryStorage?.close();

    // A local runtime must not remove the other version's runtime from the global key.
    if (ObservabilityRuntime.pinned() === this) {
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
    if (!record || this.destroyed || (this.rotating && !this.closingContext)) {
      return;
    }

    this.sessionTouch.touch(this.identity.sessionId);

    // An error first sends the records that minLevel or sampling dropped before it.
    const error = record.severityText === "ERROR" || record.severityText === "FATAL";
    const records = error ? [...this.debugBuffer.drain(), record] : [record];

    // Session replay uploads its buffer on an error. The hook has its own guard.
    if (error) {
      this.errorHook?.(record);
    }

    for (const one of records) {
      if (this.ready) {
        this.route(one);
      } else {
        this.bootBuffer.push(one);
      }
    }
  }

  /**
   * Sends a record to the forward buffer or to the local pipeline, depending on the bus role.
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

    // Console-only mode has no destination. Count the drop, otherwise no counter shows the loss.
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
   * Counts a record dropped by a full hold buffer and passes it to the onDrop report.
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

  /** Hands the forward buffer's records to the bus. */
  private sendForwarded(): void {
    const records = this.forwardBuffer;
    this.forwardBuffer = [];
    if (records.length > 0) {
      this.bus?.sendRecords(records);
    }
  }

  /**
   * Validates, samples and queues records from child frames or workers. A forwarded record
   * arrives already built, so this is the first point in this context where sampling can run.
   * Local records are sampled by RecordBuilder.
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
      // A debug buffer record explains an error. Sampling by its key would drop it again.
      if (
        record.attributes[ATTR_DEBUG_BUFFER] !== true &&
        !shouldSample(record, this.config, this.remote.sampling?.current() ?? null)
      ) {
        this.diagnostics.count("record.dropped_by_sampling");
        continue;
      }

      // A child context without redact forwards raw records, so the sender is the last gate.
      const redacted = this.builder.redactForwarded(record);
      if (redacted) {
        accepted.push(redacted);
      }
    }

    // Records that arrive while the context changes belong to neither identity. Report the
    // loss after sampling and redact, so onDrop never gets action names or journey ids that
    // redact masks.
    if (this.rotating) {
      this.drops.add("security_context", accepted);
      return;
    }

    for (const record of accepted) {
      this.deliver(record);
    }
  }

  /** Flushes the startup records, adding the active journey to records that have none. */
  private releaseBootBuffer(): void {
    const buffered = this.bootBuffer.take();
    // The hooks have already seen every record, so a key added now would bypass redact.
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
   * Passes lost records to the onDrop report.
   * @param reason Why they were lost.
   * @param records Lost records.
   * @param batchIds Ids of the lost batches.
   */
  private readonly reportLoss: LossReporter = (reason, records, batchIds, count) => {
    this.drops.add(reason, records, batchIds, count);
  };

  /**
   * Passes the evicted batches to the onDrop report and emits a warning record. The warning
   * records are throttled.
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

  /** Creates and stores a new tab ID after a tab ID collision. */
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
   * Starts a new session in this context. Sends the open metric points, starts a new trace,
   * ends the active journey and clears the breadcrumbs. Other tabs pick up the new id at
   * their next startup.
   */
  newSession(): void {
    if (this.destroyed) {
      return;
    }

    drainDeferred(this);
    this.resetSession(newId(this.diagnostics));
  }

  /**
   * Closes the old session's work and starts the given session.
   * @param sessionId Id of the session to start.
   */
  private resetSession(sessionId: string): void {
    // Close the old session's work first, so its points and root span keep the old id.
    this.collectPoints();
    this.tracing.rotate("explicit");
    this.journey.end();
    // On a shared machine, the next user must not see the previous user's trail.
    this.breadcrumbs.clear();
    this.debugBuffer.clear();
    // The replay buffer still shows the previous user's page. Drop it and start a new recording.
    this.replay?.reset();

    (this.identity as { sessionId: string }).sessionId = sessionId;
    this.sessionTouch.restart(sessionId);
    this.builder.invalidateResource();
  }

  /**
   * Changes the delivery context in one operation. A second call while this one is running is
   * rejected.
   * @param update New identity, delivery settings and context attributes.
   * @param options What to do with the old context's records, and the flush deadline.
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
    drainDeferred(this);
    this.rotating = true;
    this.rotation = this.rotateContext(update, pending, timeoutMs).finally(() => {
      this.rotating = false;
      this.rotation = undefined;
    });
    return this.rotation;
  }

  /**
   * Checks the new settings, stops the old delivery and starts the new context.
   * @param update New identity, delivery settings and attributes.
   * @param pending What to do with the old records.
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
    // Check the new settings before the old sender stops, so invalid settings keep the old sender.
    const delivery = { ...DELIVERY_RESET, ...update.delivery };
    const before = this.diagnostics.snapshot()["config.invalid"] ?? 0;
    // The base has no old delivery values, so an invalid new value can't fall back to an old one.
    const next = resolveConfig(
      this.allowed({ ...delivery, securityContext: { id: nextId } }),
      this.diagnostics,
      { ...this.config, ...DELIVERY_RESET },
    );
    if ((this.diagnostics.snapshot()["config.invalid"] ?? 0) !== before)
      throw new Error("Invalid delivery settings for the next security context.");
    // Copy the context now, so a throwing getter rejects before the old sender stops.
    const context = update.context ? Object.fromEntries(Object.entries(update.context)) : undefined;

    // The base above has no endpoints, so remove the old endpoints from the ignore list here.
    // If they stayed, network capture would ignore calls to the old destination.
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
      this.collectPoints();
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
    // Keep a lock change the app made during the rotation.
    next.lockConfiguration = this.config.lockConfiguration;
    // Replace all delivery settings together. Don't keep old credentials or signal endpoints.
    applyResolvedConfig(this.config, next);
    this.advanceIdentity();
    this.remote.sampling = null;
    this.refreshCaptures();
    this.context.clear();
    if (context) this.context.setMany(context);
    this.breadcrumbs.clear();
    this.newSession();
    this.builder.invalidateResource();
    await this.syncSender();
    this.bus?.rotateContext();
    // New calls go to the new sender from here, so a long carry drops no logger call and the
    // report below can produce a record.
    this.rotating = false;
    if (pending === "carry") {
      await this.carry(live, retired.stored);
    }
    this.diagnostics.report("security.rotated", "The runtime rotated its security context.", {
      pending,
    });
  }

  /**
   * Moves the old context's records into the new context.
   * @param live Records that were in memory. They go through the live buffer.
   * @param stored Batches that were stored. The new sender stores them again.
   * @returns Promise that resolves once the stored batches are stored again.
   */
  private async carry(live: LogRecord[], stored: LogBatch[]): Promise<void> {
    for (const record of live) {
      this.route(record);
    }

    // The live buffer doesn't take the stored backlog, which would exceed the buffer budget.
    // Without a new sender, the stored batches stay parked under the old id and nothing is lost.
    if (this.sender) {
      await this.sender.adopt(stored, this.config.securityContext.id);
    }
  }

  /**
   * Collects this runtime's state for a support ticket. The app decides where to send it.
   * @param health Health snapshot from the facade, with the logger cache counts.
   * @returns Promise that resolves to the JSON-safe bundle.
   */
  async debugBundle(health: ObservabilityHealth): Promise<DebugBundle> {
    const { configSummary } = await import("./debug-bundle");
    // Build the breadcrumbs as a record so the privacy hooks run, as they do for an error record.
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
   * Reads this runtime's state. Doesn't wait for startup or for the sender to load.
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
   * Reads this context's delivery state.
   * @returns Promise that resolves to the counts and the time of the last accepted send.
   */
  async stats(): Promise<DeliveryStats> {
    // queueDepth() waits for a loading delivery stack. By then the held records are in the
    // pipeline.
    const stored = await this.queueDepth();
    const delivery = this.sender?.stats() ?? { pending: 0, inFlight: 0, lastSendAt: null };
    const held = this.bootBuffer.length + this.pendingRecords.length + this.forwardBuffer.length;

    return { ...delivery, pending: delivery.pending + held, stored };
  }

  /**
   * Removes the stored records for one context, or for all contexts in the application
   * namespace.
   * @param scope Which part of storage to clear.
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
   * @returns Promise that resolves once the queued records are sent or handed off.
   */
  async flush(): Promise<void> {
    drainDeferred(this);
    this.collectPoints();

    // A record logged during startup waits in the boot buffer, and flush() would miss it
    // without this wait. After startup, don't wait, so the forward buffer handover stays
    // synchronous.
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
 * Compares resolved settings without JSON conversion. Functions are compared by identity.
 * The seen map keeps a cycle from causing repeated comparisons.
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

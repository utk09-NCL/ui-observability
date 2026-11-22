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
  BUS_PROTOCOL,
  CAPTURE_NAMESPACE,
  LIBRARY_LOG_PREFIX,
  REMOTE_CAPTURE_FLAGS,
  DIAGNOSTICS_NAMESPACE,
  FLUSH_REQUEST_SHARE,
  FLUSH_TIMEOUT_MAX_MS,
  FLUSH_TIMEOUT_MS,
  GAP_REPORT_THROTTLE_MS,
  METRIC_NAMESPACE,
  ROUTING_KEYS,
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
  SecurityContextUpdate,
  SecurityContextRotationOptions,
  ShutdownOptions,
  StorageScope,
} from "../models/config";
import type { LossReporter } from "../models/drop";
import type { InstrumentDef, Measure, MetricAttributes } from "../models/metric";
import type { CapturePlugin, PluginContext } from "../models/plugin";
import { isLogRecord, type LogRecord } from "../models/log-record";
import type { DebugBundle, FlushResult, FlushStatus, ObservabilityHealth } from "../models/health";
import type { PruneResult, StorageAdapter, StoragePersistence } from "../models/storage";
import type { StoreAccess } from "../storage/stored-context";
import { ConsoleSink } from "../utils/console";
import { hasOwn, isObject } from "../utils/guards";
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
import { runAsLibraryConsole } from "../utils/library-console";
import { runAsLibraryRequest } from "../utils/library-request";
import { detectPlatform, type PlatformMetadata, recordedUrl } from "../utils/platform";
import { sanitize, truncate } from "../utils/sanitize";
import { unrefTimer } from "../utils/unref";
import { Sequence } from "../utils/sequence";
import { TraceEngine } from "../utils/tracing";
import { type Breadcrumb, BreadcrumbBuffer } from "./breadcrumbs";
import { applyResolvedConfig, REFUSE_RECORDS, resolveConfig } from "./config";
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
import { LibraryLogger, OneLogger } from "./logger";
import { createMeasure } from "./measure";
import { makeCounter, makeHistogram, Meter, type RecordMetric } from "./meter";
import { profilerCore, type ProfilerSink } from "./profiler";
import { RecordBuilder } from "./record";
import type { RemoteSlot } from "./remote-sampling";
import type { RotationHost, rotateContext } from "./rotation";
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

/** Crumbs that log calls add. Before the start, they hold a body that no hook has seen. */
const LOGGED_CRUMBS: readonly string[] = ["log", "event", "action"];

/** Text of the warning and the report after a failed first configure() call. */
const FAILED_START =
  "configure() could not read its options. The library drops each record and installs no capture until a configure() call sets redact to a function or null.";

/** Text of the report for shutdown() options the library can't use. */
const SHUTDOWN_INVALID =
  'shutdown() got invalid options. The library discards the records in memory. An invalid clearStorage removes the "context" scope.';

/** Text of the report for flush() options the library can't use. */
const FLUSH_INVALID = "flush() got invalid options. The library waits the default 5000 ms.";

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
    // Only a loader's presence counts, so a new inline loader on each call reinstalls nothing.
    webVitals:
      typeof capture.webVitals === "object"
        ? { loader: capture.webVitals.loader !== undefined }
        : capture.webVitals,
    ignoreUrls: capture.ignoreUrls.map(String),
    propagateTraceHeaderTo: capture.propagateTraceHeaderTo.map(String),
    // A RegExp has no JSON form.
    userTiming:
      typeof capture.userTiming === "object"
        ? { include: capture.userTiming.include?.map(String) }
        : capture.userTiming,
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
 * Removes the routing settings from a configuration. A console-only runtime must not send
 * or join a bus, because the other version's runtime does both.
 * @param input Consumer configuration options.
 * @returns The options with no endpoint, no transport and bus mode "off".
 */
function consoleOnly(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig> {
  return {
    ...input,
    endpoint: null,
    metricsEndpoint: null,
    tracesEndpoint: null,
    transport: null,
    transportOnExit: null,
    transportWorker: null,
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
    Boolean(input.transport) ||
    Boolean(input.transportWorker)
  );
}

/**
 * Builds a flush result. The counts that aren't given are 0.
 * @param status How the call ended.
 * @param counts The counts to set.
 * @returns The result.
 */
function flushResult(
  status: FlushStatus,
  counts: Partial<Omit<FlushResult, "status">>,
): FlushResult {
  return { status, accepted: 0, stored: 0, dropped: 0, forwarded: 0, pending: 0, ...counts };
}

/**
 * Builds the result of a flush that ran. It's "timeout" while a record waits, so "timeout"
 * always has pending records.
 * @param counts The counts to set.
 * @returns The result.
 */
function settled(counts: Partial<Omit<FlushResult, "status">> & { pending: number }): FlushResult {
  return flushResult(counts.pending > 0 ? "timeout" : "complete", counts);
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
  /** Number of the latest rotateSecurityContext() call, so a queued call keeps `rotating` up. */
  private rotationSeq = 0;
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
  /** True while a rotation checks the next context's settings, so their records wait for it. */
  private holdingRecords = false;
  /** Diagnostics from that check. Their records go out when the new context opens. */
  private heldDiagnostics: DiagnosticEvent[] = [];
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
    if (typeof locked === "boolean") {
      this.config.lockConfiguration = locked;
    }
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

  /**
   * This runtime's bus protocol tag. A same-origin child frame reads it from the global key
   * before it opens a direct link, because a direct call has no envelope to carry the tag.
   */
  readonly protocol: string = BUS_PROTOCOL;

  /** Diagnostics reporter for internal faults. */
  readonly diagnostics: Diagnostics;

  /** Active configuration instance. A reconfigure changes it in place. */
  readonly config: ResolvedConfig;

  /** Detected host platform metadata. */
  readonly platform: PlatformMetadata;

  /** Identity context containing session, tab, and context identifiers. */
  readonly identity: Identity;

  /** Where the ids and the journey live. Memory until the start, so nothing touches storage. */
  private backing: IdentityStores = memoryStores();

  /** Stores for identity and journey keys. They read the backing on every call. */
  private readonly stores: IdentityStores = {
    local: () => this.backing.local(),
    session: () => this.backing.session(),
    opener: () => this.backing.opener?.() ?? null,
  };

  /** The identity strategy that the start uses. The app's startup call fixes it. */
  private identityBuiltAs: IdentityStrategy;

  /** Throttled writer of the session's last-seen timestamp. The start builds it again. */
  private sessionTouch: SessionTouch;

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

  /**
   * Delivery stack. Set in the sender role with an endpoint or a custom transport, once the
   * chunk has loaded.
   */
  private sender?: Sender;

  /** The delivery stack load. Undefined when nothing loads, so records have no destination. */
  private senderLoad?: Promise<void>;

  /** Records that arrive while the delivery stack loads, or while a pause holds them. */
  private readonly pendingRecords = new HoldBuffer((record) => {
    this.dropHeld(record);
  });

  /** Records that dropPaused() reported, so a second pagehide doesn't count them again. */
  private readonly pausedLoss = new WeakSet<LogRecord>();

  /** Stored batches that a carry during a pause left for the next sender to adopt. */
  private carried: LogBatch[] = [];

  /** True once resetSession() ran. start() then keeps that session over the stored one. */
  private sessionPicked = false;

  /**
   * True after a rotation fails. The app asked to leave the context, so the runtime sends no
   * record with its endpoint or headers until a rotation succeeds.
   */
  private deliveryClosed = false;

  /**
   * The stopped sender of the context that a failed rotation closed. The next rotation that
   * succeeds retires it with its own rule, so the old records don't stay or move by accident.
   */
  private parkedSender: Sender | undefined;

  /** The sender that a rotation retires. Its records wait for the rotation's rule. */
  private retiring: Sender | undefined;

  /**
   * True after the first configure() call failed. The runtime stays unconfigured and refuses
   * each record, because it can't know what the app needs to redact.
   */
  private startFailed = false;

  /**
   * True once the runtime has started: the first configure() call that works, with enabled true.
   * Before that, nothing is patched, stored or sent.
   */
  private running = false;

  /** Opens the start gate below. Its promise sets it, and start() calls it. */
  private openGate!: () => void;

  /** Resolves at the start. A frame or worker that registers before it joins the bus then. */
  private readonly startGate = new Promise<void>((resolve) => {
    this.openGate = resolve;
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

  /** The first shutdown. A later shutdown() waits for it before it removes the stored data. */
  private stopping?: Promise<void>;

  /** When the server last accepted a batch, in epoch milliseconds. A rotation keeps it. */
  private lastSendAt: number | null = null;

  /** When the last storage gap warning was reported, in epoch milliseconds. */
  private lastGapAt = 0;

  /** Record limits for the builder and the console. The app's first configure() sets them. */
  private readonly limits: ResolvedConfig["limits"];

  /** Lifetime rules for the journey engine. The app's first configure() sets the age. */
  private readonly journeyOptions: JourneyOptions;

  /**
   * False until the app's startup call, the first configure() call that works. That call sets
   * every startup-fixed setting, also after an early log call.
   */
  private tunablesLocked = false;

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
    this.dropPaused();
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
  private constructor(input: Partial<ObservabilityConfig>, mismatch: boolean) {
    // resolveConfig() checks the hook below. Until then, a value that isn't a function gets no
    // events, otherwise each report would call it and count a false handler.threw.
    this.diagnostics = new Diagnostics(
      typeof input.onDiagnostic === "function" ? input.onDiagnostic : undefined,
    );

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
    this.identity = resolveIdentity(
      this.diagnostics,
      this.stores,
      this.config.correlation.sessionIdleMs,
    );
    this.sessionTouch = new SessionTouch(
      this.diagnostics,
      this.stores,
      this.config.correlation.sessionIdleMs,
    );
    this.breadcrumbs = new BreadcrumbBuffer(this.config.captureLimits.breadcrumbs);
    // Sample a span by its trace, so the whole trace stays or goes.
    const keeps = (traceId: string): boolean =>
      sampleKey(traceId, this.config.sampling.defaultRate);
    this.tracing = new TraceEngine(
      this.diagnostics,
      this.config.correlation.traceMaxAgeMs ?? Infinity,
      this.config.otelLoader,
      {
        enabled: () => this.config.tracesEndpoint !== null,
        keeps,
        onEnd: (ended) => {
          if (keeps(ended.traceId)) {
            this.recordSpan(rootSpan(ended));
          }
        },
      },
    );
    // The startup values stick. A later configure() can't change the limits or the journey age.
    this.limits = { ...this.config.limits };
    this.console = new ConsoleSink(this.config.consoleOutput, this.diagnostics, this.limits);
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
      () => this.config.metrics.intervalMs,
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

    // The logger would drop this record with the rotation's other calls, but it's about the
    // next context, so endRotation() writes it there.
    if (this.holdingRecords) {
      this.heldDiagnostics.push(event);
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
   * Drops the held diagnostic records of a rotation that didn't open its context, and counts
   * each one as the logger counts a call during a rotation.
   */
  private dropHeldRecords(): void {
    const dropped = this.heldDiagnostics.length;
    this.heldDiagnostics = [];

    // A count of 0 would still add the counter, so a clean rotation would show a drop.
    if (dropped > 0) {
      this.diagnostics.count("record.dropped_during_rotation", dropped);
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
    if (this.rotating || this.destroyed) {
      return;
    }
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
    // A pause records nothing, as a log call does nothing.
    if (!this.destroyed && !this.rotating && this.config.enabled) {
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
    if (this.config.tracesEndpoint === null) {
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
    // A discard at shutdown drops the open interval, so don't build its points.
    if (this.destroyed) {
      return;
    }

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
    // A pause detaches the probes, so they read no clock until enabled is true again.
    const enabled = this.config.profiler.enabled && this.config.enabled;
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
      intervalMs: () => this.config.metrics.intervalMs,
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
   * spans, so a span from the old identity can't add to the new one. The old identity's remote
   * rules and capture switches don't apply to the new one.
   */
  private advanceIdentity(): void {
    this.identityEpoch++;
    if (this.profilerOn && this.config.securityContext.isolation) {
      profilerCore().reset();
    }
    this.remote.sampling = null;
    this.refreshCaptures();
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
   * @param implicit True for the unconfigured runtime that an early log call makes.
   * @returns Active runtime instance.
   */
  static configure(input: Partial<ObservabilityConfig>, implicit = false): ObservabilityRuntime {
    try {
      return ObservabilityRuntime.startOrUpdate(input, implicit);
    } catch (error) {
      const live = ObservabilityRuntime.current();
      // A getter in a later call threw before anything changed, so the current settings stay.
      if (live?.tunablesLocked) {
        live.diagnostics.report(
          "config.invalid",
          "configure() could not read its options. The library keeps the current settings.",
          undefined,
          error,
        );
        return live;
      }

      // An early log call's runtime takes the refusal too, otherwise its held records and a
      // later call without redact would go out unredacted.
      const runtime = live ?? ObservabilityRuntime.startOrUpdate({}, true);
      runtime.refuse(error);
      return runtime;
    }
  }

  /**
   * Fails closed after the app's first configure() call couldn't be read. The library can't
   * tell what the app must redact, so it refuses each record, the held ones too, until a call
   * sets redact itself. The runtime stays unconfigured, so it writes no id to storage.
   * @param error What reading the options threw.
   */
  private refuse(error: unknown): void {
    this.startFailed = true;
    // A quiet reporter, so the stand-in doesn't report the missing endpoint a second time.
    const next = resolveConfig({ redact: REFUSE_RECORDS }, new Diagnostics(), this.config);
    applyResolvedConfig(this.config, next);
    // The app's onDiagnostic may not exist yet, so the console gets the warning too.
    runAsLibraryConsole(() => {
      // eslint-disable-next-line no-console -- The only sink before an onDiagnostic exists.
      console.warn(`${LIBRARY_LOG_PREFIX} ${FAILED_START}`);
    });
    this.diagnostics.report("config.invalid", FAILED_START, undefined, error);
    // The stand-in drops each held record, as it drops every new one.
    this.rehookHeld();
  }

  /**
   * Starts a runtime, or updates the one that runs. A getter in the input can throw here.
   * @param input Consumer configuration options.
   * @param implicit True for the unconfigured runtime that an early log call makes.
   * @returns Active runtime instance.
   */
  private static startOrUpdate(
    input: Partial<ObservabilityConfig>,
    implicit: boolean,
  ): ObservabilityRuntime {
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
        return ObservabilityRuntime.startDegraded(input, pinned.sdkVersion, implicit);
      }

      if (!pinned.destroyed) {
        pinned.reconfigure(input);
        return pinned;
      }
    }

    const runtime = new ObservabilityRuntime(input, false);
    (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = runtime;
    Reflect.deleteProperty(globalThis, STOPPED_KEY);
    // An early log call's runtime waits for the app's configure().
    if (!implicit) {
      runtime.launch();
    }
    return runtime;
  }

  /**
   * Starts a console-only runtime next to another version's runtime. It sends nothing, joins
   * no bus and installs no capture. The other version keeps the page runtime.
   * @param input Consumer configuration options.
   * @param found The pinned runtime's sdkVersion. A runtime older than 0.9.0 has none.
   * @param implicit True for the unconfigured runtime that an early log call makes.
   * @returns The local runtime.
   */
  private static startDegraded(
    input: Partial<ObservabilityConfig>,
    found: unknown,
    implicit: boolean,
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

    if (!implicit) {
      runtime.launch();
    }
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
      if (!sameConfig(this.config, next)) {
        this.diagnostics.report(
          "config.locked",
          "Runtime configuration is locked. Use setConfigurationLocked(false) to unlock it explicitly.",
        );
      }
      return;
    }
    drainDeferred(this);
    const accepted = this.keepDestination(this.keepRouting(this.allowed(input)));
    // The app's startup call names its own id, so the id is explicit.
    if (!this.tunablesLocked && accepted.securityContext?.id) {
      this.explicitSecurityContext = true;
    }
    const next = resolveConfig(accepted, this.diagnostics, this.config);
    // Nothing reads these sections before the start, so the app's startup call can set them.
    const fixed = this.tunablesLocked ? (["correlation", "storage"] as const) : [];
    for (const key of fixed) {
      // Compare resolved values, so an undefined or invalid key isn't a change. Restore the
      // section in the next config, never in the app's own object.
      if (!sameConfig(next[key], this.config[key])) {
        this.diagnostics.report(
          "config.invalid",
          `${key} cannot change after startup. The library keeps the current settings.`,
        );
        Object.assign(next, { [key]: this.config[key] });
      }
    }
    this.keepStartupTunables(next);
    const { redact, processors, enabled } = this.config;
    // A pause sends the open interval first. Built now, those points go out after the pause.
    if (enabled && !next.enabled) {
      this.collectPoints();
    }
    applyResolvedConfig(this.config, next);
    // After a failed first call the library can't know which redact the app meant, so only a
    // call that sets redact itself, to a function or null, ends the refusal.
    if (this.config.redact !== REFUSE_RECORDS) {
      this.startFailed = false;
    }
    // A kept record only saw the hooks from its own log call. New hooks must not miss it.
    if (this.config.redact !== redact || this.config.processors !== processors) {
      this.debugBuffer.clear();
    }
    this.breadcrumbs.resize(this.config.captureLimits.breadcrumbs);
    this.diagnostics.setHandler(this.diagnosticHandler());
    this.diagnostics.setPolicy(
      this.config.diagnostics.throttleMs,
      this.config.diagnostics.consoleFallback,
    );

    this.builder.invalidateResource();
    this.console.update(this.config.consoleOutput);
    this.keepBuiltIdentity();
    // The handler and the resource are up to date now, and points and diagnostics use both.
    this.syncProfiler();
    this.launch();
    // A pause keeps the sender's records, so they go out once enabled is true again.
    if (this.running && enabled !== this.config.enabled) {
      this.sender?.hold(!this.config.enabled);
    }

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
   * Removes the routing settings from a console-only runtime's input. On a server, it
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
   * Removes routing and identity changes while isolation is on. The other settings still apply.
   * @param input Consumer configuration options.
   * @returns The options without the refused routing or identity changes.
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

    // An early log call starts a runtime with defaults. The app's startup call sets that
    // runtime's limits, journey age and bus role settings.
    if (!this.tunablesLocked) {
      Object.assign(this.limits, next.limits);
      this.journeyOptions.maxAgeMs = next.journey.maxAgeMs;
      return;
    }

    this.keepSections(next, ["limits"]);

    // The bus reads its role settings once, when it starts.
    for (const key of ["mode", "openFinRole"] as const) {
      if (next.bus[key] !== this.config.bus[key]) {
        this.diagnostics.report(
          "config.invalid",
          `bus.${key} cannot change after startup. The library keeps "${this.config.bus[key]}".`,
          { requested: next.bus[key] },
        );
        Object.assign(next.bus, { [key]: this.config.bus[key] });
      }
    }

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
    // The stack picks its transport once. A rotation can pick another one. undefined keeps the
    // current transport, so only a value or null can add or remove one.
    for (const key of ["transport", "transportWorker"] as const) {
      const value = input[key];
      // A value that isn't a function adds nothing, so resolveConfig() reports its type instead.
      const adds = typeof value === "function" && this.config[key] === undefined;
      const removes = value === null && this.config[key] !== undefined;
      if (adds || removes) {
        this.diagnostics.report(
          "config.invalid",
          `You cannot add or remove ${key} after the delivery stack loads. The current transport stays.`,
        );
        accepted = { ...accepted };
        Reflect.deleteProperty(accepted, key);
      }
    }

    // "" is the value for "not set", so it removes the endpoint too.
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
    // The stores switch at the start, so the app's startup call can still pick the strategy.
    if (!this.tunablesLocked) {
      this.identityBuiltAs = this.config.identity;
      return;
    }

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

  /**
   * Fixes the startup settings at the first configure() call that works, then starts the
   * runtime once enabled is true. A failed first call leaves the runtime unconfigured.
   */
  private launch(): void {
    if (this.startFailed) {
      return;
    }

    if (!this.tunablesLocked) {
      this.tunablesLocked = true;
      // These records never met the app's hooks, so they reach onDrop only after redact.
      if (!this.config.enabled) {
        this.drops.add("disabled", this.rehookHeld());
      }
    }

    if (!this.running && this.config.enabled) {
      this.start();
    }
  }

  /**
   * Starts the runtime: reads the configured ids, gives the held records the app's hooks and
   * resource, then installs the captures and starts the bus and the sender. Runs once.
   */
  private start(): void {
    this.running = true;
    // The ids lived in memory until now, so a page that never calls configure() stores nothing.
    if (this.identityBuiltAs === "storage" && !this.onServer()) {
      this.backing = BROWSER_STORES;
    }

    const { sessionIdleMs, traceMaxAgeMs } = this.config.correlation;
    const { sessionId, tabId } = resolveIdentity(this.diagnostics, this.stores, sessionIdleMs);
    this.sessionTouch = new SessionTouch(this.diagnostics, this.stores, sessionIdleMs);
    // A newSession() before the start chose a new session, so the stored one mustn't replace it.
    if (this.sessionPicked) {
      this.sessionTouch.restart(this.identity.sessionId);
    } else {
      this.identity.sessionId = sessionId;
    }
    this.identity.tabId = tabId;
    this.builder.invalidateResource();
    // A log call's crumb holds its raw body, because no hook existed yet. The app's own crumbs stay.
    this.breadcrumbs.retain((crumb) => !LOGGED_CRUMBS.includes(crumb.category));
    this.tracing.setup(traceMaxAgeMs ?? Infinity, this.config.otelLoader);
    // Don't await. Without OTel, records use the ambient trace and nothing is lost.
    void this.tracing.loadOtel();

    for (const record of this.rehookHeld()) {
      this.bootBuffer.push(record, this.config.buffering.maxHeldRecords);
    }

    this.openGate();
    void this.init();
  }

  /**
   * Takes the records that log calls held before the app's startup call, and runs the app's
   * hooks on them now.
   * @returns The records the hooks kept, with the configured resource.
   */
  private rehookHeld(): LogRecord[] {
    return this.bootBuffer
      .take()
      .map((record) => this.builder.rehook(record))
      .filter((record) => record !== null);
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
      // A frame or a worker can register before configure(), and the bus waits for the start.
      await this.startGate;
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
              }
              this.config.securityContext.id = id;
            }
            this.ownerAdopted = true;
            return true;
          },
          onRecords: (records) => {
            this.ingestForwarded(records);
          },
          paused: () => !this.config.enabled,
          onJourney: (journey) => {
            this.journey.applyRemote(journey);
          },
          onJourneyRequest: () => this.journey.current(),
          onTabConflict: () => {
            this.regenerateTabId();
          },
          onFlush: (timeoutMs) => this.flushFor(timeoutMs, false),
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
    // Nothing sends before the start or during a pause. A pause that ends calls this again. A
    // shutdown during startup loads nothing, so the held records reach onDrop and don't wait.
    const sends = this.running && this.config.enabled && !this.deliveryClosed && !this.destroyed;
    if (!sends || !this.hasDestination() || this.role() !== "sender") {
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
    try {
      const { Sender } = await import("./sender");
      const sender = this.destroyed
        ? null
        : await Sender.create({
            storage: this.memoryStorage,
            onStorage: (storage) => {
              if (storage.name === "memory") {
                this.memoryStorage = storage;
              }
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
            onSent: (at) => {
              this.lastSendAt = at;
            },
          });

      // Guard against a shutdown during the load. The stack must not outlive the runtime. Its
      // pipeline is empty, because the shutdown took the held records, so it sends nothing.
      if (!sender || this.destroyed) {
        await sender?.discard();
        return;
      }

      // A failed rotation closed the context during the load. This sender must not send the
      // old context's batches, so it stops and keeps them for the next rotation's rule.
      if (this.deliveryClosed) {
        await this.parkSender(sender);
        return;
      }

      this.sender = sender;
      // A pause that started during the load holds the new sender too.
      if (!this.config.enabled) {
        sender.hold(true);
      }
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

    // A carry during a pause left its stored batches for this sender. After a failed load they
    // stay parked, otherwise a later clearStorage can't find their ids under the old context.
    if (this.sender && this.carried.length > 0) {
      const carried = this.carried;
      this.carried = [];
      await this.adoptStored(this.sender, carried);
    }
  }

  /**
   * Stores an earlier context's batches under this context.
   * @param sender The sender that adopts them.
   * @param stored The earlier context's stored batches.
   */
  private async adoptStored(sender: Sender, stored: readonly LogBatch[]): Promise<void> {
    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not store the carried batches under the new context.",
      () => sender.adopt(stored, this.config.securityContext.id),
    );
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

    return `${String(this.config.enabled)}${captureKey(settings)}${String(enabled && framePhases)}${String(enabled && framePacing)}${this.replayState(settings)}`;
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
    // Nothing is patched before the start.
    if (this.degraded || !this.running) {
      return;
    }

    const generation = ++this.captureGeneration;
    const settings = this.effectiveCapture();
    this.installedCaptureKey = this.captureState(settings);

    // A pause removes every patch and the recorder, so the page runs as if the library weren't
    // there. The replay buffer goes with the recorder, and enabled true starts a new recording.
    if (!this.config.enabled) {
      this.uninstallCaptures();
      return;
    }
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
    const consoleOn =
      typeof settings.console === "object"
        ? settings.console.levels?.length !== 0
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
      logger: new LibraryLogger(() => this, CAPTURE_NAMESPACE),
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
        // undefined removes the key, so the replay id goes when the recorder stops.
        this.context.merge({ [key]: value ?? null });
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
      if (!bus || this.destroyed || cancelled) {
        return;
      }
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

  /**
   * Stops every subsystem and unpins the runtime. By default it flushes the records first. A
   * discard sends nothing, and a clearStorage scope also removes the stored batches and ids. A
   * later call stops nothing more, but its clearStorage scope still applies.
   * @param options What to do with the records that wait, and which storage to remove.
   */
  async destroy(options?: ShutdownOptions): Promise<void> {
    const { discard, scope } = this.shutdownRule(options);
    // The removal waits for the first call, otherwise a late save of its flush or of its exit
    // flush could land after it.
    this.stopping ??= this.stop(discard);
    await this.stopping;
    if (scope !== undefined) {
      await this.clearStorage(scope);
    }
  }

  /**
   * Stops every subsystem once, then unpins the runtime.
   * @param discard True to send nothing and report the records in memory as discarded.
   */
  private async stop(discard: boolean): Promise<void> {
    // A flush sends the open interval's points and the root span. A discard builds neither.
    if (!discard) {
      drainDeferred(this);
      this.collectPoints();
      this.tracing.end();
    }
    // After shutdown() probes stop reading the clock until the next configure(), and their
    // data goes with the detach.
    if (this.profilerOn) {
      this.profilerOn = false;
      profilerCore().detach();
    }
    this.destroyed = true;
    // A journey call on the stopped runtime then writes to memory only, as each call records
    // nothing until the next configure().
    this.backing = memoryStores();
    cancelDeferred(this);
    // emitPoint() builds nothing now, so this only stops the meter's timer after a discard.
    this.collectPoints();
    clearTimeout(this.remoteCaptureTimer);
    this.remoteCaptureTimer = undefined;

    if (!this.degraded) {
      removeEventListener("pagehide", this.onPageHide);
    }

    // The replay capture drops its buffer and its upload queue here.
    this.uninstallCaptures();
    const closing = discard ? this.discardHeld() : this.flushHeld();
    this.journey.destroy();
    this.bus?.destroy();
    await closing;
    // A load in progress stops its own stack, and shutdown() resolves only after that.
    await this.senderLoad;
    await this.rotation?.catch(() => undefined);
    // A parked sender keeps its records stored, and only its store needs to close.
    const parked = this.parkedSender;
    this.parkedSender = undefined;
    await this.diagnostics.guardAsync(
      "pipeline.crashed",
      "The delivery stack of the old context did not stop at shutdown. The library leaves its stored batches in storage.",
      async () => {
        await (discard
          ? parked?.discard()
          : parked?.retire("retain", 0, this.config.securityContext.id));
      },
    );
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
   * Reads the shutdown() options. A value it can't use reports config.invalid and discards,
   * because an app that asks to discard or to remove storage doesn't want a send.
   * @param options The app's options.
   * @returns True to discard, and the storage scope to remove.
   */
  private shutdownRule(options: unknown): { discard: boolean; scope?: StorageScope } {
    const read = this.readOptions(options, SHUTDOWN_INVALID);
    if (read === undefined) {
      return { discard: true };
    }

    const { pending, clearStorage } = read;
    // null turns the removal off, as null turns off other options.
    const unset = clearStorage === undefined || clearStorage === null;
    const knownScope = unset || clearStorage === "context" || clearStorage === "namespace";
    let scope: StorageScope | undefined;
    if (!unset) {
      // A value it can't use still removes the narrower scope, because the app asked for one.
      scope = clearStorage === "namespace" ? "namespace" : "context";
    }

    const flushes = pending === undefined || pending === "flush";
    // clearStorage always discards, so it can't honour an explicit "flush".
    if (!knownScope || !(flushes || pending === "discard") || (pending === "flush" && scope)) {
      this.diagnostics.report("config.invalid", SHUTDOWN_INVALID);
    }

    return { discard: !flushes || scope !== undefined, scope };
  }

  /** Flushes the sender's records and runs the exit flush. Reports what can't go out. */
  private async flushHeld(): Promise<void> {
    // The sender can load before startup ends, for example while OpenFin's getOptions() waits,
    // so its last flush takes the startup records. Before dropPaused(), so a pause counts them.
    if (this.sender) {
      this.releaseBootBuffer();
    }

    // A paused sender sends nothing at shutdown either.
    this.dropPaused();
    // Sender.destroy awaits a normal flush, then runs the exit flush. The records already hold
    // their journey, so the journey and the bus can stop first.
    const closing = this.sender?.destroy();
    // A record in the forward buffer waits for its microtask, so the bus takes it before it stops.
    this.sendForwarded();
    // A stopped runtime loads no sender, so the records that wait for startup or for the load are
    // lost. Startup releases its records later, where nothing reports them. A pause reported its own.
    const held = [...this.bootBuffer.take(), ...this.pendingRecords.take()];
    this.drops.add("load_failed", this.unreported(held));
    await closing;
  }

  /**
   * Drops the records in memory without a send and reports each one as "discarded". A record
   * in a request that is in flight isn't reported, because the request can still arrive.
   */
  private async discardHeld(): Promise<void> {
    const held = [...this.bootBuffer.take(), ...this.pendingRecords.take(), ...this.forwardBuffer];
    this.forwardBuffer = [];
    // The stopped runtime stays reachable until the next configure(), so the next user on a
    // shared device must not find the previous user's trail or attributes in it.
    this.breadcrumbs.clear();
    this.debugBuffer.clear();
    this.context.clear();
    // The stores are memory now, so this writes no browser store and tells no peer.
    this.journey.applyRemote(null);
    const buffered = (await this.sender?.discard()) ?? [];
    this.drops.add("discarded", this.unreported([...held, ...buffered]));
  }

  /**
   * Removes the stored batches, the emergency queue entries and the stored ids. Before the
   * first configure() call that works, no store is known, so it removes nothing.
   * @param scope Whose stored batches to remove.
   */
  private async clearStorage(scope: StorageScope): Promise<void> {
    if (!this.tunablesLocked) {
      return;
    }

    await this.diagnostics.guardAsync(
      "storage.degraded",
      "The library could not remove the stored batches at shutdown.",
      async () => {
        const { clearStored } = await import("../storage/stored-context");
        // A carry during a pause left its batches under an older context id. A first-call pause
        // hasn't switched to the browser stores yet, but an earlier page can have written the
        // ids there.
        const ids = this.carried.map((batch) => batch.id);
        this.carried = [];
        await clearStored(
          this.storeAccess(),
          scope,
          ids,
          this.identityBuiltAs === "storage" && !this.onServer(),
        );
      },
    );
  }

  /**
   * Routes a completed log record to the pipeline or forward buffer.
   * @param record Log record to emit, or null when the build dropped it.
   */
  emit(record: LogRecord | null): void {
    if (!record || this.destroyed) {
      return;
    }

    // A record built during a rotation belongs to neither context.
    if (this.rotating && !this.closingContext) {
      this.drops.add("security_context", [record]);
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
        this.bootBuffer.push(one, this.config.buffering.maxHeldRecords);
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
    if (this.deliveryClosed) {
      this.drops.add("security_context", [record]);
      return;
    }

    if (this.sender) {
      this.sender.push(record);
      return;
    }

    // Console-only mode has no destination. Count the drop, otherwise no counter shows the loss.
    // A pause loads no sender, so it holds the record until enabled: true loads one.
    const paused = !this.config.enabled && this.hasDestination();
    if (!this.senderLoad && !paused) {
      this.diagnostics.count("record.dropped_no_destination");
      // After a failed load, the config has a destination but no delivery stack.
      if (this.hasDestination()) {
        this.drops.add("load_failed", [record]);
      }
      return;
    }

    this.pendingRecords.push(record, this.config.buffering.maxHeldRecords);
  }

  /**
   * Reports the sender's records in memory as lost during a pause. A pause has no exit flush,
   * so a pagehide or a shutdown leaves nothing to send them.
   */
  private dropPaused(): void {
    if (this.config.enabled) {
      return;
    }

    // The records stay, and a page back from the back/forward cache sends them, so count once.
    const fresh = this.unreported([
      ...this.pendingRecords.records,
      ...(this.sender?.records() ?? []),
    ]);
    for (const record of fresh) {
      this.pausedLoss.add(record);
    }
    this.drops.add("disabled", fresh);
  }

  /**
   * Leaves out the records that a pause already reported, so onDrop counts each loss once.
   * @param records Lost records.
   * @returns The records with no report yet.
   */
  private unreported(records: readonly LogRecord[]): LogRecord[] {
    return records.filter((record) => !this.pausedLoss.has(record));
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

  /**
   * Hands the forward buffer's records to the bus.
   * @returns How many records went upstream.
   */
  private sendForwarded(): number {
    const records = this.forwardBuffer;
    this.forwardBuffer = [];
    // An empty buffer makes no message. A forwarder always has a bus.
    const { bus } = this;
    if (records.length === 0 || !bus) {
      return 0;
    }

    return bus.sendRecords(records);
  }

  /**
   * Validates, samples and queues records from child frames or workers. A forwarded record
   * arrives already built, so this is the first point in this context where sampling can run.
   * Local records are sampled by RecordBuilder.
   * @param records Inbound payload from bus.
   */
  private ingestForwarded(records: unknown): void {
    if (this.destroyed) {
      return;
    }
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

    // The bus stays connected during a pause, but the sender sends nothing.
    if (!this.config.enabled) {
      this.drops.add("disabled", accepted);
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
    // Otherwise the bus's next claim and hello carry the old id, and the clash starts again.
    this.bus?.setTabId(fresh);
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
    this.sessionPicked = true;
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
   * Changes the delivery context in one operation. Rotations run in call order, so a logout
   * that starts during a login still runs, after the login.
   * @param update New identity, routing settings and context attributes.
   * @param options What to do with the old context's records, and the flush deadline.
   * @returns Promise that resolves when the change completes. Invalid settings reject it.
   */
  rotateSecurityContext(
    update: SecurityContextUpdate,
    options: SecurityContextRotationOptions = {},
  ): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error("The runtime has stopped."));
    }
    // Before a configure() call works, there's no context to leave and no routing to replace.
    if (!this.tunablesLocked) {
      return Promise.reject(
        new Error(
          "The runtime is not configured. Call configure() before rotateSecurityContext().",
        ),
      );
    }

    // A record from this call on belongs to neither context, so it's dropped from here.
    drainDeferred(this);
    this.rotating = true;
    const seq = ++this.rotationSeq;
    // Check the promise, not the flag. "carry" clears the flag before it stores old batches again.
    const run = (this.rotation ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.runRotation(update, options, seq));
    this.rotation = run;
    const settle = (): void => {
      if (this.rotation === run) {
        this.rotation = undefined;
        this.rotating = false;
        this.retiring = undefined;
      }
    };
    run.then(settle, settle);
    return run;
  }

  /**
   * Runs one rotation once the earlier ones are done. The rotation code loads on the first call.
   * @param update New identity, routing settings and context attributes.
   * @param options What to do with the old context's records, and the flush deadline.
   * @param seq Number of this call.
   * @returns Promise that resolves when the change completes.
   */
  private async runRotation(
    update: SecurityContextUpdate,
    options: SecurityContextRotationOptions,
    seq: number,
  ): Promise<void> {
    if (this.destroyed) {
      throw new Error("The runtime has stopped.");
    }

    // A forwarder sends through its owner, so this is a usage error and its delivery stays open.
    await this.started;
    if (this.role() === "forwarder") {
      throw new Error(
        "Rotate the security context on the upstream owner, or use bus.mode: sender for an independent identity.",
      );
    }

    let rotate: typeof rotateContext;
    try {
      rotate = (await import("./rotation")).rotateContext;
    } catch (error) {
      // The app asked to leave this context, so a rotation that can't run closes it.
      this.diagnostics.report(
        "pipeline.crashed",
        "The library could not load the security-context rotation.",
        undefined,
        error,
      );
      await this.closeDelivery();
      throw error;
    }

    // shutdown() ran during the load, so a rotation now would delete stored batches unreported.
    if (this.isDestroyed()) {
      throw new Error("The runtime has stopped.");
    }

    try {
      await rotate(this.rotationHost(), update, options, seq);
    } finally {
      // endRotation() takes the held records once the new context opens, so only a failed
      // rotation leaves any here. Dropping them keeps them out of a later rotation's context.
      this.dropHeldRecords();
    }
  }

  /**
   * Returns the changes the rotation code can make to this runtime's private state.
   * @returns The rotation host.
   */
  private rotationHost(): RotationHost {
    return {
      runtime: this,
      quiet: new Diagnostics(),
      senderLoaded: async () => {
        await this.senderLoad;
      },
      holdRecords: (plan) => {
        this.holdingRecords = true;
        try {
          return plan();
        } finally {
          this.holdingRecords = false;
        }
      },
      allowed: (input) => this.allowed(input),
      closeDelivery: () => this.closeDelivery(),
      closeContext: () => {
        // The old context's last points and root span still go to its own sender.
        this.closingContext = true;
        try {
          this.collectPoints();
          this.tracing.end();
          this.journey.end();
        } finally {
          this.closingContext = false;
        }
      },
      takeOld: () => {
        const held = [
          ...this.bootBuffer.take(),
          ...this.pendingRecords.take(),
          ...this.forwardBuffer,
        ];
        const sender = this.sender ?? this.parkedSender;
        // A flush during the retire still sees these records, so it doesn't call them lost.
        this.retiring = sender;
        const carried = this.carried;
        this.forwardBuffer = [];
        this.carried = [];
        this.sender = undefined;
        this.senderLoad = undefined;
        this.parkedSender = undefined;
        return { held, sender, closed: this.deliveryClosed, carried };
      },
      drop: (records) => {
        this.drops.add("security_context", this.unreported(records));
      },
      storeAccess: () => this.storeAccess(),
      advanceIdentity: () => {
        this.advanceIdentity();
      },
      openDelivery: async () => {
        this.deliveryClosed = false;
        await this.syncSender();
        this.bus?.rotateContext();
      },
      endRotation: (seq) => {
        // A queued rotation keeps the flag up, because a later record belongs to its context.
        this.rotating = seq !== this.rotationSeq;

        // The queued rotation replaces this context, so the held records have nowhere to go.
        if (this.rotating) {
          this.dropHeldRecords();
          return;
        }

        const held = this.heldDiagnostics;
        this.heldDiagnostics = [];
        for (const event of held) {
          this.recordDiagnostic(event);
        }
      },
      route: (record) => {
        this.route(record);
      },
      adopt: async (stored) => {
        // A pause loads no sender, so the next sender adopts them. With no destination, they
        // stay parked under the old id, so none is lost. A stopped runtime has no sender, and a
        // clearStorage shutdown removes the parked ids.
        if (!this.config.enabled || this.destroyed) {
          this.carried = [...stored];
          return;
        }
        await this.sender?.adopt(stored, this.config.securityContext.id);
      },
    };
  }

  /**
   * Stops delivery after a rotation fails. The app asked to leave this context, so its endpoint
   * and headers send no record until a rotation succeeds. The old records stay stored under
   * the old id, and the next rotation that succeeds applies its rule to them.
   */
  private async closeDelivery(): Promise<void> {
    this.deliveryClosed = true;
    this.diagnostics.report(
      "security.rotation_failed",
      "The security-context rotation failed. The library sends no record until a rotation succeeds.",
    );

    // A load in progress sees the closed flag and parks its own sender.
    await this.senderLoad;
    const old = this.sender;
    this.sender = undefined;
    this.senderLoad = undefined;
    if (old) {
      await this.parkSender(old);
    }

    // These records arrived during the rotation, so they belong to the context the app left.
    this.drops.add("security_context", this.unreported(this.pendingRecords.take()));
  }

  /**
   * Stops a sender of a closed context and keeps it, so the next rotation that succeeds can
   * apply its rule to the records of that context.
   * @param sender The sender to stop.
   */
  private async parkSender(sender: Sender): Promise<void> {
    this.parkedSender = sender;

    await this.diagnostics.guardAsync(
      "pipeline.crashed",
      "The delivery stack of the old context did not stop. The next rotation that succeeds retires it.",
      () => sender.pause(this.config.securityContext.id),
    );
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
    const sent = this.sender?.stats();
    const issues: ObservabilityHealth["issues"] = [];
    if (this.mismatchVersion) {
      issues.push("runtime.version_mismatch");
    }
    if (this.contextMismatch) {
      issues.push("security.context_mismatch");
    }
    const { redact, processors } = this.config;
    if (redact === REFUSE_RECORDS || processors.includes(REFUSE_RECORDS)) {
      issues.push("records.refused");
    }
    if (this.deliveryClosed) {
      issues.push("security.rotation_failed");
    } else if (
      // A pause loads no sender, and that isn't a fault.
      this.ready &&
      this.config.enabled &&
      this.hasDestination() &&
      this.role() === "sender" &&
      !this.sender
    ) {
      issues.push("sender.unavailable");
    }
    const { sourcePolicy, maxMessageBytes, maxRecordsPerMessage, maxMessagesPerSecond } =
      this.config.bus;
    return {
      delivery: {
        pending: (sent?.pending ?? 0) + this.heldRecords(),
        inFlight: sent?.inFlight ?? 0,
        stored: await this.storedBatches(),
        lastSendAt: this.lastSendAt,
        // A rotation builds a new sender, so these start again with it.
        lastFailureAt: sent?.lastFailureAt ?? null,
        consecutiveFailures: sent?.consecutiveFailures ?? 0,
        throttledUntil: sent?.throttledUntil ?? null,
        dropped: this.drops.counts(),
      },
      sdkVersion: this.sdkVersion,
      owningSdkVersion: this.mismatchVersion,
      status: this.destroyed
        ? "stopped"
        : !this.tunablesLocked
          ? "unconfigured"
          : !this.config.enabled
            ? "disabled"
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
      senderReady:
        this.sender !== undefined &&
        this.config.enabled &&
        !this.destroyed &&
        !this.rotating &&
        !this.deliveryClosed,
      configurationLocked: this.config.lockConfiguration,
      issues,
      securityContext: { ...this.config.securityContext },
      storagePersistence: this.storagePersistence,
      bus: { sourcePolicy, maxMessageBytes, maxRecordsPerMessage, maxMessagesPerSecond },
    };
  }

  /**
   * Returns what opening the store needs when no sender runs.
   * @returns The config, the reporter and the kept memory store.
   */
  private storeAccess(): StoreAccess {
    return { config: this.config, diagnostics: this.diagnostics, memory: this.memoryStorage };
  }

  /**
   * Counts the stored batches. After a failed rotation, the parked sender's store still holds
   * the closed context's batches, and they count until a rotation retires them.
   * @returns Promise that resolves to the number of stored batches.
   */
  private async storedBatches(): Promise<number> {
    return (await (this.sender ?? this.parkedSender)?.queueDepth()) ?? 0;
  }

  /**
   * Sends the records in memory and waits until each one has a final state or the time limit
   * passes. A forwarder hands its records to its sender, then asks the sender to flush.
   * @param options How long to wait. A value it can't use reports config.invalid.
   * @returns Promise that resolves to what became of the records in memory at the call. It
   * never rejects.
   */
  flush(options?: unknown): Promise<FlushResult> {
    return this.flushFor(this.flushTimeout(options), true);
  }

  /**
   * Runs a flush with a time limit that is already in range.
   * @param timeoutMs How long to wait, in milliseconds.
   * @param collect True to send the open interval of the meter and the profiler first. A flush
   * that a child asks for doesn't, otherwise each request would make this context build points.
   * @returns Promise that resolves to the flush result.
   */
  private async flushFor(timeoutMs: number, collect: boolean): Promise<FlushResult> {
    drainDeferred(this);
    if (collect) {
      this.collectPoints();
    }

    const idle = this.idle();
    if (idle) {
      return idle;
    }

    const ends = Date.now() + timeoutMs;
    let stop!: () => void;
    const expired = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      unrefTimer(timer);
      stop = () => {
        clearTimeout(timer);
      };
    });

    try {
      return await this.flushBefore(ends, expired);
    } finally {
      stop();
    }
  }

  /**
   * Waits for startup and the delivery stack, then flushes the sender or asks the upstream one.
   * @param ends Epoch time in milliseconds of the deadline.
   * @param expired Resolves at the deadline.
   * @returns The flush result.
   */
  private async flushBefore(ends: number, expired: Promise<void>): Promise<FlushResult> {
    // These records wait for startup or for the sender, and they're lost if no sender loads.
    const held = this.heldRecords();

    // A record waits in a hold buffer during startup, which loads the first sender, and while a
    // later configure() loads one. The flush would miss it without this wait. Otherwise don't
    // wait, so the snapshot and the forward buffer handover happen in the call itself.
    const loading = this.ready ? this.senderLoad : this.started;
    if (loading && (!this.ready || !this.sender)) {
      const loaded = await Promise.race([loading.then(() => true), expired.then(() => false)]);
      if (!loaded) {
        return settled({ pending: this.waiting() });
      }
    }

    const { bus } = this;
    const forwarder = bus?.getRole() === "forwarder";

    // A pause or a shutdown during the wait leaves nothing to send.
    const idle = this.idle();
    if (idle) {
      return idle;
    }

    if (forwarder) {
      // The records go before the request on the same link, so they're in the sender's snapshot.
      // A record that the bus doesn't send, for its size or for no owner, is lost here.
      const total = this.forwardBuffer.length;
      const forwarded = this.sendForwarded();
      const lost = total - forwarded;
      // The sender gets a share of the time left, so its answer arrives before this call ends.
      const share = Math.floor(Math.max(0, ends - Date.now()) * FLUSH_REQUEST_SHARE);
      const answer = await bus.requestFlush(share, expired);
      return answer
        ? { ...answer, forwarded, dropped: answer.dropped + lost }
        : settled({ forwarded, pending: forwarded, dropped: lost });
    }

    const { sender } = this;
    if (!sender) {
      // During a rotation the old records wait for its rule. Without a sender, they're lost.
      return this.rotating
        ? settled({ pending: held + this.waiting() })
        : flushResult("complete", { dropped: held });
    }

    return settled(await sender.flushUntil(expired));
  }

  /**
   * Returns the result for a runtime that sends nothing now: before the start, after a failed
   * first configure(), during a pause and after shutdown().
   * @returns The "inactive" result with the records that wait in memory, or null.
   */
  private idle(): FlushResult | null {
    if (this.tunablesLocked && this.config.enabled && !this.destroyed) {
      return null;
    }

    // A stopped runtime sends nothing more, so no record waits for it.
    return flushResult("inactive", { pending: this.destroyed ? 0 : this.waiting() });
  }

  /**
   * Counts the records in the hold buffers and the forward buffer.
   * @returns The record count.
   */
  private heldRecords(): number {
    return this.bootBuffer.length + this.pendingRecords.length + this.forwardBuffer.length;
  }

  /**
   * Counts the records in memory: the hold buffers, the forward buffer, and the buffers, the
   * queue and the requests of the sender and of a sender that a rotation retires.
   * @returns The record count.
   */
  private waiting(): number {
    let total = this.heldRecords();
    for (const sender of [this.sender, this.retiring]) {
      const sent = sender?.stats();
      total += sent ? sent.pending + sent.inFlight : 0;
    }
    return total;
  }

  /**
   * Copies a call's options. A value that isn't an object reports config.invalid with the text,
   * and so does a getter that throws.
   * @param options The app's options. undefined and null read as no options.
   * @param text The text of the report.
   * @returns The copy, or undefined after a report.
   */
  private readOptions(options: unknown, text: string): Record<string, unknown> | undefined {
    // A JavaScript caller can pass a string, or an object with a getter that throws.
    if (typeof options !== "object" && options !== undefined) {
      this.diagnostics.report("config.invalid", text);
      return undefined;
    }

    return this.diagnostics.guard("config.invalid", text, () => ({ ...options }));
  }

  /**
   * Reads flush()'s time limit. A value it can't use reports config.invalid, and the default
   * applies. null options and a null timeoutMs give the default, as in shutdown() and
   * rotateSecurityContext().
   * @param options The app's options.
   * @returns The time limit in milliseconds.
   */
  private flushTimeout(options: unknown): number {
    const read = this.readOptions(options, FLUSH_INVALID);
    if (!read) {
      return FLUSH_TIMEOUT_MS;
    }

    const ms = read.timeoutMs ?? FLUSH_TIMEOUT_MS;
    if (typeof ms === "number" && ms >= 0 && ms <= FLUSH_TIMEOUT_MAX_MS) {
      return ms;
    }

    this.diagnostics.report("config.invalid", FLUSH_INVALID);
    return FLUSH_TIMEOUT_MS;
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
  if (Object.is(a, b)) {
    return true;
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return String(a) === String(b);
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (seen.has(a)) {
    return seen.get(a) === b;
  }
  seen.set(a, b);
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every((key) => hasOwn(b, key) && sameConfig(Reflect.get(a, key), Reflect.get(b, key), seen))
  );
}

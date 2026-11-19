// src/index.ts
//
// The library's public entry point. Exports the facade API, the logging primitives and
// the types.

import type { WorkerLike } from "./bus/links";
import type { Journey } from "./core/journey";
import { INSTRUMENT_OPTIONS_FAULT } from "./constants";
import { OneLogger, type OneLogger as Logger, type OneLoggerOptions } from "./core/logger";
import { measureCall } from "./core/measure";
import { makeCounter, makeGauge, makeHistogram } from "./core/meter";
import { profilerCore } from "./core/profiler";
import { ObservabilityRuntime } from "./core/runtime";
import { isObject } from "./utils/guards";
import type { ObservabilityConfig } from "./models/config";
export type {
  ReplayLoader,
  ReplayPluginLoader,
  ReplayPluginTools,
  ReplaySegment,
} from "./models/replay";
import type {
  FlushOptions,
  SecurityContextUpdate,
  SecurityContextRotationOptions,
  ShutdownOptions,
} from "./models/config";
import type { DebugBundle, FlushResult, ObservabilityHealth } from "./models/health";
import type { FrameOptions, SourceOptions } from "./models/bus";
export type { FrameOptions, SourceOptions, BusPermission } from "./models/bus";
import type {
  Counter,
  Gauge,
  Histogram,
  HistogramOptions,
  InstrumentOptions,
  Measure,
  MetricAttributes,
  Profiler,
} from "./models/metric";

export { serveTransportWorker } from "./transport/worker-entry";
export { createMemoryTransport, type MemoryTransport } from "./transport/memory-transport";
export type { Journey, Logger, ObservabilityConfig, OneLoggerOptions };
export type {
  BatchingOptions,
  BufferingOptions,
  BusOptions,
  CaptureLimitsOptions,
  CaptureOptions,
  ConsoleCaptureOptions,
  ConsoleOutputOptions,
  ConsoleStyles,
  CorrelationOptions,
  DebugBufferOptions,
  DeliveryOptions,
  DiagnosticsOptions,
  FlushOptions,
  InteractionOptions,
  JourneyOptions,
  LimitsOptions,
  LoggerCacheOptions,
  LongFramesOptions,
  MetadataOptions,
  MetricsOptions,
  ProfilerOptions,
  RemoteCaptureFlag,
  ReplayOptions,
  ResourceTimingOptions,
  RetentionOptions,
  RoutingOptions,
  SamplingOptions,
  SecurityContextOptions,
  SecurityContextRotationOptions,
  SecurityContextUpdate,
  ShutdownOptions,
  StorageOptions,
  StorageScope,
  UserTimingOptions,
  WebVitalsOptions,
  ExitTransport,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./models/config";
export type {
  DebugBundle,
  DeliveryHealth,
  FlushResult,
  FlushStatus,
  ObservabilityHealth,
} from "./models/health";
export type { WorkerLike } from "./bus/links";
export type { DiagnosticCode, DiagnosticEvent } from "./core/diagnostics";
export type { DropSummary, LossReason } from "./models/drop";
export type { LogLevel, LogRecord, LogType, MetricType } from "./models/log-record";
export type {
  Counter,
  Gauge,
  Histogram,
  HistogramOptions,
  InstrumentOptions,
  Measure,
  MetricAttributes,
  Probe,
  ProbeOptions,
  Profiler,
} from "./models/metric";
export type { CapturePlugin, PluginContext } from "./models/plugin";
export type { LogSerializer, SerializedBatch } from "./models/serializer";
export type { StorageAdapter } from "./models/storage";

/**
 * Cached loggers, keyed by namespace. A scoped logger never goes in this map.
 * A logger looks up the runtime on every write, so the cache stays valid across
 * configure() and shutdown().
 */
const loggers = new Map<string, Logger>();

/**
 * Returns the active runtime. After shutdown() that is the stopped runtime, which does
 * nothing. Before the first configure(), it makes an unconfigured runtime, which holds records
 * in memory and starts nothing until a configure() call works.
 * @returns Runtime instance.
 */
function requireRuntime(): ObservabilityRuntime {
  const runtime = ObservabilityRuntime.current() ?? ObservabilityRuntime.stopped();
  if (runtime) {
    return runtime;
  }

  // Make the unconfigured runtime, so a log call before configure() doesn't throw.
  return ObservabilityRuntime.configure({}, true);
}

/**
 * Initializes or reconfigures the observability runtime. The first call that works starts the
 * runtime. Before it, the library patches, stores and sends nothing, and the records logged
 * before it go out with its hooks and identity. With `enabled: false`, the start waits for the
 * first `enabled: true`.
 * With `payloadMode: "defer"`, logger records are built in idle time. With the debug buffer on,
 * they are still built at the call.
 * @param config Consumer configuration options.
 */
export function configure(config: Partial<ObservabilityConfig>): void {
  ObservabilityRuntime.configure(config);
  trimLoggerCache();
}

/**
 * Locks or unlocks the configuration. The lock isn't access control against other code on
 * this origin. Call it after configure(), because a lock before the first configure() refuses
 * that call too, and the runtime then never starts.
 * @param locked True to refuse changes through configure().
 */
export function setConfigurationLocked(locked: boolean): void {
  requireRuntime().setConfigurationLocked(locked);
}

/**
 * Stops delivery for the old context and starts it for the new one. A call during another
 * rotation runs after it.
 * @param update New identity, routing settings and context attributes.
 * @param options What to do with old records, and the flush deadline.
 * @returns Promise that resolves once the change is complete. It rejects before the first
 * configure() call that works, and while a failed first call still refuses records.
 */
export function rotateSecurityContext(
  update: SecurityContextUpdate,
  options?: SecurityContextRotationOptions,
): Promise<void> {
  return requireRuntime().rotateSecurityContext(update, options);
}

/**
 * Reads this SDK copy's runtime state, policies and delivery state. The `delivery` block holds
 * the record and batch counts, the send and failure times, the throttle end and the losses. It
 * doesn't wait for startup or for the delivery stack to load.
 * @returns Promise that resolves to the current state.
 */
export async function getHealth(): Promise<ObservabilityHealth> {
  const runtime = requireRuntime();
  trimLoggerCache();
  return {
    ...(await runtime.health()),
    loggerCache: { ...runtime.config.loggerCache, size: loggers.size },
  };
}

/**
 * Collects the library's state for a support ticket. The bundle holds the health, the
 * diagnostic counters, the resource, the breadcrumbs, the debug buffer and a config summary.
 * The summary has no headers and no URL query, and a plugin or custom serializer shows up by
 * name only. The breadcrumbs go through the privacy hooks. A debug buffer record keeps its
 * context attributes. Where the bundle gets sent is up to the app.
 * @returns Promise that resolves to a JSON-safe bundle.
 */
export async function collectDebugBundle(): Promise<DebugBundle> {
  const health = await getHealth();
  return requireRuntime().debugBundle(health);
}

/**
 * Removes the least recently used loggers until the cache is within its limit.
 * @returns Cache limit, or null for no limit.
 */
function trimLoggerCache(): number | null {
  const limit = (ObservabilityRuntime.current() ?? ObservabilityRuntime.stopped())?.config
    .loggerCache.maxEntries;
  const max = limit === undefined ? 256 : limit;
  if (max !== null) {
    // A Map keeps insertion order, so the first keys are the least recently used loggers.
    for (const key of loggers.keys()) {
      if (loggers.size <= max) {
        break;
      }
      loggers.delete(key);
    }
  }
  return max;
}

/**
 * Returns the cached logger for a namespace, or a new scoped logger.
 * @param namespace Application subsystem or module namespace.
 * @param options Context attributes for this logger only.
 * @returns Logger for the namespace. You get a new logger if you pass options or the cache
 * is disabled.
 */
export function getLogger(namespace: string, options?: OneLoggerOptions): Logger {
  const max = trimLoggerCache();
  if (options || max === 0) return new OneLogger(requireRuntime, namespace, options);

  let logger = loggers.get(namespace);

  logger ??= new OneLogger(requireRuntime, namespace);

  // Move a cached logger to the end, so the first entry is always the least recently used.
  loggers.delete(namespace);
  loggers.set(namespace, logger);
  trimLoggerCache();

  return logger;
}

/**
 * Returns the default root logger.
 * @returns The logger for the "app" namespace.
 */
function root(): Logger {
  return getLogger("app");
}

/**
 * Logs a trace-level debug record.
 * @param message Detail message.
 * @param payload Optional context attributes.
 */
export function trace(message: string, payload?: Record<string, unknown>): void {
  root().trace(message, payload);
}

/**
 * Logs a debug-level record.
 * @param message Detail message.
 * @param payload Optional context attributes.
 */
export function debug(message: string, payload?: Record<string, unknown>): void {
  root().debug(message, payload);
}

/**
 * Logs an informational record.
 * @param message Informational message.
 * @param payload Optional context attributes.
 */
export function info(message: string, payload?: Record<string, unknown>): void {
  root().info(message, payload);
}

/**
 * Logs a warning record.
 * @param message Warning message.
 * @param payload Optional context attributes.
 */
export function warn(message: string, payload?: Record<string, unknown>): void {
  root().warn(message, payload);
}

/**
 * Logs an error record, with the error that caused it and the breadcrumbs.
 * @param message Error summary.
 * @param err The caught error or reason.
 * @param payload Optional context attributes.
 */
export function error(message: string, err?: unknown, payload?: Record<string, unknown>): void {
  root().error(message, err, payload);
}

/**
 * Logs a fatal record, with the error that caused it and the breadcrumbs.
 * @param message Fatal error summary.
 * @param err The caught error or reason.
 * @param payload Optional context attributes.
 */
export function fatal(message: string, err?: unknown, payload?: Record<string, unknown>): void {
  root().fatal(message, err, payload);
}

/**
 * Logs a single user action.
 * @param name Action identifier.
 * @param payload Optional action attributes.
 */
export function logAction(name: string, payload?: Record<string, unknown>): void {
  root().logAction(name, payload);
}

/**
 * Logs an application lifecycle or domain event.
 * @param name Event identifier.
 * @param payload Optional event attributes.
 */
export function logEvent(name: string, payload?: Record<string, unknown>): void {
  root().logEvent(name, payload);
}

/**
 * Reports instrument options the library couldn't read. Without a runtime there is nowhere to
 * report to, so it does nothing.
 * @param error What reading the options threw.
 */
function optionsFault(error: unknown): void {
  ObservabilityRuntime.current()?.diagnostics.report(
    "config.invalid",
    INSTRUMENT_OPTIONS_FAULT,
    undefined,
    error,
  );
}

/**
 * Returns a counter. Values are summed in memory, and every interval the library sends one
 * point per attribute set. A handle stays valid across configure() and shutdown().
 * @param name Metric name.
 * @param options Unit of the values.
 * @returns The counter.
 */
export function counter(name: string, options: InstrumentOptions = {}): Counter {
  return makeCounter(
    name,
    options,
    (def, value, attributes) => {
      requireRuntime().recordMetric(def, value, attributes);
    },
    optionsFault,
  );
}

/**
 * Returns a gauge. It keeps the last value for each attribute set in memory, and every interval
 * the library sends that value as one point. With `metricsEndpoint`, the point is an OTLP gauge.
 * A handle stays valid across configure() and shutdown().
 * @param name Metric name.
 * @param options Unit of the values.
 * @returns The gauge.
 */
export function gauge(name: string, options: InstrumentOptions = {}): Gauge {
  return makeGauge(
    name,
    options,
    (def, value, attributes) => {
      requireRuntime().recordMetric(def, value, attributes);
    },
    optionsFault,
  );
}

/**
 * Returns a histogram. Values are counted into buckets in memory, and every interval the
 * library sends one point per attribute set. A handle stays valid across configure() and
 * shutdown().
 * @param name Metric name.
 * @param options Unit of the values and the bucket boundaries.
 * @returns The histogram.
 */
export function histogram(name: string, options: HistogramOptions = {}): Histogram {
  return makeHistogram(
    name,
    options,
    (def, value, attributes) => {
      requireRuntime().recordMetric(def, value, attributes);
    },
    optionsFault,
  );
}

/**
 * Times an operation with named phases. Every phase and the total go into duration histograms.
 * With `tracesEndpoint` set, the operation is also a span with one child span per phase.
 * @param name Operation name. Every name creates one series.
 * @param attributes Attribute set for every histogram point. Keep it small.
 * @returns The operation's handle.
 */
export function startMeasure(name: string, attributes?: MetricAttributes): Measure {
  return requireRuntime().startMeasure(name, attributes);
}

/**
 * Times a function call with a measure, as `startMeasure()` does. If the result has a `then`
 * function, the measure ends when it settles. A throw or a rejection ends it with the outcome
 * "error", and the error goes to the caller unchanged.
 * @param name Operation name. Every name creates one series.
 * @param fn The function to call.
 * @param attributes Attribute set for every histogram point. Keep it small.
 * @returns Whatever `fn` returned, or the result of its `then` call.
 */
export function measure<T>(name: string, fn: () => T, attributes?: MetricAttributes): T {
  const runtime = requireRuntime();
  return measureCall(runtime.startMeasure(name, attributes), fn, runtime.diagnostics);
}

/**
 * Starts the session replay recorder. With `replay.requireConsent` set, nothing is recorded
 * until you call this, so call it once the user agrees. Does nothing while `replay.enabled`
 * is false.
 */
export function startReplay(): void {
  requireRuntime().setReplay(true);
}

/**
 * Stops the session replay recorder and drops any replay events that haven't been sent. With
 * `replay.requireConsent` set, the recorder stays off until the next `startReplay()`.
 */
export function stopReplay(): void {
  requireRuntime().setReplay(false);
}

/**
 * Times spans of app code with probes. A probe is a named handle with `begin()`, `end()`,
 * `endAfterPaint()` and `record()`, and `time()` times a single function call. Once per
 * interval the library sends one `ui.profile.duration` histogram for every probe that has data.
 *
 * The profiler is off by default. Set `profiler.enabled` to true to turn it on. While it is
 * off, probes don't read the clock. After `shutdown()` a probe does nothing until a later
 * `configure()` turns the profiler back on. Probes stay valid across `configure()` and
 * `shutdown()`, and you can create them before `configure()`. No call ever throws.
 * @example
 * const render = profiler.probe("grid.render");
 * const token = render.begin();
 * drawGrid();
 * render.end(token);
 */
export const profiler: Profiler = {
  // Probe calls report to whichever runtime is current. Once shutdown() resolves, the stopped
  // runtime gets nothing.
  probe: (name, options) =>
    profilerCore().probe(name, options, ObservabilityRuntime.current()?.diagnostics),
  time: (name, fn) => profilerCore().time(name, fn, ObservabilityRuntime.current()?.diagnostics),
};

/**
 * Adds a breadcrumb to the trail. The next error record carries the trail.
 * @param message Description of the event.
 * @param data Optional metadata. It is copied right away.
 */
export function addBreadcrumb(message: string, data?: Record<string, unknown>): void {
  requireRuntime().addBreadcrumb(message, data);
}

/**
 * Merges attributes into the ambient context. Every later record includes them. A null value
 * removes its key, and an undefined value keeps the current value. A value that isn't an object
 * reports `config.invalid` and changes nothing.
 * @param values Attributes to merge.
 */
export function setContext(values: Record<string, unknown>): void {
  const runtime = requireRuntime();
  // A string would give one attribute for each character.
  if (!isObject(values)) {
    runtime.diagnostics.report(
      "config.invalid",
      "setContext() takes an object. The library keeps the current context.",
    );
    return;
  }

  // A getter or a Proxy trap on the app's object can throw, and the call must not.
  runtime.diagnostics.guard(
    "record.sanitize_failed",
    "The library could not read the values of setContext().",
    () => {
      runtime.context.merge(values);
    },
  );
}

/**
 * Removes an attribute from the ambient context.
 * @param key Attribute key to delete.
 */
export function removeContext(key: string): void {
  requireRuntime().context.remove(key);
}

/**
 * Starts a new journey correlation context.
 * @param name Journey workflow identifier.
 * @param options `parent` links the active journey as the parent. `id` sets the journey id, a
 * string of 1 to 64 letters, digits, "_", ".", ":" or "-". Without it, the library generates one.
 * @returns The started Journey.
 */
export function startJourney(name: string, options?: { parent?: boolean; id?: string }): Journey {
  return requireRuntime().journey.start(name, options);
}

/** Ends the active journey correlation context. */
export function endJourney(): void {
  requireRuntime().journey.end();
}

/**
 * Returns the active journey, or null if none is in progress.
 * @returns The active Journey, or null.
 */
export function currentJourney(): Journey | null {
  return requireRuntime().journey.current();
}

/**
 * Serializes the active journey's metadata into a URL token that another context can adopt.
 * @returns The token, or null if no journey is active or the token is above the size limit.
 */
export function getJourneyToken(): string | null {
  return requireRuntime().journey.getToken();
}

/**
 * Adopts a serialized journey token in this application realm.
 * @param token Serialized journey token.
 * @returns True if the token is valid and the runtime adopted it.
 */
export function adoptJourney(token: string): boolean {
  return requireRuntime().journey.adopt(token, "manual", true);
}

/**
 * Connects a Web Worker or MessagePort to the document bus, so its records get routed.
 * @param worker The Worker or MessagePort to connect.
 * @param options The worker's permissions. Defaults to "records".
 * @returns Function that removes this registration.
 */
export function registerWorker(worker: WorkerLike, options?: SourceOptions): () => void {
  return requireRuntime().registerWorker(worker, options);
}

/**
 * Registers one frame or window at an exact origin.
 * @param frame Child frame or window to register.
 * @param options Expected origin and source permissions.
 * @returns Function that removes this registration.
 */
export function registerFrame(
  frame: HTMLIFrameElement | Window,
  options: FrameOptions,
): () => void {
  return requireRuntime().registerFrame(frame, options);
}

/** Starts a new distributed trace. Later records and requests carry the new trace id. */
export function newTrace(): void {
  requireRuntime().tracing.rotate("explicit");
}

/**
 * Returns the W3C traceparent headers to put on an outgoing HTTP request.
 * @returns Map of trace header names to values.
 */
export function getTraceHeaders(): Record<string, string> {
  return requireRuntime().tracing.headers();
}

/**
 * Builds any deferred calls and the open metric interval, sends the records in memory, and
 * waits until each one has a final state or the time limit passes. The snapshot is the records
 * in memory at the call. A record logged later isn't in it. Before startup ends, the call waits
 * for startup and the delivery stack first, and the snapshot then also holds the records logged
 * during that wait. A forwarder hands its records to its sender and asks the sender to flush.
 * At the limit the call returns, and the work goes on in the background. The stored batches
 * from earlier failures and the replay segments are outside the snapshot. Before the first
 * `configure()` call that works, during a pause and after `shutdown()`, it sends nothing and
 * returns the status "inactive" at once.
 * @param options How long to wait. `timeoutMs` is 0 to 600000 ms, and the default is 5000.
 * @returns Promise that resolves to the counts of the snapshot's records. It never rejects.
 */
export function flush(options?: FlushOptions): Promise<FlushResult> {
  return requireRuntime().flush(options);
}

/**
 * Starts a new correlation in this tab. Ends the active journey and starts a new trace. Other
 * tabs pick up the new id at their next startup. For a logout or a tenant change, use
 * rotateSecurityContext().
 */
export function newSession(): void {
  requireRuntime().newSession();
}

/**
 * Returns a snapshot of the cumulative diagnostic event counts.
 * @returns Map of diagnostic codes to how often each one occurred.
 */
export function getDiagnosticCounters(): Record<string, number> {
  return requireRuntime().diagnostics.snapshot();
}

/**
 * Stops every runtime subsystem. By default it flushes the records first, then runs the exit
 * flush, and a request still open after that is cancelled with its stored batch kept. With
 * `pending: "discard"` it sends nothing and reports each record in memory to `onDrop` with the
 * reason "discarded". `clearStorage` also removes the stored batches and the stored ids, for a
 * logout on a shared device. A call before any log call or `configure()` does nothing. A call
 * after `shutdown()` stops nothing more, but its `clearStorage` still removes the stored data,
 * once the first call ends. The next `configure()` starts a new runtime.
 * @param options What to do with the records that wait, and which storage to remove.
 * @returns Promise that resolves once shutdown is complete.
 */
export async function shutdown(options?: ShutdownOptions): Promise<void> {
  await (ObservabilityRuntime.current() ?? ObservabilityRuntime.stopped())?.destroy(options);
}

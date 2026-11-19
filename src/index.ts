// src/index.ts
//
// The library's public entry point. Exports the facade API, the logging primitives and
// the types.

import type { WorkerLike } from "./bus/links";
import type { Journey } from "./core/journey";
import { INSTRUMENT_OPTIONS_FAULT } from "./constants";
import { OneLogger, type OneLoggerOptions } from "./core/logger";
import { makeCounter, makeHistogram } from "./core/meter";
import { profilerCore } from "./core/profiler";
import { ObservabilityRuntime } from "./core/runtime";
import type { ObservabilityConfig } from "./models/config";
export type {
  ReplayLoader,
  ReplayPluginLoader,
  ReplayPluginTools,
  ReplaySegment,
} from "./models/replay";
import type { SecurityContextUpdate, SecurityContextRotationOptions } from "./models/config";
import type { DebugBundle, ObservabilityHealth } from "./models/health";
import type { FrameOptions, SourceOptions } from "./models/bus";
export type { FrameOptions, SourceOptions, BusPermission } from "./models/bus";
import type { MetricType } from "./models/log-record";
import type { DeliveryStats } from "./models/stats";
import type {
  Counter,
  Histogram,
  HistogramOptions,
  InstrumentOptions,
  Measure,
  MetricAttributes,
  Profiler,
} from "./models/metric";

export { OneLogger };
export { serveTransportWorker } from "./transport/worker-entry";
export { createMemoryTransport, type MemoryTransport } from "./transport/memory-transport";
export type { Journey, ObservabilityConfig, OneLoggerOptions };
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
  StorageOptions,
  UserTimingOptions,
  WebVitalsOptions,
  ExitTransport,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./models/config";
export type { DebugBundle, ObservabilityHealth } from "./models/health";
export type { WorkerLike } from "./bus/links";
export type { DiagnosticCode, DiagnosticEvent } from "./core/diagnostics";
export type { DropSummary, LossReason } from "./models/drop";
export type { LogLevel, LogRecord, LogType, MetricType } from "./models/log-record";
export type {
  Counter,
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
export type { DeliveryStats } from "./models/stats";
export type { StorageAdapter } from "./models/storage";

/**
 * Cached loggers, keyed by namespace. A scoped logger never goes in this map.
 * A logger looks up the runtime on every write, so the cache stays valid across
 * configure() and shutdown().
 */
const loggers = new Map<string, OneLogger>();

/**
 * Returns the active runtime. After shutdown() that is the stopped runtime, which does
 * nothing. Before the first configure(), it starts a runtime with default settings.
 * @returns Runtime instance.
 */
function requireRuntime(): ObservabilityRuntime {
  const runtime = ObservabilityRuntime.current() ?? ObservabilityRuntime.stopped();
  if (runtime) {
    return runtime;
  }

  // Start a default runtime, so a log call before configure() doesn't throw.
  return ObservabilityRuntime.configure({}, true);
}

/**
 * Removes stored logs. Records and requests that are still pending can write to storage again
 * afterwards.
 * @param scope Whose stored records to remove: the context's or the namespace's.
 * @returns Promise that resolves once the logs are removed.
 */
export function clearPersistedLogs(scope: "context" | "namespace" = "context"): Promise<void> {
  if (!["context", "namespace"].includes(scope))
    return Promise.reject(new Error("Invalid persistence scope."));
  return requireRuntime().clearPersisted(scope);
}

/**
 * Initializes or reconfigures the observability runtime.
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
 * this origin.
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
 * @returns Promise that resolves once the change is complete.
 */
export function rotateSecurityContext(
  update: SecurityContextUpdate,
  options?: SecurityContextRotationOptions,
): Promise<void> {
  return requireRuntime().rotateSecurityContext(update, options);
}

/**
 * Reads this SDK copy's runtime state, delivery counts and policies.
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
export function getLogger(namespace: string, options?: OneLoggerOptions): OneLogger {
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
 * @returns The OneLogger for the "app" namespace.
 */
function root(): OneLogger {
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
 * Logs a numeric metric measurement.
 * @param name Metric identifier.
 * @param value Measured value.
 * @param unit Unit of measurement.
 * @param type Metric type.
 * @param attributes Optional metric attributes.
 */
export function logMetric(
  name: string,
  value: number,
  unit?: string,
  type?: MetricType,
  attributes?: Record<string, unknown>,
): void {
  root().logMetric(name, value, unit, type, attributes);
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
 * Times a synchronous function and logs a duration metric.
 * @param label Metric name prefix.
 * @param fn Synchronous function to time.
 * @param attributes Optional context attributes.
 * @returns Whatever the timed function returns.
 */
export function timeSync<T>(label: string, fn: () => T, attributes?: Record<string, unknown>): T {
  return root().timeSync(label, fn, attributes);
}

/**
 * Times an asynchronous function and logs a duration metric.
 * @param label Metric name prefix.
 * @param fn Asynchronous function to time.
 * @param attributes Optional context attributes.
 * @returns Promise that resolves to the timed function's result.
 */
export function timeAsync<T>(
  label: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return root().timeAsync(label, fn, attributes);
}

/**
 * Adds a breadcrumb to the trail. The next error record carries the trail.
 * @param message Description of the event.
 * @param data Optional metadata. It is copied right away.
 */
export function addBreadcrumb(message: string, data?: Record<string, unknown>): void {
  requireRuntime().addBreadcrumb(message, data);
}

/**
 * Sets a key-value pair on the ambient context. Every later record includes it.
 * @param key Attribute key.
 * @param value Attribute value.
 */
export function setContext(key: string, value: unknown): void {
  requireRuntime().context.set(key, value);
}

/**
 * Merges several key-value pairs into the ambient context.
 * @param values Key-value map of attributes to add.
 */
export function setContextMap(values: Record<string, unknown>): void {
  requireRuntime().context.setMany(values);
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
 * @returns The token, or undefined if no journey is active.
 */
export function getJourneyToken(): string | undefined {
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

/** Rotates the trace context to begin a new distributed trace. */
export function startTrace(): void {
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
 * Builds any deferred calls and flushes the pending batches of every pipeline stream.
 * @returns Promise that resolves once the pipeline has processed the queued batches.
 */
export function flush(): Promise<void> {
  return requireRuntime().flush();
}

/**
 * Counts the batches waiting in storage for delivery.
 * @returns Promise that resolves to the number of stored batches. A forwarder doesn't store
 * batches, so it reports 0.
 */
export function getQueueDepth(): Promise<number> {
  return requireRuntime().queueDepth();
}

/**
 * Reads this context's delivery state.
 * @returns Promise that resolves to the records waiting, the records in requests, the batches
 * in storage and the time of the last accepted send. A forwarder reports only its own buffers.
 */
export function getStats(): Promise<DeliveryStats> {
  return requireRuntime().stats();
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
 * Flushes pending records and stops every runtime subsystem. A request still open after the
 * final flush is cancelled, and its stored batch stays in storage.
 * @returns Promise that resolves once shutdown is complete.
 */
export async function shutdown(): Promise<void> {
  await ObservabilityRuntime.current()?.destroy();
}

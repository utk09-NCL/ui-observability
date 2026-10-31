// src/index.ts
//
// This file is the public entry point of the library. It exports the facade API,
// logging primitives, and types.

import type { WorkerLike } from "./bus/links";
import type { Journey } from "./core/journey";
import { OneLogger, type OneLoggerOptions } from "./core/logger";
import { makeCounter, makeHistogram } from "./core/meter";
import { ObservabilityRuntime } from "./core/runtime";
import type { ObservabilityConfig } from "./models/config";
import type { MetricType } from "./models/log-record";
import type { DeliveryStats } from "./models/stats";
import type { Counter, Histogram, HistogramOptions, InstrumentOptions } from "./models/metric";

export { OneLogger };
export { createMemoryTransport, type MemoryTransport } from "./transport/memory-transport";
export type { Journey, ObservabilityConfig, OneLoggerOptions };
export type {
  ConsoleOptions,
  ConsoleStyles,
  ExitTransport,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./models/config";
export type { WorkerLike } from "./bus/links";
export type { DiagnosticCode, DiagnosticEvent } from "./core/diagnostics";
export type { DropSummary, LossReason } from "./models/drop";
export type { LogLevel, LogRecord, LogType, MetricType } from "./models/log-record";
export type {
  Counter,
  Histogram,
  HistogramOptions,
  InstrumentOptions,
  MetricAttributes,
} from "./models/metric";
export type { CapturePlugin, PluginContext } from "./models/plugin";
export type { LogSerializer, SerializedBatch } from "./models/serializer";
export type { DeliveryStats } from "./models/stats";
export type { StorageAdapter } from "./models/storage";

/**
 * Cached logger instances keyed by namespace. This map never holds a scoped logger.
 * A logger finds the runtime on each write.
 * The cache stays valid across configure() and shutdown().
 */
const loggers = new Map<string, OneLogger>();

/**
 * Retrieves the active runtime. After shutdown(), it returns the stopped runtime.
 * The stopped runtime does nothing. Before the first configure(), it starts a runtime
 * with default settings.
 * @returns Runtime instance.
 */
function requireRuntime(): ObservabilityRuntime {
  const runtime = ObservabilityRuntime.current() ?? ObservabilityRuntime.stopped();
  if (runtime) {
    return runtime;
  }

  // Start a default runtime. A log call before configure() then does not throw.
  return ObservabilityRuntime.configure({}, true);
}

/**
 * Initializes or reconfigures the observability runtime instance.
 * @param config Consumer configuration options.
 */
export function configure(config: Partial<ObservabilityConfig>): void {
  ObservabilityRuntime.configure(config);
}

/**
 * Retrieves a cached logger for a namespace, or builds an uncached scoped logger.
 * @param namespace Application subsystem or module namespace.
 * @param options Scoped context merged into records emitted by this logger.
 * @returns Cached OneLogger instance, or a new one when the call gives options.
 */
export function getLogger(namespace: string, options?: OneLoggerOptions): OneLogger {
  // Do not cache a scoped logger. The cache keeps its scopedContext for the life of the document.
  if (options) {
    return new OneLogger(requireRuntime, namespace, options);
  }

  let logger = loggers.get(namespace);

  if (!logger) {
    logger = new OneLogger(requireRuntime, namespace);
    loggers.set(namespace, logger);
  }

  return logger;
}

/**
 * Retrieves the default root logger instance.
 * @returns Root OneLogger instance for the "app" namespace.
 */
function root(): OneLogger {
  return getLogger("app");
}

/**
 * Logs a trace-level debug record.
 * @param message Detail message.
 * @param payload Optional contextual attributes.
 */
export function trace(message: string, payload?: Record<string, unknown>): void {
  root().trace(message, payload);
}

/**
 * Logs a debug-level record.
 * @param message Detail message.
 * @param payload Optional contextual attributes.
 */
export function debug(message: string, payload?: Record<string, unknown>): void {
  root().debug(message, payload);
}

/**
 * Logs an informational record.
 * @param message Informational message.
 * @param payload Optional contextual attributes.
 */
export function info(message: string, payload?: Record<string, unknown>): void {
  root().info(message, payload);
}

/**
 * Logs a warning record.
 * @param message Warning message.
 * @param payload Optional contextual attributes.
 */
export function warn(message: string, payload?: Record<string, unknown>): void {
  root().warn(message, payload);
}

/**
 * Logs an error record with causal error and breadcrumbs.
 * @param message Error summary.
 * @param err Caught error instance or reason.
 * @param payload Optional contextual attributes.
 */
export function error(message: string, err?: unknown, payload?: Record<string, unknown>): void {
  root().error(message, err, payload);
}

/**
 * Logs a fatal record with causal error and breadcrumbs.
 * @param message Fatal error summary.
 * @param err Caught error instance or reason.
 * @param payload Optional contextual attributes.
 */
export function fatal(message: string, err?: unknown, payload?: Record<string, unknown>): void {
  root().fatal(message, err, payload);
}

/**
 * Logs a discrete user interaction action.
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
 * Logs a numerical metric measurement.
 * @param name Metric identifier.
 * @param value Measured value.
 * @param unit Unit of measurement.
 * @param type Metric type classification.
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
 * Gives a counter. The library sums its values in memory. It sends one point for each attribute
 * set at each interval. A handle stays valid across configure() and shutdown().
 * @param name Metric name.
 * @param options Unit of the values.
 * @returns The counter.
 */
export function counter(name: string, options: InstrumentOptions = {}): Counter {
  return makeCounter(name, options, (def, value, attributes) => {
    requireRuntime().recordMetric(def, value, attributes);
  });
}

/**
 * Gives a histogram. The library counts its values in buckets in memory. It sends one point for
 * each attribute set at each interval. A handle stays valid across configure() and shutdown().
 * @param name Metric name.
 * @param options Unit of the values and the bucket boundaries.
 * @returns The histogram.
 */
export function histogram(name: string, options: HistogramOptions = {}): Histogram {
  return makeHistogram(name, options, (def, value, attributes) => {
    requireRuntime().recordMetric(def, value, attributes);
  });
}

/**
 * Measures the execution time of a synchronous function and logs a duration metric.
 * @param label Metric name prefix.
 * @param fn Synchronous function to time.
 * @param attributes Optional contextual attributes.
 * @returns Result returned by the timed function.
 */
export function timeSync<T>(label: string, fn: () => T, attributes?: Record<string, unknown>): T {
  return root().timeSync(label, fn, attributes);
}

/**
 * Measures the execution time of an asynchronous function and logs a duration metric.
 * @param label Metric name prefix.
 * @param fn Asynchronous function to time.
 * @param attributes Optional contextual attributes.
 * @returns Promise that resolves to the result of the timed function.
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
 * @param data Optional metadata. The library copies it now.
 */
export function addBreadcrumb(message: string, data?: Record<string, unknown>): void {
  requireRuntime().addBreadcrumb(message, data);
}

/**
 * Sets a key-value pair on the ambient context. All later records include it.
 * @param key Attribute key.
 * @param value Attribute value.
 */
export function setContext(key: string, value: unknown): void {
  requireRuntime().context.set(key, value);
}

/**
 * Merges multiple key-value pairs into the ambient context.
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
 * string of 1 to 64 characters. Without it, the library makes an id.
 * @returns Started Journey instance.
 */
export function startJourney(name: string, options?: { parent?: boolean; id?: string }): Journey {
  return requireRuntime().journey.start(name, options);
}

/** Terminates the active journey correlation context. */
export function endJourney(): void {
  requireRuntime().journey.end();
}

/**
 * Returns the currently active journey, or null if none is in progress.
 * @returns Active Journey instance or null.
 */
export function currentJourney(): Journey | null {
  return requireRuntime().journey.current();
}

/**
 * Serializes active journey metadata into a cross-context URL token.
 * @returns Serialized token string, or undefined if no journey is active.
 */
export function getJourneyToken(): string | undefined {
  return requireRuntime().journey.getToken();
}

/**
 * Adopts a serialized journey token into this application realm.
 * @param token Serialized journey token.
 * @returns True if the token is valid and the runtime adopts it.
 */
export function adoptJourney(token: string): boolean {
  return requireRuntime().journey.adopt(token, "manual", true);
}

/**
 * Connects a Web Worker or MessagePort to the document bus for record routing.
 * @param worker Target Worker or MessagePort instance.
 */
export function registerWorker(worker: WorkerLike): void {
  requireRuntime().registerWorker(worker);
}

/** Rotates trace context to begin a new distributed trace. */
export function startTrace(): void {
  requireRuntime().tracing.rotate("explicit");
}

/**
 * Returns W3C traceparent headers for outgoing HTTP request propagation.
 * @returns Map of trace header keys and values.
 */
export function getTraceHeaders(): Record<string, string> {
  return requireRuntime().tracing.headers();
}

/**
 * Flushes all pending log batches across pipeline streams.
 * @returns Promise that resolves after the pipeline processes the queued batches.
 */
export function flush(): Promise<void> {
  return requireRuntime().flush();
}

/**
 * Counts the batches waiting in storage for delivery.
 * @returns Promise that resolves to the number of stored batches. A forwarder reports 0.
 * A forwarder does not store batches.
 */
export function getQueueDepth(): Promise<number> {
  return requireRuntime().queueDepth();
}

/**
 * Reads the delivery state of this context.
 * @returns Promise that resolves to the records that wait, the records in requests, the batches
 * in storage and the time of the last accepted send. A forwarder reports only its own buffers.
 */
export function getStats(): Promise<DeliveryStats> {
  return requireRuntime().stats();
}

/**
 * Starts a new session in this tab, for example after a logout. It ends the active journey and
 * starts a new trace. Other tabs read the new id at their next startup.
 */
export function newSession(): void {
  requireRuntime().newSession();
}

/**
 * Returns a snapshot of cumulative diagnostic event counts.
 * @returns Map of diagnostic fault codes to occurrence counts.
 */
export function getDiagnosticCounters(): Record<string, number> {
  return requireRuntime().diagnostics.snapshot();
}

/**
 * Flushes pending records and stops all runtime subsystems.
 * @returns Promise that resolves when shutdown completes.
 */
export async function shutdown(): Promise<void> {
  await ObservabilityRuntime.current()?.destroy();
}

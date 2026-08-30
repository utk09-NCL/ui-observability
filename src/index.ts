// src/index.ts
//
// Public library entry point exporting facade APIs, logging primitives, and types.

import type { WorkerLike } from "./bus/links";
import type { Journey } from "./core/journey";
import { OneLogger, type OneLoggerOptions } from "./core/logger";
import { ObservabilityRuntime } from "./core/runtime";
import type { ObservabilityConfig } from "./models/config";
import type { MetricType } from "./models/log-record";

export { OneLogger };
export type { Journey, ObservabilityConfig, OneLoggerOptions };
export type { WorkerLike } from "./bus/links";
export type { DiagnosticCode, DiagnosticEvent } from "./core/diagnostics";
export type { LogLevel, LogRecord, LogType, MetricType } from "./models/log-record";
export type { LogSerializer, SerializedBatch } from "./models/serializer";
export type { StorageAdapter } from "./models/storage";

/** Cached logger instances keyed by namespace and options. */
const loggers = new Map<string, OneLogger>();

/**
 * Retrieves the active realm runtime, initializing an implicit default if unconfigured.
 * @returns Active runtime instance.
 */
function requireRuntime(): ObservabilityRuntime {
  const runtime = ObservabilityRuntime.current();
  if (runtime) {
    return runtime;
  }

  // Configures implicit runtime to prevent throws on unconfigured log calls.
  return ObservabilityRuntime.configure({});
}

/**
 * Initializes or reconfigures the observability runtime instance.
 * @param config Consumer configuration options.
 */
export function configure(config: Partial<ObservabilityConfig>): void {
  ObservabilityRuntime.configure(config);
  // Clears cached loggers to rebind them to the updated runtime.
  loggers.clear();
}

/**
 * Retrieves or creates a cached logger instance for a namespace.
 * @param namespace Application subsystem or module namespace.
 * @param options Scoped context merged into records emitted by this logger.
 * @returns Cached OneLogger instance.
 */
export function getLogger(namespace: string, options?: OneLoggerOptions): OneLogger {
  const key = options ? `${namespace}::${JSON.stringify(options)}` : namespace;
  let logger = loggers.get(key);

  if (!logger) {
    logger = new OneLogger(requireRuntime(), namespace, options);
    loggers.set(key, logger);
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
 * @returns Promise resolving to the result of the timed function.
 */
export function timeAsync<T>(
  label: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return root().timeAsync(label, fn, attributes);
}

/**
 * Sets a key-value pair on ambient context included in subsequent records.
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
 * @param options Configuration options including parent linking.
 * @returns Started Journey instance.
 */
export function startJourney(name: string, options?: { parent?: boolean }): Journey {
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
 * @returns True if token was valid and successfully adopted.
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
 * @returns Promise resolving once queued batches are processed.
 */
export function flush(): Promise<void> {
  return requireRuntime().flush();
}

/**
 * Returns a snapshot of cumulative diagnostic event counts.
 * @returns Map of diagnostic fault codes to occurrence counts.
 */
export function getDiagnosticCounters(): Record<string, number> {
  return requireRuntime().diagnostics.snapshot();
}

/**
 * Flushes pending records and tears down all runtime subsystems.
 * @returns Promise resolving once shutdown completes.
 */
export async function shutdown(): Promise<void> {
  const runtime = ObservabilityRuntime.current();
  // Clears cached logger references to release the terminated runtime.
  loggers.clear();
  await runtime?.destroy();
}

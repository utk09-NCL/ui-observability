// src/core/logger.ts
//
// Namespaced logger facade providing scoped logging methods and metrics timing.

import { DEFAULT_METRIC_UNIT } from "../constants";
import type { LogLevel, LogType, MetricType } from "../models/log-record";
import { timeAsync, timeSync } from "../utils/timer";
import type { ObservabilityRuntime } from "./runtime";

/** Configuration options for a scoped OneLogger instance. */
export interface OneLoggerOptions {
  /** Contextual attributes merged into all records emitted by this logger. */
  scopedContext?: Record<string, unknown>;
}

/**
 * Normalizes an unknown thrown value into an Error instance.
 * @param value Caught error instance or primitive value.
 * @returns Normalized Error instance.
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Namespaced logger instance for recording structured events, metrics, and errors. */
export class OneLogger {
  /**
   * @param runtime Underlying observability runtime instance.
   * @param namespace Application subsystem or module namespace.
   * @param options Scoped context options.
   */
  constructor(
    private readonly runtime: ObservabilityRuntime,
    readonly namespace: string,
    private readonly options: OneLoggerOptions = {},
  ) {}

  /**
   * Creates a child logger with a nested namespace and merged scoped context.
   * @param namespace Sub-namespace appended with dot notation.
   * @param options Additional scoped context attributes.
   * @returns Nested child OneLogger instance.
   */
  child(namespace: string, options: OneLoggerOptions = {}): OneLogger {
    return new OneLogger(this.runtime, `${this.namespace}.${namespace}`, {
      scopedContext: {
        ...this.options.scopedContext,
        ...options.scopedContext,
      },
    });
  }

  /**
   * Logs a trace-level debug record.
   * @param message Log message.
   * @param payload Optional contextual attributes.
   */
  trace = (message: string, payload?: Record<string, unknown>): void => {
    this.write("TRACE", "system", message, payload);
  };

  /**
   * Logs a debug-level record.
   * @param message Log message.
   * @param payload Optional contextual attributes.
   */
  debug = (message: string, payload?: Record<string, unknown>): void => {
    this.write("DEBUG", "system", message, payload);
  };

  /**
   * Logs an informational record.
   * @param message Log message.
   * @param payload Optional contextual attributes.
   */
  info = (message: string, payload?: Record<string, unknown>): void => {
    this.write("INFO", "system", message, payload);
  };

  /**
   * Logs a warning record.
   * @param message Log message.
   * @param payload Optional contextual attributes.
   */
  warn = (message: string, payload?: Record<string, unknown>): void => {
    this.write("WARN", "system", message, payload);
  };

  /**
   * Logs an error record with attached breadcrumb history.
   * @param message Error description.
   * @param error Caught error instance or reason.
   * @param payload Optional contextual attributes.
   */
  error = (message: string, error?: unknown, payload?: Record<string, unknown>): void => {
    this.writeError("ERROR", message, error, payload);
  };

  /**
   * Logs a fatal unrecoverable error record.
   * @param message Error description.
   * @param error Caught error instance or reason.
   * @param payload Optional contextual attributes.
   */
  fatal = (message: string, error?: unknown, payload?: Record<string, unknown>): void => {
    this.writeError("FATAL", message, error, payload);
  };

  /**
   * Logs a discrete user interaction action.
   * @param name Action identifier.
   * @param payload Optional action attributes.
   */
  logAction = (name: string, payload?: Record<string, unknown>): void => {
    this.write("INFO", "action", name, payload);
  };

  /**
   * Logs an application lifecycle or domain event.
   * @param name Event identifier.
   * @param payload Optional event attributes.
   */
  logEvent = (name: string, payload?: Record<string, unknown>): void => {
    this.write("INFO", "event", name, payload);
  };

  /**
   * Logs a numerical metric measurement.
   * @param name Metric identifier.
   * @param value Numerical measurement.
   * @param unit Unit of measurement.
   * @param type Metric type classification.
   * @param attributes Optional metric attributes.
   */
  logMetric = (
    name: string,
    value: number,
    unit = DEFAULT_METRIC_UNIT,
    type: MetricType = "gauge",
    attributes?: Record<string, unknown>,
  ): void => {
    this.write("INFO", "metric", name, {
      "metric.name": name,
      "metric.value": value,
      "metric.unit": unit,
      "metric.type": type,
      ...attributes,
    });
  };

  /**
   * Times a synchronous function execution and records a duration metric.
   * @param label Metric name prefix.
   * @param fn Synchronous function to time.
   * @param attributes Optional contextual attributes.
   * @returns Result returned by the timed function.
   */
  timeSync = <T>(label: string, fn: () => T, attributes?: Record<string, unknown>): T =>
    timeSync(this, label, fn, attributes);

  /**
   * Times an asynchronous function execution and records a duration metric.
   * @param label Metric name prefix.
   * @param fn Asynchronous function to time.
   * @param attributes Optional contextual attributes.
   * @returns Promise resolving to the result of the timed function.
   */
  timeAsync = <T>(
    label: string,
    fn: () => Promise<T>,
    attributes?: Record<string, unknown>,
  ): Promise<T> => timeAsync(this, label, fn, attributes);

  /**
   * Builds, logs to console, and emits a standard log record.
   * @param level Severity level.
   * @param type Record classification.
   * @param body Primary message.
   * @param payload Optional contextual attributes.
   */
  private write(
    level: LogLevel,
    type: LogType,
    body: string,
    payload?: Record<string, unknown>,
  ): void {
    if (!this.runtime.builder.isEnabled(level)) {
      return;
    }

    const record = this.runtime.builder.build({
      level,
      type,
      body,
      namespace: this.namespace,
      scoped: this.options.scopedContext,
      payload,
    });

    if (record && type !== "metric") {
      this.runtime.breadcrumbs.push({
        t: Date.now(),
        category: type === "action" ? "action" : type === "event" ? "event" : "log",
        message: body,
      });
    }

    // Passes sanitized attributes to console to prevent object retention leaks.
    this.runtime.console.write(level, body, record?.attributes);
    this.runtime.emit(record);
  }

  /**
   * Builds, logs to console, and emits an error record with attached breadcrumbs.
   * @param level Severity level ("ERROR" or "FATAL").
   * @param message Error description.
   * @param error Caught error instance or reason.
   * @param payload Optional contextual attributes.
   */
  private writeError(
    level: "ERROR" | "FATAL",
    message: string,
    error: unknown,
    payload?: Record<string, unknown>,
  ): void {
    if (!this.runtime.builder.isEnabled(level)) {
      return;
    }

    const asError = error === undefined ? undefined : toError(error);

    const record = this.runtime.builder.build({
      level,
      type: "system",
      body: message,
      namespace: this.namespace,
      scoped: this.options.scopedContext,
      payload: {
        ...payload,
        ...(asError
          ? {
              "error.type": asError.name,
              "error.message": asError.message,
              "error.stack_trace": asError.stack,
            }
          : {}),
        breadcrumbs: this.runtime.breadcrumbs.snapshot(),
      },
    });

    this.runtime.console.write(level, message, asError ?? record?.attributes);
    this.runtime.emit(record);
  }
}

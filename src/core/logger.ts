// src/core/logger.ts
//
// This module gives a namespaced logger facade. It has scoped log methods and metric timers.

import { DEFAULT_METRIC_UNIT } from "../constants";
import type { LogLevel, LogRecord, LogType, MetricType } from "../models/log-record";
import { timeAsync, timeSync } from "../utils/timer";
import type { Diagnostics } from "./diagnostics";
import type { ObservabilityRuntime } from "./runtime";

/** Configuration options for a scoped OneLogger instance. */
export interface OneLoggerOptions {
  /** Contextual attributes merged into all records emitted by this logger. */
  scopedContext?: Record<string, unknown>;
}

/**
 * Normalizes an unknown thrown value into an Error instance.
 * @param value Caught error instance or primitive value.
 * @param diagnostics Diagnostics reporter.
 * @returns Normalized Error instance.
 */
function toError(value: unknown, diagnostics: Diagnostics): Error {
  if (value instanceof Error) {
    return value;
  }

  // String() throws on a null-prototype object and on a throwing toString.
  // log.error() runs inside a consumer catch block and must not throw out of it.
  const text = diagnostics.guard(
    "record.sanitize_failed",
    "The library could not convert the error reason to text.",
    () => String(value),
  );

  return new Error(text ?? typeof value);
}

/**
 * Tests if a value is an attribute bag, not an error reason. The test works across realms.
 * An object literal from an iframe has the Object.prototype of that realm.
 * The prototype of that Object.prototype is also null.
 * @param value Value found in the error slot.
 * @returns True if the value is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (value instanceof Error) {
    return false;
  }

  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** Namespaced logger instance for recording structured events, metrics, and errors. */
export class OneLogger {
  /**
   * @param bind Returns the runtime for each write.
   * A logger that exists before configure() writes to the configured runtime.
   * @param namespace Application subsystem or module namespace.
   * @param options Scoped context options.
   */
  constructor(
    private readonly bind: () => ObservabilityRuntime,
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
    return new OneLogger(this.bind, `${this.namespace}.${namespace}`, {
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
   * Logs an error record with the breadcrumb history. If payload is absent, a plain
   * object in the error slot becomes the payload.
   * @param message Error description.
   * @param error Caught error instance, reason, or payload.
   * @param payload Optional contextual attributes.
   */
  error = (message: string, error?: unknown, payload?: Record<string, unknown>): void => {
    this.writeError("ERROR", message, error, payload);
  };

  /**
   * Logs a fatal error record. If payload is absent, a plain object in the error slot
   * becomes the payload.
   * @param message Error description.
   * @param error Caught error instance, reason, or payload.
   * @param payload Optional contextual attributes.
   */
  fatal = (message: string, error?: unknown, payload?: Record<string, unknown>): void => {
    this.writeError("FATAL", message, error, payload);
  };

  /**
   * Logs one user action.
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
   * Builds and emits a standard log record. It also prints the record to the console.
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
    const runtime = this.bind();

    // Guard against a write after shutdown. The write must do nothing on the stopped runtime.
    if (runtime.isDestroyed()) {
      return;
    }

    // minLevel limits what the library sends. The console level limits what it prints.
    if (!runtime.builder.isEnabled(level)) {
      if (this.mirrors(runtime, level)) {
        this.print(runtime, level, body, payload, undefined, null);
      }

      return;
    }

    const { record, dropped } = runtime.builder.build({
      level,
      type,
      body,
      namespace: this.namespace,
      scoped: this.options.scopedContext,
      payload,
    });

    // Breadcrumbs stay in memory and have no delivery cost. A record that sampling drops
    // still adds a breadcrumb for the next error. Skip a record that redact drops.
    // Its breadcrumb sends the removed body with the next error.
    if (type !== "metric" && dropped !== "redact") {
      runtime.breadcrumbs.push({
        t: Date.now(),
        category: type === "action" ? "action" : type === "event" ? "event" : "log",
        message: body,
      });
    }

    this.print(runtime, level, body, payload, undefined, record);
    runtime.emit(record);
  }

  /**
   * Builds and emits an error record with breadcrumbs. It also prints the record to the console.
   * @param level Severity level ("ERROR" or "FATAL").
   * @param message Error description.
   * @param error Caught error instance, reason, or payload.
   * @param payload Optional contextual attributes.
   */
  private writeError(
    level: "ERROR" | "FATAL",
    message: string,
    error: unknown,
    payload?: Record<string, unknown>,
  ): void {
    const runtime = this.bind();

    if (runtime.isDestroyed()) {
      return;
    }

    const ships = runtime.builder.isEnabled(level);

    if (!ships && !this.mirrors(runtime, level)) {
      return;
    }

    // All sibling methods take (name, payload?). Callers expect log.error("failed", { id }).
    // As an error reason, that object puts "[object Object]" in error.message.
    // It also drops the caller fields.
    const asPayload = payload === undefined && isPlainObject(error);
    const attributes = asPayload ? error : payload;
    const asError =
      asPayload || error === undefined ? undefined : toError(error, runtime.diagnostics);

    if (!ships) {
      this.print(runtime, level, message, attributes, asError, null);
      return;
    }

    const { record } = runtime.builder.build({
      level,
      type: "system",
      body: message,
      namespace: this.namespace,
      scoped: this.options.scopedContext,
      payload: {
        ...attributes,
        ...(asError
          ? {
              "error.type": asError.name,
              "error.message": asError.message,
              "error.stack_trace": asError.stack,
            }
          : {}),
        breadcrumbs: runtime.breadcrumbs.snapshot(),
      },
    });

    this.print(runtime, level, message, attributes, asError, record);
    runtime.emit(record);
  }

  /**
   * Prints one log line. With a redact hook, the line shows only what redact returned.
   * A host can record console arguments. The console must not show what redact removes.
   * @param runtime Runtime of this write.
   * @param level Severity level.
   * @param message Primary message.
   * @param payload Caller payload.
   * @param error Error of an error call.
   * @param record Built record, or null if the library did not build it or redact dropped it.
   */
  private print(
    runtime: ObservabilityRuntime,
    level: LogLevel,
    message: string,
    payload: Record<string, unknown> | undefined,
    error: Error | undefined,
    record: LogRecord | null,
  ): void {
    if (!runtime.config.redact) {
      runtime.console.write(this.namespace, level, message, payload, error);
      return;
    }

    // The record attributes hold the error fields after redact.
    if (record) {
      runtime.console.write(this.namespace, level, record.body, record.attributes);
      return;
    }

    runtime.console.write(this.namespace, level, message, undefined, error);
  }

  /**
   * Tests whether the console prints a level that the library does not send.
   * @param runtime Runtime of this write.
   * @param level Severity level.
   * @returns True if logging is on and the console accepts the level.
   */
  private mirrors(runtime: ObservabilityRuntime, level: LogLevel): boolean {
    return runtime.config.enabled && runtime.console.accepts(level);
  }
}

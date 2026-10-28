// src/core/logger.ts
//
// This module gives a namespaced logger facade. It has scoped log methods and metric timers.

import {
  ATTR_BREADCRUMBS,
  ATTR_ERROR_DATA,
  ATTR_SANITIZE_FAILED,
  CAPTURE_NAMESPACE,
  DEFAULT_METRIC_UNIT,
  STORAGE_NAMESPACE,
} from "../constants";
import type { LogLevel, LogRecord, LogType, MetricType } from "../models/log-record";
import { ERROR_OWN_KEYS, isDataField, isErrorLike } from "../utils/error-like";
import { timeAsync, timeSync } from "../utils/timer";
import type { Diagnostics } from "./diagnostics";
import type { DropReason } from "./record";
import type { ObservabilityRuntime } from "./runtime";

/** Namespaces of the library. Their records have log.type "system". */
const LIBRARY_NAMESPACES: readonly string[] = [CAPTURE_NAMESPACE, STORAGE_NAMESPACE];

/** Configuration options for a scoped OneLogger instance. */
export interface OneLoggerOptions {
  /** Contextual attributes merged into all records emitted by this logger. */
  scopedContext?: Record<string, unknown>;
}

/**
 * Normalizes an unknown thrown value into an Error instance.
 * An error becomes a copy with its name, message and stack.
 * @param value Caught error instance or primitive value.
 * @param diagnostics Diagnostics reporter.
 * @returns Normalized Error instance.
 */
function toError(value: unknown, diagnostics: Diagnostics): Error {
  // A Proxy reason can throw from instanceof and from each property read. A Proxy around
  // an Error passes instanceof. Read its fields here, inside the guard.
  const known = diagnostics.guard(
    "record.sanitize_failed",
    "The library could not read the error reason.",
    (): Error | undefined => {
      if (!(value instanceof Error) && !isErrorLike(value)) {
        return undefined;
      }

      const copy = new Error(value.message);
      copy.name = value.name;
      copy.stack = value.stack;
      return copy;
    },
  );

  if (known) {
    return known;
  }

  // String() throws on a null-prototype object and on a toString that throws.
  // log.error() runs inside a consumer catch block. It must not throw out of it.
  const text = diagnostics.guard(
    "record.sanitize_failed",
    "The library could not convert the error reason to text.",
    () => String(value),
  );

  return new Error(text ?? typeof value);
}

/**
 * Gives the error that the console prints. The console shows the cause and the own fields
 * of a real Error. The record keeps the copy from toError().
 * @param reason Error reason.
 * @param copy Normalized copy of the reason.
 * @param diagnostics Diagnostics reporter.
 * @returns The reason if it is an Error, or the copy.
 */
function consoleError(reason: unknown, copy: Error, diagnostics: Diagnostics): Error {
  // A Proxy reason can throw from instanceof.
  const original = diagnostics.guard(
    "record.sanitize_failed",
    "The library could not read the error reason.",
    () => (reason instanceof Error ? reason : copy),
  );

  return original ?? copy;
}

/**
 * Reads the data of an error reason for the error.data attribute.
 * It keeps only the own fields with a string, number or boolean value.
 * @param value Error reason.
 * @param diagnostics Diagnostics reporter.
 * @returns The fields of an object reason, a primitive reason, or undefined.
 * A string reason gives undefined. error.message already holds it.
 */
function errorData(value: unknown, diagnostics: Diagnostics): unknown {
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint" || typeof value === "symbol") {
    return value;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return diagnostics.guard(
    "record.sanitize_failed",
    "The library could not read the properties of the error reason.",
    () => {
      const source = value as Record<string, unknown>;
      const errorLike = isErrorLike(value);
      const data: Record<string, unknown> = {};
      let count = 0;

      // An object field, for example the config of an AxiosError, holds credentials.
      for (const key of Object.keys(source)) {
        const field = source[key];
        if ((!errorLike || !ERROR_OWN_KEYS.has(key)) && isDataField(field)) {
          data[key] = field;
          count++;
        }
      }

      return count === 0 ? undefined : data;
    },
  );
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

/**
 * Selects the log.type of the level methods for a namespace.
 * @param namespace Logger namespace.
 * @returns "system" for a namespace of the library, "log" for each other namespace.
 */
function levelTypeFor(namespace: string): LogType {
  const library = LIBRARY_NAMESPACES.some(
    (own) => namespace === own || namespace.startsWith(`${own}.`),
  );

  return library ? "system" : "log";
}

/**
 * Copies a caller payload. A Proxy with a throwing trap must not throw out of a log call.
 * @param payload Caller payload.
 * @param diagnostics Diagnostics reporter.
 * @returns The copy, or a marker attribute when the library cannot read the payload.
 */
function copyPayload(
  payload: Record<string, unknown> | undefined,
  diagnostics: Diagnostics,
): Record<string, unknown> {
  if (payload === undefined) {
    return {};
  }

  const copied = diagnostics.guard(
    "record.sanitize_failed",
    "The library could not read the payload.",
    () => ({ ...payload }),
  );

  return copied ?? { [ATTR_SANITIZE_FAILED]: true };
}

/** Namespaced logger instance for recording structured events, metrics, and errors. */
export class OneLogger {
  /** log.type of the level methods. It is "system" only for the namespaces of the library. */
  private readonly levelType: LogType;

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
  ) {
    this.levelType = levelTypeFor(namespace);
  }

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
    this.write("TRACE", this.levelType, message, payload);
  };

  /**
   * Logs a debug-level record.
   * @param message Log message.
   * @param payload Optional contextual attributes.
   */
  debug = (message: string, payload?: Record<string, unknown>): void => {
    this.write("DEBUG", this.levelType, message, payload);
  };

  /**
   * Logs an informational record.
   * @param message Log message.
   * @param payload Optional contextual attributes.
   */
  info = (message: string, payload?: Record<string, unknown>): void => {
    this.write("INFO", this.levelType, message, payload);
  };

  /**
   * Logs a warning record.
   * @param message Log message.
   * @param payload Optional contextual attributes.
   */
  warn = (message: string, payload?: Record<string, unknown>): void => {
    this.write("WARN", this.levelType, message, payload);
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
    // NaN and Infinity become null in JSON. A backend then reads a false zero.
    if (!Number.isFinite(value)) {
      this.bind().diagnostics.report(
        "record.dropped_malformed",
        "The metric value is not a finite number. The library dropped the metric.",
        { "metric.name": name },
      );
      return;
    }

    // Spread the caller attributes first. The metric fields then win over a key of the same name.
    const payload = {
      ...copyPayload(attributes, this.bind().diagnostics),
      "metric.name": name,
      "metric.value": value,
      "metric.unit": unit,
      "metric.type": type,
    };
    this.write("INFO", "metric", name, payload, true);
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
   * @returns Promise that resolves to the result of the timed function.
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
   * @param copied True when the payload is a copy that the library made. write() does not copy it.
   */
  private write(
    level: LogLevel,
    type: LogType,
    body: string,
    payload?: Record<string, unknown>,
    copied = false,
  ): void {
    const runtime = this.bind();

    // Guard against a write after shutdown. The write must do nothing on the stopped runtime.
    if (runtime.isDestroyed()) {
      return;
    }

    // minLevel limits what the library sends. The console level limits what it prints.
    // minLevel does not apply to an action or a metric.
    if (!runtime.builder.isEnabled(level, type)) {
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
      payload: copied ? payload : copyPayload(payload, runtime.diagnostics),
    });

    // Breadcrumbs stay in memory and have no delivery cost. A breadcrumb keeps the body
    // after redact. A record that sampling drops did not go through redact. It keeps its
    // body, and redact sees it later inside the error record. A record that redact or
    // the shape check drops adds no breadcrumb.
    const crumb = record ? record.body : dropped === "sampling" ? body : undefined;
    if (type !== "metric" && crumb !== undefined) {
      runtime.breadcrumbs.push({
        t: Date.now(),
        category: type === "action" ? "action" : type === "event" ? "event" : "log",
        message: crumb,
      });
    }

    this.print(runtime, level, body, payload, undefined, record, dropped);
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
    // It also drops the caller fields. A Proxy in the error slot can throw on the test.
    const asPayload =
      payload === undefined &&
      (runtime.diagnostics.guard(
        "record.sanitize_failed",
        "The library could not read the error slot.",
        () => isPlainObject(error),
      ) ??
        false);
    const attributes = asPayload ? (error as Record<string, unknown>) : payload;
    const reason = asPayload ? undefined : error;
    const asError = reason === undefined ? undefined : toError(reason, runtime.diagnostics);
    const shown =
      asError === undefined ? undefined : consoleError(reason, asError, runtime.diagnostics);

    if (!ships) {
      this.print(runtime, level, message, attributes, shown, null);
      return;
    }

    const data = asError ? errorData(reason, runtime.diagnostics) : undefined;

    const { record, dropped } = runtime.builder.build({
      level,
      type: this.levelType,
      body: message,
      namespace: this.namespace,
      scoped: this.options.scopedContext,
      payload: {
        ...copyPayload(attributes, runtime.diagnostics),
        ...(asError
          ? {
              "error.type": asError.name,
              "error.message": asError.message,
              "error.stack_trace": asError.stack,
            }
          : {}),
        ...(data === undefined ? {} : { [ATTR_ERROR_DATA]: data }),
        [ATTR_BREADCRUMBS]: runtime.breadcrumbs.snapshot(),
      },
    });

    this.print(runtime, level, message, attributes, shown, record, dropped);
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
   * @param dropped Reason of the drop when the builder dropped the record.
   */
  private print(
    runtime: ObservabilityRuntime,
    level: LogLevel,
    message: string,
    payload: Record<string, unknown> | undefined,
    error: Error | undefined,
    record: LogRecord | null,
    dropped?: DropReason,
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

    // A record that redact or the shape check dropped prints no line. Its text did not pass redact.
    if (dropped === "redact" || dropped === "malformed") {
      return;
    }

    runtime.console.write(this.namespace, level, message, undefined, error);
  }

  /**
   * Tests if the console prints a level that the library does not send.
   * @param runtime Runtime of this write.
   * @param level Severity level.
   * @returns True if logging is on and the console accepts the level.
   */
  private mirrors(runtime: ObservabilityRuntime, level: LogLevel): boolean {
    return runtime.config.enabled && runtime.console.accepts(level);
  }
}

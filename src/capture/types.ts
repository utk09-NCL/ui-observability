// src/capture/types.ts
//
// Shared interfaces, the logger abstraction and helpers for the auto-capture modules.

import type { BreadcrumbBuffer } from "../core/breadcrumbs";
import type { Diagnostics } from "../core/diagnostics";
import type { SpanData } from "../core/spans";
import type { ResolvedConfig } from "../models/config";
import type { LogRecord, MetricType } from "../models/log-record";
import type { InstrumentDef, MetricAttributes } from "../models/metric";
import type { TraceEngine } from "../utils/tracing";

/**
 * The logging interface the auto-capture modules use. Referring to the runtime class here
 * would create an import cycle, because the runtime installs the capture modules.
 */
export interface CaptureLogger {
  /**
   * Logs an error event, with the error or reason behind it.
   * @param message Error description.
   * @param error The caught error or reason.
   * @param payload Optional attributes.
   */
  error(message: string, error?: unknown, payload?: Record<string, unknown>): void;

  /**
   * Logs a warning event.
   * @param message Warning description.
   * @param payload Optional attributes.
   */
  warn(message: string, payload?: Record<string, unknown>): void;

  /**
   * Logs a single lifecycle or user event.
   * @param name Event identifier.
   * @param payload Optional attributes.
   */
  logEvent(name: string, payload?: Record<string, unknown>): void;

  /**
   * Logs a numeric metric measurement.
   * @param name Metric name.
   * @param value The measurement.
   * @param unit Unit of measurement.
   * @param type Metric type.
   * @param attrs Optional metric attributes. With metricsEndpoint they're point attributes.
   * @param recordOnly Optional attributes for the record only, never on the OTLP point.
   */
  logMetric(
    name: string,
    value: number,
    unit?: string,
    type?: MetricType,
    attrs?: Record<string, unknown>,
    recordOnly?: Record<string, unknown>,
  ): void;

  /**
   * Logs a debug message.
   * @param message Debug message.
   * @param payload Optional attributes.
   */
  debug(message: string, payload?: Record<string, unknown>): void;
}

/**
 * Capture work that runs once per document, not once per install. A reconfigure
 * builds new capture instances, so instance state can't hold these flags.
 * web-vitals has no unsubscribe, and a second subscription would report every
 * metric twice.
 */
export interface CaptureOnce {
  /** True once the web-vitals reporters are subscribed. */
  webVitals: boolean;
  /** True once navigation timing has been reported. */
  navigationTiming: boolean;
  /** True after the first long frame install. Only that install reads buffered frames. */
  longFrames: boolean;
  /** True once we've read the previous page's alive marker. */
  uncleanExit: boolean;
  /** True after the first user timing install. Only that install reads buffered entries. */
  userTiming: boolean;
  /** True after the first resource timing install. Later installs skip buffered entries. */
  resourceTiming?: boolean;
  /** Page state and when it started. A reinstall keeps them, so it logs no false transition. */
  lifecycle?: { state: string; enteredAt: number };
  /** Set once the frame phases capture has reported a browser without long animation frames. */
  framePhases?: boolean;
  /** Set once the profiler's frame pacing has reported a context without frame callbacks. */
  framePacing?: boolean;
  /** Set once session replay has reported why it can't record in this document. */
  replay?: boolean;
}

/** Runtime dependencies shared by all auto-capture instances. */
export interface CaptureContext {
  /** False while the runtime is stopping or changing its security context. */
  isActive?: () => boolean;
  /** Active runtime configuration. */
  config: ResolvedConfig;
  /** Diagnostics reporter for capture faults. */
  diagnostics: Diagnostics;
  /** Logger for the telemetry the captures record. */
  logger: CaptureLogger;
  /** Breadcrumb buffer. */
  breadcrumbs: BreadcrumbBuffer;
  /** Active trace context provider. */
  tracing: TraceEngine;
  /** Guards for capture work that a reinstall must not repeat. */
  once: CaptureOnce;
  /** Adds a value to one of the runtime's counters or histograms. */
  recordMetric: (def: InstrumentDef, value: number, attributes?: MetricAttributes) => void;
  /** Records a span. The runtime drops it when spans are off. */
  recordSpan: (span: SpanData) => void;
  /** Returns the current session id. */
  sessionId: () => string;
  /** Sets or clears the hook that receives every ERROR and FATAL record from the runtime. */
  onError?: (hook: ((record: LogRecord) => void) | undefined) => void;
  /** Sets an ambient attribute on every later record. Undefined removes it. */
  setContext?: (key: string, value: string | undefined) => void;
  /** True after startReplay(), false after stopReplay(), undefined if neither was called. */
  replayConsent?: () => boolean | undefined;
}

/** Lifecycle interface for the browser instrumentation modules. */
export interface Capture {
  /** Module identifier used in diagnostics. */
  readonly name: string;
  /**
   * Attaches the instrumentation listeners and patches the target APIs. Patching an
   * already patched function adds a second wrapper and doubles every record, so a
   * second call must do nothing.
   */
  install(): void;
  /** Restores the native APIs and removes the listeners. */
  uninstall(): void;
}

/**
 * Checks whether a URL matches any of the substring or regular expression patterns.
 * @param url URL to test. A value that isn't a string matches nothing.
 * @param patterns Substrings and regular expressions to test against.
 * @returns True if any pattern matches the URL.
 */
export function matchesAny(url: unknown, patterns: (string | RegExp)[]): boolean {
  // Guard against a URL that isn't a string. includes() on it would throw inside the host's call.
  if (typeof url !== "string") {
    return false;
  }

  return patterns.some((pattern) =>
    typeof pattern === "string" ? url.includes(pattern) : pattern.test(url),
  );
}

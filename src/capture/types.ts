// src/capture/types.ts
//
// Shared interfaces, logger abstractions, and utility helpers for auto-capture modules.

import type { BreadcrumbBuffer } from "../core/breadcrumbs";
import type { Diagnostics } from "../core/diagnostics";
import type { SpanData } from "../core/spans";
import type { ResolvedConfig } from "../models/config";
import type { MetricType } from "../models/log-record";
import type { InstrumentDef, MetricAttributes } from "../models/metric";
import type { TraceEngine } from "../utils/tracing";

/**
 * Logging interface that auto-capture modules use. A reference to the runtime class
 * here causes an import cycle. The runtime installs the capture modules.
 */
export interface CaptureLogger {
  /**
   * Logs an error event with an associated error instance or reason.
   * @param message Error description.
   * @param error Caught error instance or reason.
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
   * Logs a discrete lifecycle or user event.
   * @param name Event identifier.
   * @param payload Optional attributes.
   */
  logEvent(name: string, payload?: Record<string, unknown>): void;

  /**
   * Logs a numerical metric measurement.
   * @param name Metric name.
   * @param value Numerical measurement.
   * @param unit Unit of measurement.
   * @param type Metric type classification.
   * @param attrs Optional metric attributes.
   */
  logMetric(
    name: string,
    value: number,
    unit?: string,
    type?: MetricType,
    attrs?: Record<string, unknown>,
  ): void;

  /**
   * Logs a diagnostic debug message.
   * @param message Debug message.
   * @param payload Optional attributes.
   */
  debug(message: string, payload?: Record<string, unknown>): void;
}

/**
 * Capture work that runs one time for each document, not one time for each
 * install. A reconfigure builds new capture instances. Thus instance state
 * cannot hold these flags. web-vitals has no unsubscribe. A second subscription
 * reports each metric two times.
 */
export interface CaptureOnce {
  /** True after the library subscribes the web-vitals reporters. */
  webVitals: boolean;
  /** True after the library reports navigation timing. */
  navigationTiming: boolean;
  /** True after the first long frame install. Only that install reads buffered frames. */
  longFrames: boolean;
}

/** Shared runtime dependencies provided to auto-capture instances. */
export interface CaptureContext {
  /** Active runtime configuration. */
  config: ResolvedConfig;
  /** Diagnostics reporter for capture faults. */
  diagnostics: Diagnostics;
  /** Logger instance for recorded telemetry. */
  logger: CaptureLogger;
  /** Buffer for recording contextual breadcrumbs. */
  breadcrumbs: BreadcrumbBuffer;
  /** Active trace context provider. */
  tracing: TraceEngine;
  /** Guards for the capture work that a reinstall must not repeat. */
  once: CaptureOnce;
  /** Adds a value to a counter or a histogram of the runtime. */
  recordMetric: (def: InstrumentDef, value: number, attributes?: MetricAttributes) => void;
  /** Records a span. The runtime drops it when spans are off. */
  recordSpan: (span: SpanData) => void;
}

/** Lifecycle interface for browser instrumentation modules. */
export interface Capture {
  /** Module identifier used in diagnostics. */
  readonly name: string;
  /**
   * Attaches instrumentation listeners and patches target APIs. A second patch on a
   * patched function adds a second wrapper and doubles each record. A second call
   * must do nothing.
   */
  install(): void;
  /** Restores native APIs and removes registered listeners. */
  uninstall(): void;
}

/**
 * Tests if a URL matches any string substring or regular expression pattern.
 * @param url Target URL to test. A value that is not a string matches nothing.
 * @param patterns Substrings and regular expressions to test against.
 * @returns True if any pattern matches the URL.
 */
export function matchesAny(url: unknown, patterns: (string | RegExp)[]): boolean {
  // Guard against a URL that is not a string. includes() on it throws in the call of the host.
  if (typeof url !== "string") {
    return false;
  }

  return patterns.some((pattern) =>
    typeof pattern === "string" ? url.includes(pattern) : pattern.test(url),
  );
}

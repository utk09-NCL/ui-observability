// src/capture/types.ts
//
// Shared interfaces, logger abstractions, and utility helpers for auto-capture modules.

import type { BreadcrumbBuffer } from "../core/breadcrumbs";
import type { Diagnostics } from "../core/diagnostics";
import type { ResolvedConfig } from "../models/config";
import type { MetricType } from "../models/log-record";
import type { TraceEngine } from "../utils/tracing";

/**
 * Logging interface consumed by auto-capture modules. Naming the runtime class
 * here instead would cycle: the runtime installs the capture modules.
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
}

/** Lifecycle interface for browser instrumentation modules. */
export interface Capture {
  /** Module identifier used in diagnostics. */
  readonly name: string;
  /**
   * Attaches instrumentation listeners and patches target APIs. Patching an
   * already patched function chains the wrapper and doubles every record, so a
   * second call must do nothing.
   */
  install(): void;
  /** Restores native APIs and removes registered listeners. */
  uninstall(): void;
}

/**
 * Evaluates whether a URL matches any string substring or regular expression pattern.
 * @param url Target URL to test.
 * @param patterns Substrings and regular expressions to test against.
 * @returns True if any pattern matches the URL.
 */
export function matchesAny(url: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((pattern) =>
    typeof pattern === "string" ? url.includes(pattern) : pattern.test(url),
  );
}

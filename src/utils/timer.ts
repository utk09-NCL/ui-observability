// src/utils/timer.ts
//
// Utility functions for timing synchronous and asynchronous operations as metrics.

import type { CaptureLogger } from "../capture/types";
import { DURATION_PRECISION } from "../constants";

/**
 * Calculates elapsed milliseconds rounded to configured precision.
 * @param startedAt Performance timestamp recorded at operation start.
 * @returns Elapsed duration in milliseconds.
 */
function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * DURATION_PRECISION) / DURATION_PRECISION;
}

/**
 * Logs a successful operation duration histogram metric.
 * @param logger Target telemetry logger.
 * @param label Metric name prefix.
 * @param startedAt Performance timestamp recorded at operation start.
 * @param status Outcome status string.
 * @param attributes Optional contextual attributes.
 */
function finish(
  logger: CaptureLogger,
  label: string,
  startedAt: number,
  status: string,
  attributes?: Record<string, unknown>,
): void {
  logger.logMetric(`${label}.duration`, elapsed(startedAt), "ms", "histogram", {
    status,
    ...attributes,
  });
}

/**
 * Logs an operation failure with elapsed duration attributes.
 * @param logger Target telemetry logger.
 * @param label Operation label.
 * @param startedAt Performance timestamp recorded at operation start.
 * @param error Caught error instance or thrown value.
 * @param attributes Optional contextual attributes.
 */
function fail(
  logger: CaptureLogger,
  label: string,
  startedAt: number,
  error: unknown,
  attributes?: Record<string, unknown>,
): void {
  logger.error(`${label} failed`, error, {
    "action.duration_ms": elapsed(startedAt),
    status: "FAILURE",
    ...attributes,
  });
}

/**
 * Executes and measures the duration of a synchronous function.
 * @param logger Target telemetry logger.
 * @param label Metric name prefix.
 * @param fn Synchronous function to execute.
 * @param attributes Optional contextual attributes.
 * @returns Result returned by the wrapped function.
 */
export function timeSync<T>(
  logger: CaptureLogger,
  label: string,
  fn: () => T,
  attributes?: Record<string, unknown>,
): T {
  const startedAt = performance.now();
  try {
    const result = fn();
    finish(logger, label, startedAt, "SUCCESS", attributes);
    return result;
  } catch (error) {
    // Re-throws error to preserve caller control flow.
    fail(logger, label, startedAt, error, attributes);
    throw error;
  }
}

/**
 * Executes and measures the duration of an asynchronous promise-returning function.
 * @param logger Target telemetry logger.
 * @param label Metric name prefix.
 * @param fn Asynchronous function to execute.
 * @param attributes Optional contextual attributes.
 * @returns Promise resolving to the result of the wrapped function.
 */
export async function timeAsync<T>(
  logger: CaptureLogger,
  label: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await fn();
    finish(logger, label, startedAt, "SUCCESS", attributes);
    return result;
  } catch (error) {
    // Re-throws error to preserve caller control flow.
    fail(logger, label, startedAt, error, attributes);
    throw error;
  }
}

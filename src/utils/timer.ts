// src/utils/timer.ts
//
// Logs the duration of synchronous and asynchronous operations as metrics.

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
 * Logs the operation duration as a histogram metric, for each outcome.
 * @param logger Target telemetry logger.
 * @param label Metric name prefix.
 * @param duration Elapsed duration in milliseconds.
 * @param status Outcome status string.
 * @param attributes Optional contextual attributes.
 */
function finish(
  logger: CaptureLogger,
  label: string,
  duration: number,
  status: string,
  attributes?: Record<string, unknown>,
): void {
  logger.logMetric(`${label}.duration`, duration, "ms", "histogram", {
    status,
    ...attributes,
  });
}

/**
 * Logs an operation failure and its FAILURE duration histogram.
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
  // Read the duration one time. The error record and the metric then give the same value.
  const duration = elapsed(startedAt);
  logger.error(`${label} failed`, error, {
    "action.duration_ms": duration,
    status: "FAILURE",
    ...attributes,
  });
  finish(logger, label, duration, "FAILURE", attributes);
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
    finish(logger, label, elapsed(startedAt), "SUCCESS", attributes);
    return result;
  } catch (error) {
    // Throw the error again. The caller keeps its control flow.
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
 * @returns Promise that resolves to the result of the wrapped function.
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
    finish(logger, label, elapsed(startedAt), "SUCCESS", attributes);
    return result;
  } catch (error) {
    // Throw the error again. The caller keeps its control flow.
    fail(logger, label, startedAt, error, attributes);
    throw error;
  }
}

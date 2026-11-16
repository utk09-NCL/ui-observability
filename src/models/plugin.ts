// src/models/plugin.ts
//
// Public types for a capture plugin. A plugin gets a small context, so none of the library's
// internal types become public.

import type { OneLogger } from "../core/logger";
import type { Counter, Histogram, HistogramOptions, InstrumentOptions } from "./metric";

/** Tools the library hands to a capture plugin. */
export interface PluginContext {
  /** Logger for the `uiobs.capture.<plugin name>` namespace. */
  logger: OneLogger;
  /**
   * Returns a counter. Same as `counter()`.
   * @param name Metric name.
   * @param options Unit of the values.
   * @returns The counter.
   */
  counter(name: string, options?: InstrumentOptions): Counter;
  /**
   * Returns a histogram. Same as `histogram()`.
   * @param name Metric name.
   * @param options Unit of the values and the bucket boundaries.
   * @returns The histogram.
   */
  histogram(name: string, options?: HistogramOptions): Histogram;
  /**
   * Adds a breadcrumb with the category `custom`. Same as `addBreadcrumb()`.
   * @param message Description of the event.
   * @param data Optional metadata.
   */
  addBreadcrumb(message: string, data?: Record<string, unknown>): void;
  /**
   * Runs a function. The network capture doesn't record any request the function starts
   * synchronously, and doesn't add `traceparent` to it. Use it for the plugin's own requests.
   * @param fn Function that starts the request.
   * @returns The function's return value.
   */
  ownRequest<T>(fn: () => T): T;
}

/** Capture module supplied by the app. The library installs it alongside the built-in ones. */
export interface CapturePlugin {
  /** Plugin name, used in its logger namespace and its diagnostic messages. */
  readonly name: string;
  /**
   * Starts the capture. A later `configure()` that changes the capture section calls
   * `uninstall()` and then `install()` again.
   * @param ctx The plugin's tools.
   */
  install(ctx: PluginContext): void;
  /** Stops the capture. Restore every function the plugin replaced. */
  uninstall(): void;
}

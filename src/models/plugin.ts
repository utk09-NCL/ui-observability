// src/models/plugin.ts
//
// Public types of a capture plugin. A plugin gets a small context. No internal type of the
// library becomes public.

import type { OneLogger } from "../core/logger";
import type { Counter, Histogram, HistogramOptions, InstrumentOptions } from "./metric";

/** Tools that the library gives to a capture plugin. */
export interface PluginContext {
  /** Logger for the namespace `uiobs.capture.<plugin name>`. */
  logger: OneLogger;
  /**
   * Gives a counter. It is the same as `counter()`.
   * @param name Metric name.
   * @param options Unit of the values.
   * @returns The counter.
   */
  counter(name: string, options?: InstrumentOptions): Counter;
  /**
   * Gives a histogram. It is the same as `histogram()`.
   * @param name Metric name.
   * @param options Unit of the values and the bucket boundaries.
   * @returns The histogram.
   */
  histogram(name: string, options?: HistogramOptions): Histogram;
  /**
   * Adds a breadcrumb with the category `custom`. It is the same as `addBreadcrumb()`.
   * @param message Description of the event.
   * @param data Optional metadata.
   */
  addBreadcrumb(message: string, data?: Record<string, unknown>): void;
  /**
   * Runs a function. The network capture does not record a request that the function starts
   * synchronously, and does not add `traceparent` to it. Use it for the requests of the plugin.
   * @param fn Function that starts the request.
   * @returns The return value of the function.
   */
  ownRequest<T>(fn: () => T): T;
}

/** Capture module from the app. The library installs it with the built-in capture modules. */
export interface CapturePlugin {
  /** Name of the plugin. Its logger namespace and its diagnostic messages use it. */
  readonly name: string;
  /**
   * Starts the capture. A later `configure()` that changes the capture section calls
   * `uninstall()`, then calls `install()` again.
   * @param ctx Tools of the plugin.
   */
  install(ctx: PluginContext): void;
  /** Stops the capture. Restore each function that the plugin replaced. */
  uninstall(): void;
}

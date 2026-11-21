// src/observability-settings/settings.ts
//
// The choices that the settings panel changes, and the defaults of this example. The defaults
// lean toward more data, so each row of the panel has a cheaper value to show.

import type { LogLevel } from "@utk09/ui-observability";

/** One field for each row of the panel. hints.ts maps each field to a config key. */
export interface Settings {
  consoleOutput: boolean;
  minLevel: LogLevel;
  payloadMode: "copy" | "defer";
  /** Keep rate of the noisy namespace market.prices, from 0 to 1. */
  priceSampling: number;
  maxArrayLength: number;
  maxDepth: number;
  maxNodes: number;
  diagnosticRecords: boolean;
  webSocket: boolean;
  fetch: boolean;
  interactions: boolean;
  interactionText: boolean;
  console: boolean;
  transportWorker: boolean;
  compression: "gzip" | "none";
  logBatchSize: number;
  logFlushIntervalMs: number;
  storageBackend: "auto" | "none";
  spans: boolean;
  pageUrl: boolean;
  userAgent: boolean;
  breadcrumbs: number;
}

export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  consoleOutput: true,
  minLevel: "DEBUG",
  payloadMode: "copy",
  priceSampling: 1,
  maxArrayLength: 100,
  maxDepth: 6,
  maxNodes: 10000,
  diagnosticRecords: true,
  webSocket: true,
  fetch: true,
  interactions: true,
  // Click text can hold personal data, so it stays off until the app turns it on.
  interactionText: false,
  console: true,
  transportWorker: false,
  compression: "gzip",
  logBatchSize: 100,
  logFlushIntervalMs: 2000,
  storageBackend: "auto",
  spans: true,
  pageUrl: true,
  userAgent: true,
  breadcrumbs: 50,
};

/**
 * Prints the settings that the cost meter can show, for the history table.
 * @param settings The settings in force.
 * @returns One short line.
 */
export function summarize(settings: Settings): string {
  return [
    `console ${settings.consoleOutput ? "on" : "off"}`,
    `min ${settings.minLevel}`,
    settings.payloadMode,
    `array ${String(settings.maxArrayLength)}`,
    `depth ${String(settings.maxDepth)}`,
    `nodes ${String(settings.maxNodes)}`,
  ].join(", ");
}

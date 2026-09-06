// src/models/config.ts
//
// Configuration types: what a consumer may pass to `configure()`, and what
// the runtime holds after resolving defaults.
//
// Not derived with `Required<ObservabilityConfig>`: that only strips `?` at
// the top level, so a nested field like `sampling.defaultRate` would stay
// possibly undefined.

import type { DiagnosticHandler } from "../core/diagnostics";
import type { LogLevel, LogRecord } from "./log-record";
import type { LogSerializer } from "./serializer";

/** Backing store for undelivered records. "auto" picks the best one the host supports. */
export type StorageStrategy = "auto" | "indexeddb" | "localstorage" | "memory" | "none";

/** What this context does with its records: `sender` delivers its own, `forwarder` hands them to another context, `auto` decides, `off` does neither. */
export type BusMode = "auto" | "sender" | "forwarder" | "off";

/** Structural type for the `web-vitals` package's metric shape, so this library has no hard dependency on the package. */
export interface WebVitalsMetric {
  /** Measurement value, in the metric's own unit. */
  value: number;
  /** Rating: "good", "needs-improvement", or "poor". */
  rating?: string;
  /** Metric instance id, for matching a later update to its first report. */
  id: string;
}

/**
 * Callback `web-vitals` invokes with a measurement.
 * @param metric The measurement being reported.
 */
export type WebVitalsReporter = (metric: WebVitalsMetric) => void;

/** The five `web-vitals` entry points this library subscribes to. */
export interface WebVitalsModule {
  /**
   * Largest Contentful Paint.
   * @param report Callback invoked with the LCP measurement.
   */
  onLCP: (report: WebVitalsReporter) => void;
  /**
   * Cumulative Layout Shift.
   * @param report Callback invoked with the CLS measurement.
   */
  onCLS: (report: WebVitalsReporter) => void;
  /**
   * Interaction to Next Paint.
   * @param report Callback invoked with the INP measurement.
   */
  onINP: (report: WebVitalsReporter) => void;
  /**
   * First Contentful Paint.
   * @param report Callback invoked with the FCP measurement.
   */
  onFCP: (report: WebVitalsReporter) => void;
  /**
   * Time to First Byte.
   * @param report Callback invoked with the TTFB measurement.
   */
  onTTFB: (report: WebVitalsReporter) => void;
}

/** Sampling policy: which records survive. */
export interface SamplingOptions {
  /**
   * Default fraction of records kept, 0 to 1.
   * @default 1
   */
  defaultRate: number;
  /**
   * Per-namespace override, keyed by `app.namespace`. Most specific prefix wins.
   * @default {}
   */
  rates: Record<string, number>;
  /**
   * Log types always kept, regardless of the sampling rate.
   * @default ["action"]
   */
  alwaysSampleTypes: string[];
}

/** Bus settings: how this context discovers, trusts, and messages the others. */
export interface BusOptions {
  /**
   * This context's role.
   * @default "auto"
   */
  mode: BusMode;
  /**
   * Origins allowed to send postMessage records to this document. Required for any document receiving them from a cross-origin iframe.
   * @default []
   */
  trustedOrigins: string[];
  /**
   * Which OpenFin context this is. Only the platform provider answers a
   * handshake, so setting this wrong makes every view send for itself.
   * "auto" treats the window whose name equals its application uuid as the
   * provider.
   * @default "auto"
   */
  openFinRole: "auto" | "provider" | "client";
}

/** What the library instruments automatically. Everything but errors and rejections is off by default. */
export interface CaptureOptions {
  /**
   * Log uncaught errors from `window.onerror`.
   * @default true
   */
  errors: boolean;
  /**
   * Log unhandled promise rejections.
   * @default true
   */
  rejections: boolean;
  /**
   * Log failed image, script, and stylesheet loads.
   * @default false
   */
  resourceErrors: boolean;
  /**
   * Wrap `fetch` to log requests. The ingest endpoint itself is never logged.
   * @default false
   */
  fetch: boolean;
  /**
   * Wrap `XMLHttpRequest` to log requests.
   * @default false
   */
  xhr: boolean;
  /**
   * Log clicks and other interactions as breadcrumbs.
   * @default false
   */
  interactions: boolean;
  /**
   * Log route changes, including single-page-application navigation.
   * @default false
   */
  navigation: boolean;
  /**
   * Report web vitals as metrics. Requires the `web-vitals` peer or `webVitalsLoader`.
   * @default false
   */
  webVitals: boolean;
  /**
   * URLs excluded from logging. The ingest endpoint is always included.
   * @default []
   */
  ignoreUrls: (string | RegExp)[];
  /**
   * Targets that receive a `traceparent` header. A catch-all breaks CORS on third-party endpoints.
   * @default []
   */
  propagateTraceHeaderTo: (string | RegExp)[];
  /**
   * Supplies the `web-vitals` module without a hard dependency on the package.
   * @returns A promise resolving to the `web-vitals` module.
   */
  webVitalsLoader?: () => Promise<WebVitalsModule>;
}

/** Console mirroring. `false` is off, `true` mirrors from DEBUG, a level mirrors from that level up. */
export type ConsoleOption = boolean | LogLevel;

/** Options passed to `configure()`. Only `endpoint` is required. */
export interface ObservabilityConfig {
  /** Ingest endpoint URL. Required. */
  endpoint: string;

  /**
   * Reported as `service.name`.
   * @default ""
   */
  serviceName?: string;
  /**
   * Reported as `service.version`.
   * @default ""
   */
  serviceVersion?: string;
  /**
   * Reported as `deployment.environment`.
   * @default ""
   */
  environment?: string;

  /**
   * Master switch. False makes every log call a no-op.
   * @default true
   */
  enabled?: boolean;
  /**
   * Min level logged.
   * @default "INFO"
   */
  minLevel?: LogLevel;

  /**
   * Whether to gzip a payload past the compression threshold. Set "none" for an ingest endpoint that rejects gzip.
   * @default "gzip"
   */
  compression?: "gzip" | "none";
  /**
   * Wire format: a name, or a custom implementation.
   * @default "otlp"
   */
  serializer?: "otlp" | "ecs" | LogSerializer;
  /**
   * Passed to `fetch`.
   * @default "include"
   */
  credentials?: RequestCredentials;
  /** Extra request headers, or a function returning them. */
  headers?:
    Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  /**
   * Backing store for undelivered records.
   * @default "auto"
   */
  storage?: StorageStrategy;
  /**
   * Sampling policy.
   * @see {@link SamplingOptions}
   */
  sampling?: Partial<SamplingOptions>;
  /**
   * Bus discovery, trust, and messaging settings.
   * @see {@link BusOptions}
   */
  bus?: Partial<BusOptions>;
  /**
   * Automatic instrumentation.
   * @see {@link CaptureOptions}
   */
  capture?: Partial<CaptureOptions>;
  /**
   * Console mirroring, for development.
   * @default false
   */
  console?: ConsoleOption;

  /**
   * Rewrites or drops a record before it's sent.
   * @param record The record about to be sent.
   * @returns The record to send, or `null` to drop it.
   */
  redact?: (record: LogRecord) => LogRecord | null;

  /**
   * Reports this library's own faults.
   * @see {@link DiagnosticHandler}
   */
  onDiagnostic?: DiagnosticHandler;
}

/** Fully resolved config, held by the runtime. */
export interface ResolvedConfig {
  /** Ingest endpoint URL. */
  endpoint: string;
  /** Reported as `service.name`. */
  serviceName: string;
  /** Reported as `service.version`. */
  serviceVersion: string;
  /** Reported as `deployment.environment`. */
  environment: string;
  /** Master switch. False makes every log call a no-op. */
  enabled: boolean;
  /** Min level logged. */
  minLevel: LogLevel;
  /** Whether to gzip a payload past the compression threshold. */
  compression: "gzip" | "none";
  /** Passed to `fetch`. */
  credentials: RequestCredentials;
  /** Backing store for undelivered records. */
  storage: StorageStrategy;
  /**
   * Sampling policy.
   * @see {@link SamplingOptions}
   */
  sampling: SamplingOptions;
  /**
   * Bus discovery, trust, and messaging settings.
   * @see {@link BusOptions}
   */
  bus: BusOptions;
  /**
   * Automatic instrumentation.
   * @see {@link CaptureOptions}
   */
  capture: CaptureOptions;
  /** Min level mirrored to the console, or null when mirroring is off. */
  console: LogLevel | null;
  /** Wire format implementation, resolved from a name or passed directly. */
  serializer: LogSerializer;
  /** Extra request headers, or a function returning them. */
  headers?: ObservabilityConfig["headers"];
  /**
   * Rewrites or drops a record before it's sent.
   * @param record The record about to be sent.
   * @returns The record to send, or `null` to drop it.
   */
  redact?: ObservabilityConfig["redact"];
  /**
   * Reports this library's own faults.
   * @see {@link DiagnosticHandler}
   */
  onDiagnostic?: DiagnosticHandler;
}

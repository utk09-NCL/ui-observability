// src/models/config.ts
//
// Configuration types: what a consumer may pass to `configure()`, and what
// the runtime holds after resolving defaults.
//
// Not derived with `Required<ObservabilityConfig>`: that only strips `?` at
// the top level, so a nested field like `storage.maxBatches` would stay
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

/** Batching policy for one record stream (logs or metrics). */
export interface StreamOptions {
  /** Max time a partial batch waits before it is sent, in milliseconds. */
  flushIntervalMs: number;
  /** Max records per batch before it is sent early. */
  batchSize: number;
}

/** The two record streams, batched independently. */
export interface StreamsOptions {
  /** Log stream batching. */
  logs: StreamOptions;
  /** Metric stream batching. */
  metrics: StreamOptions;
}

/** Storage policy for undelivered records. */
export interface StorageOptions {
  /**
   * Backing store.
   * @default "auto"
   */
  strategy: StorageStrategy;
  /**
   * IndexedDB database name. Used only when the strategy resolves to indexeddb.
   * @default "UiObservability"
   */
  dbName: string;
  /**
   * Max batches held at once. Oldest are evicted past this.
   * @default 500
   */
  maxBatches: number;
  /**
   * Max batch age before it is dropped rather than retried, in milliseconds.
   * @default 24 * 60 * 60 * 1000
   */
  maxAgeMs: number;
  /**
   * Max delivery attempts before a batch is dead-lettered.
   * @default 5
   */
  maxAttempts: number;
}

/** Backoff schedule for redelivering a stored batch. */
export interface RetryOptions {
  /**
   * First backoff step, in milliseconds. Each attempt doubles it.
   * @default 2000
   */
  baseDelayMs: number;
  /**
   * Backoff ceiling, in milliseconds.
   * @default 60000
   */
  maxDelayMs: number;
  /**
   * How often to check for stored work when nothing has failed recently, in milliseconds.
   * @default 30000
   */
  idleDelayMs: number;
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
   * Log types always kept, regardless of sampling rate.
   * @default ["action"]
   */
  alwaysSampleTypes: string[];
}

/** Lifetime rules for a journey (one user task spanning several contexts). */
export interface JourneyOptions {
  /**
   * Max time a journey stays open before it's treated as abandoned, in milliseconds.
   * @default 30 * 60 * 1000
   */
  maxAgeMs: number;
  /**
   * Whether closing the owning context ends the journey for everyone.
   * @default false
   */
  endOnOwnerClose: boolean;
  /**
   * Query parameter checked at boot for a seeded journey token.
   * @default "__uiobs_journey"
   */
  urlParam: string;
}

/** Bus settings: how this context discovers, trusts, and messages the others. */
export interface BusOptions {
  /**
   * This context's role.
   * @default "auto"
   */
  mode: BusMode;
  /**
   * BroadcastChannel name for the control plane.
   * @default "ui_observability_control"
   */
  channelName: string;
  /**
   * Origins allowed to send postMessage records to this document. Required for any document receiving them from a cross-origin iframe.
   * @default []
   */
  trustedOrigins: string[];
  /**
   * Max time a forwarder waits for an owner to answer before applying the orphan policy, in milliseconds.
   * @default 1500
   */
  handshakeTimeoutMs: number;
  /**
   * Which OpenFin context owns delivery.
   * @default "provider"
   */
  openFinHost: "provider" | "self";
  /**
   * Which OpenFin context this is. Only the platform provider answers a
   * handshake, so setting this wrong makes every view send for itself.
   * "auto" treats the window whose name equals its application uuid as the
   * provider.
   * @default "auto"
   */
  openFinRole: "auto" | "provider" | "client";
  /**
   * Max records a context buffers before its bus role is determined.
   * @default 500
   */
  maxBootBufferRecords: number;
  /**
   * Forwarder behavior when no owner answers: `auto` retries in a
   * cross-origin frame and promotes elsewhere, `promote` becomes a sender
   * immediately, `retry` retries then promotes as a last resort.
   * @default "auto"
   */
  orphanPolicy: "auto" | "promote" | "retry";
  /**
   * Handshake attempts allowed before promoting under the "retry" policy.
   * @default 3
   */
  maxHandshakeAttempts: number;
}

/** What the library instruments automatically. Everything but errors is off by default. */
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
   * Breadcrumbs kept as context for the next error.
   * @default 50
   */
  maxBreadcrumbs: number;
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
   * Window within which identical errors are counted but not re-sent, in milliseconds.
   * @default 5000
   */
  errorDedupeMs: number;
  /**
   * Supplies the `web-vitals` module without a hard dependency on the package.
   * @returns A promise resolving to the `web-vitals` module.
   */
  webVitalsLoader?: () => Promise<WebVitalsModule>;
}

/** Per-record size caps. */
export interface LimitOptions {
  /**
   * Max record body length, in characters.
   * @default 4096
   */
  maxBodyChars: number;
  /**
   * Max length of a single string attribute, in characters.
   * @default 8192
   */
  maxAttributeChars: number;
  /**
   * Max attributes per record.
   * @default 128
   */
  maxAttributeCount: number;
  /**
   * Max stack trace length, in characters. Larger than `maxAttributeChars`.
   * @default 8192
   */
  maxStackChars: number;
  /**
   * Max depth walked into a nested value before truncating.
   * @default 6
   */
  maxDepth: number;
  /**
   * Max items kept from an array, set, or map.
   * @default 100
   */
  maxArrayLength: number;
  /**
   * Max total attribute bytes per record, checked after sanitize and redact.
   * @default 32768
   */
  maxRecordBytes: number;
}

/** Console mirroring, for development. */
export interface ConsoleOptions {
  /**
   * Whether to mirror at all.
   * @default false
   */
  enabled: boolean;
  /**
   * Min level to mirror. Independent of `minLevel`.
   * @default "DEBUG"
   */
  level: LogLevel;
}

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

  /** Per-stream batching. */
  streams?: {
    /**
     * Log stream batching.
     * @default { flushIntervalMs: 2000, batchSize: 100 }
     */
    logs?: Partial<StreamOptions>;
    /**
     * Metric stream batching.
     * @default { flushIntervalMs: 10000, batchSize: 500 }
     */
    metrics?: Partial<StreamOptions>;
  };
  /**
   * Max concurrent ingest requests, across both streams.
   * @default 2
   */
  maxConcurrentRequests?: number;
  /**
   * Max time one ingest request may take before it is aborted and retried, in milliseconds.
   * @default 15000
   */
  requestTimeoutMs?: number;

  /**
   * Whether to gzip a payload past `compressionThresholdBytes`.
   * @default "gzip"
   */
  compression?: "gzip" | "none";
  /**
   * Min payload size to compress, in bytes.
   * @default 1024
   */
  compressionThresholdBytes?: number;
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
   * Storage policy for undelivered records.
   * @see {@link StorageOptions}
   */
  storage?: Partial<StorageOptions>;
  /**
   * Backoff schedule for redelivering them.
   * @see {@link RetryOptions}
   */
  retry?: Partial<RetryOptions>;
  /**
   * Sampling policy.
   * @see {@link SamplingOptions}
   */
  sampling?: Partial<SamplingOptions>;
  /**
   * Journey lifetime rules.
   * @see {@link JourneyOptions}
   */
  journey?: Partial<JourneyOptions>;
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
   * Per-record size caps.
   * @see {@link LimitOptions}
   */
  limits?: Partial<LimitOptions>;
  /**
   * Console mirroring.
   * @see {@link ConsoleOptions}
   */
  console?: Partial<ConsoleOptions>;

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
  /**
   * Per-stream batching.
   * @see {@link StreamsOptions}
   */
  streams: StreamsOptions;
  /** Max concurrent ingest requests, across both streams. */
  maxConcurrentRequests: number;
  /** Max time one ingest request may take before it is aborted and retried, in milliseconds. */
  requestTimeoutMs: number;
  /** Whether to gzip a payload past `compressionThresholdBytes`. */
  compression: "gzip" | "none";
  /** Min payload size to compress, in bytes. */
  compressionThresholdBytes: number;
  /** Passed to `fetch`. */
  credentials: RequestCredentials;
  /**
   * Storage policy for undelivered records.
   * @see {@link StorageOptions}
   */
  storage: StorageOptions;
  /**
   * Backoff schedule for redelivering a stored batch.
   * @see {@link RetryOptions}
   */
  retry: RetryOptions;
  /**
   * Sampling policy.
   * @see {@link SamplingOptions}
   */
  sampling: SamplingOptions;
  /**
   * Journey lifetime rules.
   * @see {@link JourneyOptions}
   */
  journey: JourneyOptions;
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
  /**
   * Per-record size caps.
   * @see {@link LimitOptions}
   */
  limits: LimitOptions;
  /**
   * Console mirroring.
   * @see {@link ConsoleOptions}
   */
  console: ConsoleOptions;
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

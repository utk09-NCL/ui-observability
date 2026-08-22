// src/models/config.ts
//
// The two faces of configuration: what a consumer may pass, and what the
// runtime actually holds.
//
// They are declared separately and on purpose. `ObservabilityConfig` is almost
// entirely optional, because the whole point is that `configure({ endpoint })`
// works. `ResolvedConfig` has no optionality left in it, because every component
// downstream reads these values without checking them first.
//
// Do not try to derive the second from the first with
// `Required<ObservabilityConfig>`. `Required<T>` strips `?` at the top level
// only, so `config.storage.maxBatches` would stay `number | undefined` and every
// arithmetic use of it is a type error under `strict`. The mistake compiles
// happily right up until a section is handed to something that expects real
// numbers. Each nested section is therefore declared once, fully required, and
// appears on `ObservabilityConfig` as a `Partial` of itself.

import type { DiagnosticHandler } from "../core/diagnostics";
import type { LogLevel, LogRecord } from "./log-record";

export type StorageStrategy = "auto" | "indexeddb" | "localstorage" | "memory" | "none";
export type BusMode = "auto" | "sender" | "forwarder" | "off";

/**
 * The subset of the `web-vitals` package this library uses.
 *
 * Declared structurally rather than imported. `web-vitals` is an optional peer
 * dependency, so a consumer who never turns vitals capture on must not need the
 * package present for their build to type-check, and a hard `import type` from
 * it would make it required for everyone.
 */
export interface WebVitalsMetric {
  value: number;
  rating?: string;
  id: string;
}
export type WebVitalsReporter = (metric: WebVitalsMetric) => void;
export interface WebVitalsModule {
  onLCP: (report: WebVitalsReporter) => void;
  onCLS: (report: WebVitalsReporter) => void;
  onINP: (report: WebVitalsReporter) => void;
  onFCP: (report: WebVitalsReporter) => void;
  onTTFB: (report: WebVitalsReporter) => void;
}

/**
 * One buffered record stream.
 *
 * Logs and metrics get their own policy rather than sharing one, because they
 * differ by orders of magnitude in volume and by a lot in urgency. Nobody is
 * waiting on a gauge; somebody is usually waiting on an error.
 */
export interface StreamOptions {
  flushIntervalMs: number;
  batchSize: number;
}

export interface StreamsOptions {
  logs: StreamOptions;
  metrics: StreamOptions;
}

export interface StorageOptions {
  strategy: StorageStrategy;
  dbName: string;
  maxBatches: number;
  maxAgeMs: number;
  maxAttempts: number;
}

export interface RetryOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  idleDelayMs: number;
}

export interface SamplingOptions {
  defaultRate: number;
  /** by `app.namespace`, most specific prefix wins */
  rates: Record<string, number>;
  /** log types that always bypass sampling */
  alwaysSampleTypes: string[];
}

export interface JourneyOptions {
  maxAgeMs: number;
  endOnOwnerClose: boolean;
  /** query parameter searched at boot for a seeded journey token */
  urlParam: string;
}

export interface BusOptions {
  mode: BusMode;
  channelName: string;
  /** REQUIRED on any document that will receive postMessage records from a cross-origin iframe */
  trustedOrigins: string[];
  handshakeTimeoutMs: number;
  openFinHost: "provider" | "self";
  /**
   * Which OpenFin context this is. Only the platform provider answers a view's
   * handshake, so getting this wrong means every view sends for itself.
   * "auto" treats the window whose name equals its application uuid as the
   * provider, which is the usual platform convention. Set it explicitly if
   * yours names the provider differently.
   */
  openFinRole: "auto" | "provider" | "client";
  maxBootBufferRecords: number;
  /**
   * What a forwarder does when no owner answers.
   * "auto"    retry in a cross-origin frame, promote anywhere else
   * "promote" become a sender immediately
   * "retry"   retry the handshake, then promote as a last resort
   */
  orphanPolicy: "auto" | "promote" | "retry";
  /** handshake attempts before promoting under the retry policy */
  maxHandshakeAttempts: number;
}

export interface CaptureOptions {
  errors: boolean;
  rejections: boolean;
  resourceErrors: boolean;
  fetch: boolean;
  xhr: boolean;
  interactions: boolean;
  navigation: boolean;
  webVitals: boolean;
  maxBreadcrumbs: number;
  /** URLs matching these are never logged. The endpoint is always added. */
  ignoreUrls: (string | RegExp)[];
  /** Only these targets receive a `traceparent` header. Never use a catch-all. */
  propagateTraceHeaderTo: (string | RegExp)[];
  /** identical errors within this window are counted, not re-sent */
  errorDedupeMs: number;
  /**
   * Hand the library the `web-vitals` module yourself. Optional, and it exists
   * because of bundlers: a literal `import("web-vitals")` inside this package is
   * a dependency every consumer has to resolve, whether or not they ever turn
   * vitals capture on. Passing a loader keeps that import in the consumer's own
   * graph, where it is their decision.
   */
  webVitalsLoader?: () => Promise<WebVitalsModule>;
}

export interface LimitOptions {
  maxBodyChars: number;
  maxAttributeChars: number;
  maxAttributeCount: number;
  maxStackChars: number;
  maxDepth: number;
  maxArrayLength: number;
  /** whole-record attribute budget, checked after sanitize and after redact */
  maxRecordBytes: number;
}

export interface ConsoleOptions {
  enabled: boolean;
  level: LogLevel;
}

export interface ObservabilityConfig {
  /** Absolute URL of the ingest endpoint. Required. */
  endpoint: string;

  serviceName?: string;
  serviceVersion?: string;
  environment?: string;

  /** Master switch. When false, every log call is a no-op that costs one boolean check. */
  enabled?: boolean;
  /** Records below this level never leave the log call. Default "INFO". */
  minLevel?: LogLevel;

  /** Per-stream batching. `maxConcurrentRequests` below is shared by both. */
  streams?: {
    logs?: Partial<StreamOptions>;
    metrics?: Partial<StreamOptions>;
  };
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;

  compression?: "gzip" | "none";
  compressionThresholdBytes?: number;
  // Choosing a wire format is not offered yet, because no serializer
  // implementation exists to choose between. Passing this key today reports as
  // an unknown key, which is honest: nothing would read it.
  // Final form:
  //   serializer?: "otlp" | "ecs" | LogSerializer;
  credentials?: RequestCredentials;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  storage?: Partial<StorageOptions>;
  retry?: Partial<RetryOptions>;
  sampling?: Partial<SamplingOptions>;
  journey?: Partial<JourneyOptions>;
  bus?: Partial<BusOptions>;
  capture?: Partial<CaptureOptions>;
  limits?: Partial<LimitOptions>;
  console?: Partial<ConsoleOptions>;

  /** Last chance to rewrite or drop a record. Return null to drop it. */
  redact?: (record: LogRecord) => LogRecord | null;

  onDiagnostic?: DiagnosticHandler;
}

/**
 * What the runtime holds. Every section is fully populated.
 *
 * Exactly one of these objects exists per runtime, and a reconfigure mutates it
 * in place through `applyResolvedConfig`. That is deliberate: the bus, the
 * journey engine, the exit flush, the retry engine and every capture module
 * capture a reference to this object, or to one of its sections, at construction
 * and never look it up again. Replace it wholesale and all of them keep reading
 * the old settings forever.
 */
export interface ResolvedConfig {
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  enabled: boolean;
  minLevel: LogLevel;
  streams: StreamsOptions;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  compression: "gzip" | "none";
  compressionThresholdBytes: number;
  credentials: RequestCredentials;
  storage: StorageOptions;
  retry: RetryOptions;
  sampling: SamplingOptions;
  journey: JourneyOptions;
  bus: BusOptions;
  capture: CaptureOptions;
  limits: LimitOptions;
  console: ConsoleOptions;
  // The resolved serializer lands here once there is one to resolve. Nothing
  // reads this field yet, so declaring it would only mean declaring a type for
  // a value no code can produce.
  // Final form:
  //   serializer: LogSerializer;
  headers?: ObservabilityConfig["headers"];
  redact?: ObservabilityConfig["redact"];
  onDiagnostic?: DiagnosticHandler;
}

// src/models/config.ts
//
// The two faces of configuration: what a consumer may pass, and what the
// runtime actually holds.
//
// Declared separately on purpose. `ObservabilityConfig` is almost entirely
// optional so that `configure({ endpoint })` works; `ResolvedConfig` has no
// optionality left, because downstream components read it without checking.
//
// Do not derive the second with `Required<ObservabilityConfig>`. `Required<T>`
// strips `?` at the top level only, so `config.storage.maxBatches` stays
// `number | undefined` and every arithmetic use of it fails under `strict`.
// Each nested section is declared once, fully required, and appears on
// `ObservabilityConfig` as a `Partial` of itself.
//
// Every default these types take lives in `src/constants.ts`, not here.

import type { DiagnosticHandler } from "../core/diagnostics";
import type { LogLevel, LogRecord } from "./log-record";

/** Where undelivered records wait. "auto" picks the best of these that the host actually offers. */
export type StorageStrategy = "auto" | "indexeddb" | "localstorage" | "memory" | "none";

/**
 * What this context does with its records.
 *
 * A sender delivers its own; a forwarder hands them to the context that owns
 * the connection. "auto" decides by asking, which is what keeps ten iframes
 * from opening ten connections to the same endpoint.
 */
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
  /** The measurement itself, in the unit that metric is defined in. */
  value: number;
  /** "good", "needs-improvement" or "poor", where the version in use reports one. */
  rating?: string;
  /**
   * Identifies this metric instance, so a later update to it can be matched to the first report.
   */
  id: string;
}

/** The callback shape `web-vitals` invokes with a measurement. */
export type WebVitalsReporter = (metric: WebVitalsMetric) => void;

/**
 * The five `web-vitals` entry points this library subscribes to, structurally typed for the same
 * reason as the metric above.
 */
export interface WebVitalsModule {
  /** Largest Contentful Paint. */
  onLCP: (report: WebVitalsReporter) => void;
  /** Cumulative Layout Shift. */
  onCLS: (report: WebVitalsReporter) => void;
  /** Interaction to Next Paint. */
  onINP: (report: WebVitalsReporter) => void;
  /** First Contentful Paint. */
  onFCP: (report: WebVitalsReporter) => void;
  /** Time to First Byte. */
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
  /** How long a partly filled batch waits before it is sent anyway. */
  flushIntervalMs: number;
  /** How many records fill a batch, at which point it is sent without waiting. */
  batchSize: number;
}

/** The two streams, which are batched independently. */
export interface StreamsOptions {
  /** Everything from a log call or an automatic capture. */
  logs: StreamOptions;
  /** Timings, counters and web vitals. Higher volume, and nothing waits on them. */
  metrics: StreamOptions;
}

/** How undelivered records are kept across a failed send, a reload or an offline period. */
export interface StorageOptions {
  /** Which backing store to use. */
  strategy: StorageStrategy;
  /** IndexedDB database name. Only read when the strategy resolves to indexeddb. */
  dbName: string;
  /** How many batches may wait at once. The oldest are evicted past this. */
  maxBatches: number;
  /** How old a batch may get before it is dropped rather than retried. */
  maxAgeMs: number;
  /** How many delivery attempts one batch gets before it is dead-lettered. */
  maxAttempts: number;
}

/** The backoff schedule for redelivering a stored batch. */
export interface RetryOptions {
  /** First backoff step. Each further attempt doubles it. */
  baseDelayMs: number;
  /** Ceiling on the backoff, so a long outage does not push the next attempt hours away. */
  maxDelayMs: number;
  /** How often to look for stored work when nothing has failed recently. */
  idleDelayMs: number;
}

/** Which records survive, and which are dropped before they ever cost a byte. */
export interface SamplingOptions {
  /** Fraction of records kept, 0 to 1, where no more specific rate applies. */
  defaultRate: number;
  /** by `app.namespace`, most specific prefix wins */
  rates: Record<string, number>;
  /** log types that always bypass sampling */
  alwaysSampleTypes: string[];
}

/** A journey is one user task spanning several contexts, and these are its lifetime rules. */
export interface JourneyOptions {
  /** How long a journey may stay open before it is treated as abandoned. */
  maxAgeMs: number;
  /** Whether closing the context that started the journey ends it for everyone. */
  endOnOwnerClose: boolean;
  /** query parameter searched at boot for a seeded journey token */
  urlParam: string;
}

/** How this context finds, trusts and talks to the other contexts on the page or the desktop. */
export interface BusOptions {
  /** Whether this context sends for itself, forwards to an owner, or stays off. */
  mode: BusMode;
  /**
   * BroadcastChannel name for the control plane. Change it only to isolate two applications sharing
   * an origin.
   */
  channelName: string;
  /** REQUIRED on any document that will receive postMessage records from a cross-origin iframe */
  trustedOrigins: string[];
  /** How long a forwarder waits for an owner to answer before applying the orphan policy. */
  handshakeTimeoutMs: number;
  /** Which OpenFin context owns delivery. */
  openFinHost: "provider" | "self";
  /**
   * Which OpenFin context this is. Only the platform provider answers a view's
   * handshake, so getting this wrong means every view sends for itself.
   * "auto" treats the window whose name equals its application uuid as the
   * provider, which is the usual platform convention. Set it explicitly if
   * yours names the provider differently.
   */
  openFinRole: "auto" | "provider" | "client";
  /** How many records a context may buffer while it is still working out who it is. */
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

/**
 * What the library instruments on the consumer's behalf. Everything beyond errors is off until
 * asked for.
 */
export interface CaptureOptions {
  /** Log uncaught errors from `window.onerror`. */
  errors: boolean;
  /** Log unhandled promise rejections. */
  rejections: boolean;
  /** Log failed image, script and stylesheet loads. Noisy on pages with third-party content. */
  resourceErrors: boolean;
  /** Wrap `fetch` to log requests. The endpoint itself is never logged, whatever this says. */
  fetch: boolean;
  /** Wrap `XMLHttpRequest` to log requests. */
  xhr: boolean;
  /** Log clicks and other interactions as breadcrumbs. */
  interactions: boolean;
  /** Log route changes, including the ones a single page application makes without a page load. */
  navigation: boolean;
  /** Report web vitals as metrics. Needs the `web-vitals` peer, or a loader below. */
  webVitals: boolean;
  /** How many breadcrumbs to keep as context for the next error. */
  maxBreadcrumbs: number;
  /** URLs matching these are never logged. The endpoint is always added. */
  ignoreUrls: (string | RegExp)[];
  /** Only these targets receive a `traceparent` header. Never use a catch-all. */
  propagateTraceHeaderTo: (string | RegExp)[];
  /** identical errors within this window are counted, not re-sent */
  errorDedupeMs: number;
  /**
   * Hand the library the `web-vitals` module yourself. A literal
   * `import("web-vitals")` inside this package is a dependency every consumer
   * has to resolve, used or not; a loader keeps that import in their graph.
   */
  webVitalsLoader?: () => Promise<WebVitalsModule>;
}

/** The size ceilings that keep one hostile value from costing a whole batch. */
export interface LimitOptions {
  /** Longest a record body may be. */
  maxBodyChars: number;
  /** Longest a single string attribute may be. */
  maxAttributeChars: number;
  /** How many attributes one record may carry. */
  maxAttributeCount: number;
  /**
   * Longest a stack trace may be. Larger than an attribute, because a truncated stack is often a
   * useless one.
   */
  maxStackChars: number;
  /** How far into a nested value to walk before replacing the rest with a marker. */
  maxDepth: number;
  /** How many items of an array, set or map to keep. */
  maxArrayLength: number;
  /** whole-record attribute budget, checked after sanitize and after redact */
  maxRecordBytes: number;
}

/** Mirroring records to the host console, which is for development rather than production. */
export interface ConsoleOptions {
  /** Whether to mirror at all. */
  enabled: boolean;
  /**
   * Minimum level to mirror. Independent of `minLevel`, so the console can be noisier than the
   * wire.
   */
  level: LogLevel;
}

/**
 * What a consumer passes to `configure()`.
 *
 * Everything but the endpoint is optional, and a second call merges onto the
 * config already in force rather than back onto the defaults.
 */
export interface ObservabilityConfig {
  /** Absolute URL of the ingest endpoint. Required. */
  endpoint: string;

  /** Reported as `service.name`. Missing means every record says "unknown-service". */
  serviceName?: string;
  /**
   * Reported as `service.version`. Worth wiring to the build's version, since it is what makes a
   * regression datable.
   */
  serviceVersion?: string;
  /** Reported as `deployment.environment`, for splitting production from everything else. */
  environment?: string;

  /** Master switch. When false, every log call is a no-op that costs one boolean check. */
  enabled?: boolean;
  /** Records below this level never leave the log call. Default "INFO". */
  minLevel?: LogLevel;

  /** Per-stream batching. `maxConcurrentRequests` below is shared by both. */
  streams?: {
    /** Batching for the log stream. */
    logs?: Partial<StreamOptions>;
    /** Batching for the metric stream. */
    metrics?: Partial<StreamOptions>;
  };
  /** How many ingest requests may be in flight at once, across both streams. */
  maxConcurrentRequests?: number;
  /** How long one ingest request may take before it is aborted and retried. */
  requestTimeoutMs?: number;

  /**
   * Whether to gzip a payload past the threshold below, where the host offers compression at all.
   */
  compression?: "gzip" | "none";
  /**
   * Payloads smaller than this are sent uncompressed, since compressing them costs more than it
   * saves.
   */
  compressionThresholdBytes?: number;
  // Not offered yet: the serializers exist, but nothing reads a resolved one
  // until the transport lands. Passing this key today reports as unknown.
  // Final form:
  //   serializer?: "otlp" | "ecs" | LogSerializer;
  /**
   * Passed to `fetch`. "include" is the default, because an ingest endpoint behind a session cookie
   * is the common case.
   */
  credentials?: RequestCredentials;
  /**
   * Extra request headers, or a function returning them. Use the function form for anything that
   * expires, such as a token.
   */
  headers?:
    Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  /** Where undelivered records wait. */
  storage?: Partial<StorageOptions>;
  /** Backoff schedule for redelivering them. */
  retry?: Partial<RetryOptions>;
  /** Which records survive at all. */
  sampling?: Partial<SamplingOptions>;
  /** Lifetime rules for a multi-context user journey. */
  journey?: Partial<JourneyOptions>;
  /** How this context talks to the others, and whose messages it believes. */
  bus?: Partial<BusOptions>;
  /** What is instrumented automatically. */
  capture?: Partial<CaptureOptions>;
  /** Size ceilings applied to every record. */
  limits?: Partial<LimitOptions>;
  /** Console mirroring, for development. */
  console?: Partial<ConsoleOptions>;

  /** Last chance to rewrite or drop a record. Return null to drop it. */
  redact?: (record: LogRecord) => LogRecord | null;

  /**
   * Where this library reports its own faults. Wire it up early: without it, a misconfiguration is
   * silent.
   */
  onDiagnostic?: DiagnosticHandler;
}

/**
 * What the runtime holds. Every section is fully populated; the field meanings
 * are the ones documented on `ObservabilityConfig` and each section above.
 *
 * One object per runtime, mutated in place by `applyResolvedConfig`. The bus,
 * the journey engine, the exit flush, the retry engine and every capture module
 * hold a reference to it or to one of its sections from construction, so
 * replacing it wholesale leaves all of them on the old settings.
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
  // The resolved serializer lands here with the transport that reads it.
  // Final form:
  //   serializer: LogSerializer;
  headers?: ObservabilityConfig["headers"];
  redact?: ObservabilityConfig["redact"];
  onDiagnostic?: DiagnosticHandler;
}

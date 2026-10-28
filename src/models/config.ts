// src/models/config.ts
//
// Configuration types. `ObservabilityConfig` is the input to `configure()`.
// `ResolvedConfig` is the configuration that the runtime holds after it applies defaults.
//
// `ResolvedConfig` does not use `Required<ObservabilityConfig>`. That type removes `?`
// only at the top level. A nested field such as `sampling.defaultRate` can then hold undefined.

import type { DiagnosticHandler } from "../core/diagnostics";
import type { LogLevel, LogRecord } from "./log-record";
import type { LogSerializer } from "./serializer";

/** Backing store for undelivered records. "auto" picks the best one the host supports. */
export type StorageStrategy = "auto" | "indexeddb" | "localstorage" | "memory" | "none";

/** Selects where the library keeps session, tab and journey ids. "storage" uses browser storage. "memory" writes nothing. */
export type IdentityStrategy = "storage" | "memory";

/**
 * What this context does with its records. `sender` delivers its own records.
 * `forwarder` gives them to another context. `auto` selects a role at startup.
 * `off` turns off the bus. The context then delivers its own records.
 */
export type BusMode = "auto" | "sender" | "forwarder" | "off";

/**
 * Structural type for the metric shape of the `web-vitals` package. With this type,
 * the library has no hard dependency on the package.
 */
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
 * @param metric The measurement that `web-vitals` reports.
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

/** W3C context an active OpenTelemetry span reports. */
export interface OtelSpanContext {
  /** Hexadecimal 32-character W3C trace identifier. */
  traceId: string;
  /** Hexadecimal 16-character W3C span identifier. */
  spanId: string;
  /** Bitfield byte containing W3C trace flags. */
  traceFlags: number;
}

/** The span the host has made active. */
export interface OtelSpan {
  /**
   * Reads this span's W3C context.
   * @returns Trace and span ids with their flags.
   */
  spanContext(): OtelSpanContext;
}

/**
 * The three `@opentelemetry/api` entry points that this library uses. The structural
 * types keep the package an optional peer.
 */
export interface OtelApi {
  /** Span lookup. */
  trace: {
    /**
     * Reads the span the host has made active.
     * @returns Active span, or undefined when there is none.
     */
    getActiveSpan(): OtelSpan | undefined;
  };
  /** Ambient context lookup. */
  context: {
    /**
     * Reads the active context.
     * @returns Context object that only the propagator reads.
     */
    active(): unknown;
  };
  /** Header propagation. */
  propagation: {
    /**
     * Writes the host's trace headers into a carrier.
     * @param context Context to propagate.
     * @param carrier Header map written in place.
     */
    inject(context: unknown, carrier: Record<string, string>): void;
  };
}

/**
 * Supplies the `@opentelemetry/api` module without a hard dependency on it.
 * @returns A promise that resolves to the module.
 */
export type OtelLoader = () => Promise<OtelApi>;

/** Sampling policy. It controls which records the library keeps. */
export interface SamplingOptions {
  /**
   * Default fraction of records kept, 0 to 1.
   * @default 1
   */
  defaultRate: number;
  /**
   * Rate override for each namespace, keyed by `app.namespace`. The most specific prefix applies.
   * @default {}
   */
  rates: Record<string, number>;
  /**
   * Log types always kept, regardless of the sampling rate.
   * @default ["action"]
   */
  alwaysSampleTypes: string[];
  /**
   * Read sampling rules from the `X-UiObs-Sampling` header of each accepted batch.
   * The rules stay in force for their `ttlMs`. Set it in each context of the page.
   * @default false
   */
  remote: boolean;
  /**
   * Highest rate that a remote rule can set, 0 to 1. It applies to `defaultRate` and each namespace rate.
   * @default 1
   */
  remoteMaxRate: number;
}

/** Bus settings. They control how this context finds, trusts, and sends messages to others. */
export interface BusOptions {
  /**
   * This context's role.
   * @default "auto"
   */
  mode: BusMode;
  /**
   * Origins that can send postMessage records to this document.
   * A document that gets records from a cross-origin iframe must list the iframe origin.
   * The library does not accept "null". A sandboxed frame must set `mode: "sender"`.
   * @default []
   */
  trustedOrigins: string[];
  /**
   * Which OpenFin context this is. Only the platform provider answers a handshake.
   * With an incorrect value, each view sends its own records. "auto" treats the
   * window whose name equals its application uuid as the provider.
   * @default "auto"
   */
  openFinRole: "auto" | "provider" | "client";
}

/**
 * Where a journey id applies.
 * - "context": each document, frame or worker keeps its own journey.
 * - "tab": a frame or a worker adopts the journey of the context that owns it. A journey
 *   does not go to another tab.
 * - "origin": each context of the origin adopts each journey. The broadcast link also reaches
 *   other tabs.
 * - "auto": "origin" in OpenFin and "tab" in a browser.
 */
export type JourneyScope = "auto" | "context" | "tab" | "origin";

/** Journey settings. */
export interface JourneyOptions {
  /**
   * Which contexts adopt a journey that one context starts.
   * @default "auto"
   */
  scope: JourneyScope;
}

/** Console method that the console capture can wrap. */
export type CapturedConsoleMethod = "error" | "warn" | "info" | "log";

/**
 * What the library instruments automatically. By default, only `errors` and `rejections`
 * are on.
 */
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
   * Wrap `fetch` to log requests. The library never logs requests to the ingest endpoint.
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
   * Report web vitals as metrics. This option requires `webVitalsLoader`.
   * @default false
   */
  webVitals: boolean;
  /**
   * Report long animation frames as the histogram `ui.long_frame.duration`. A long frame
   * freezes the page. Browsers without `long-animation-frame` report `longtask` entries.
   * @default false
   */
  longFrames: boolean;
  /**
   * Minimum frame duration that `longFrames` reports, in milliseconds.
   * @default 100
   */
  longFrameThresholdMs: number;
  /**
   * Record the app's console calls. `true` wraps `error` and `warn`. A list selects the methods.
   * `error` gives an ERROR record and `warn` gives a WARN record.
   * `info` and `log` give a breadcrumb only.
   * @default false
   */
  console: boolean | CapturedConsoleMethod[];
  /**
   * Keep the query string and fragment on every URL the library records.
   * When off, the library removes them from page URLs, request targets and failed resource URLs.
   * @default false
   */
  fullUrls: boolean;
  /**
   * URLs that the library does not log. The library always adds the ingest endpoint.
   * @default []
   */
  ignoreUrls: (string | RegExp)[];
  /**
   * Targets that receive a `traceparent` header. A string is an origin and matches a request
   * to that origin only. A RegExp tests the full URL. Start each RegExp with `^`. A pattern that
   * matches all URLs breaks CORS on third-party endpoints.
   * @default []
   */
  propagateTraceHeaderTo: (string | RegExp)[];
  /**
   * Supplies the `web-vitals` module without a hard dependency on the package.
   * @returns A promise that resolves to the `web-vitals` module.
   */
  webVitalsLoader?: () => Promise<WebVitalsModule>;
}

/** Serializer option after resolution. A name stays a name. The transport selects the implementation. */
export type SerializerChoice = "otlp" | "ecs" | LogSerializer;

/** Part of the console prefix that a style applies to: the namespace or one level. */
export type ConsoleStyleKey = "namespace" | LogLevel;

/**
 * CSS for each part of the console prefix, for example `"color:#0a7;font-weight:bold"`.
 * A browser applies it with `%c`. Node prints the text without the style.
 */
export type ConsoleStyles = Partial<Record<ConsoleStyleKey, string>>;

/** Object form of the console option. */
export interface ConsoleOptions {
  /**
   * Lowest level that the console prints. If you do not set it, the level in force stays.
   * If no level is in force, the console prints from DEBUG up.
   */
  level?: LogLevel;
  /** CSS for the namespace and for each level. A key that you do not set keeps its style. */
  styles?: ConsoleStyles;
}

/**
 * Console mirroring. `false` turns it off. `true` prints records at DEBUG and above.
 * A level prints records at that level and above. An object sets the level and the styles.
 */
export type ConsoleOption = boolean | LogLevel | ConsoleOptions;

/** Console settings after resolution. */
export interface ResolvedConsole {
  /** Lowest level that the console prints, or null when the console is off. */
  level: LogLevel | null;
  /** CSS for the namespace and for each level. */
  styles: Required<ConsoleStyles>;
}

/** One batch that the library gives to a custom transport. */
export interface TransportRequest {
  /** Serialized batch from the configured serializer. The library does not compress it. */
  body: string;
  /** Content type of `body`, from the serializer. */
  contentType: string;
  /** Batch id. Send it to the server for deduplication, for example as `X-UiObs-Batch-Id`. */
  batchId: string;
  /** Number of earlier send attempts. It is 0 for the first send. */
  attempt: number;
  /** Built records after `redact`. Do not change them. The retry engine can send them again. */
  records: readonly LogRecord[];
}

/** Answer of a custom transport. The status code has the meaning of the ingest contract. */
export interface TransportResponse {
  /**
   * HTTP-like status code. 2xx accepts the batch. 413 splits it. 429 and 503 throttle.
   * 408 and 5xx retry. Each other code drops the batch.
   */
  status: number;
  /** Delay before the next send, for 429 and 503, in milliseconds. */
  retryAfterMs?: number;
  /** Largest payload that the server accepts, for 413, in bytes. */
  maxBytes?: number;
  /**
   * Sampling rules for a 2xx answer, as the header text or as a parsed object.
   * The library reads it only with `sampling.remote`.
   */
  sampling?: unknown;
}

/**
 * Sends one batch through a channel of the app, such as an API client, a WebSocket or IPC.
 * A rejected promise counts as a network error. The library then sends the batch again.
 * @param request Batch to send.
 * @returns Promise that resolves to the answer of the server.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * Sends one batch while the page closes. It must not wait for a promise.
 * @param request Batch to send.
 * @returns True if the channel accepted the batch. False puts the batch in the emergency queue.
 */
export type ExitTransport = (request: TransportRequest) => boolean;

/** Options passed to `configure()`. */
export interface ObservabilityConfig {
  /**
   * Ingest endpoint URL. Set `null` for console-only mode.
   * In console-only mode, the library sends nothing. It writes records to the console
   * if you set `console`.
   * If the key is missing or `""`, the library reports `config.invalid`.
   */
  endpoint?: string | null;

  /**
   * The library reports this value as `service.name`.
   * @default ""
   */
  serviceName?: string;
  /**
   * The library reports this value as `service.version`.
   * @default ""
   */
  serviceVersion?: string;
  /**
   * The library reports this value as `deployment.environment`.
   * @default ""
   */
  environment?: string;

  /**
   * Master switch. With false, each log call does nothing.
   * @default true
   */
  enabled?: boolean;
  /**
   * Minimum level that the library logs.
   * @default "INFO"
   */
  minLevel?: LogLevel;

  /**
   * Set "gzip" to compress a payload that is larger than the compression threshold.
   * Set "none" for an ingest endpoint that rejects gzip.
   * @default "gzip"
   */
  compression?: "gzip" | "none";
  /**
   * Payload format. Give a name or a custom implementation.
   * @default "otlp"
   */
  serializer?: SerializerChoice;
  /**
   * The library passes this value to `fetch`. Set "include" for an ingest endpoint that
   * authenticates with cookies.
   * @default "omit"
   */
  credentials?: RequestCredentials;
  /** Extra request headers, or a function returning them. `undefined` removes the headers. */
  headers?:
    Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  /**
   * Backing store for undelivered records.
   * @default "auto"
   */
  storage?: StorageStrategy;
  /**
   * Selects where the library keeps session, tab and journey ids.
   * Set "memory" to write no key to localStorage or sessionStorage.
   * With "memory", each page load starts a new session.
   * You cannot change this value after startup.
   * @default "storage"
   */
  identity?: IdentityStrategy;
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
   * Journey settings.
   * @see {@link JourneyOptions}
   */
  journey?: Partial<JourneyOptions>;
  /**
   * Automatic instrumentation.
   * @see {@link CaptureOptions}
   */
  capture?: Partial<CaptureOptions>;
  /**
   * Console mirroring. The line format is `[namespace][LEVEL] message`.
   * @default false
   */
  console?: ConsoleOption;

  /**
   * Sends batches through a channel of the app in place of HTTP. With `transport`, `endpoint`
   * is optional. The library does not compress the body for a custom transport.
   * @see {@link Transport}
   */
  transport?: Transport;
  /**
   * Sends the last batch while the page closes, for a custom transport. Without it, the
   * library puts that batch in the emergency queue. The next page load sends it.
   * @see {@link ExitTransport}
   */
  transportOnExit?: ExitTransport;

  /**
   * Loads the `@opentelemetry/api` module. Example: `() => import("@opentelemetry/api")`.
   * If you do not set it, OTel is off.
   * @see {@link OtelLoader}
   */
  otelLoader?: OtelLoader;

  /**
   * Rewrites or drops a record before the library sends it. If the hook throws or returns a
   * value that is not a record, the library drops the record.
   * @param record The record that the library is about to send.
   * @returns The record to send, or `null` to drop it.
   */
  redact?: (record: LogRecord) => LogRecord | null;

  /**
   * Reports this library's own faults.
   * @see {@link DiagnosticHandler}
   */
  onDiagnostic?: DiagnosticHandler;
}

/** Fully resolved configuration that the runtime holds. */
export interface ResolvedConfig {
  /** Ingest endpoint URL, or null in console-only mode. */
  endpoint: string | null;
  /** The library reports this value as `service.name`. */
  serviceName: string;
  /** The library reports this value as `service.version`. */
  serviceVersion: string;
  /** The library reports this value as `deployment.environment`. */
  environment: string;
  /** Master switch. With false, each log call does nothing. */
  enabled: boolean;
  /** Minimum level that the library logs. */
  minLevel: LogLevel;
  /** "gzip" compresses a payload that is larger than the compression threshold. */
  compression: "gzip" | "none";
  /** The library passes this value to `fetch`. */
  credentials: RequestCredentials;
  /** Backing store for undelivered records. */
  storage: StorageStrategy;
  /** Store for session, tab and journey ids. */
  identity: IdentityStrategy;
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
   * Journey settings.
   * @see {@link JourneyOptions}
   */
  journey: JourneyOptions;
  /**
   * Automatic instrumentation.
   * @see {@link CaptureOptions}
   */
  capture: CaptureOptions;
  /** Console level and styles. */
  console: ResolvedConsole;
  /** Payload format name, or a custom implementation. */
  serializer: SerializerChoice;
  /** Extra request headers, or a function returning them. */
  headers?: ObservabilityConfig["headers"];
  /** Sends batches through a channel of the app in place of HTTP. */
  transport?: Transport;
  /** Sends the last batch while the page closes, for a custom transport. */
  transportOnExit?: ExitTransport;
  /** Supplies the `@opentelemetry/api` module in place of importing it. */
  otelLoader?: OtelLoader;
  /**
   * Rewrites or drops a record before the library sends it.
   * @param record The record that the library is about to send.
   * @returns The record to send, or `null` to drop it.
   */
  redact?: ObservabilityConfig["redact"];
  /**
   * Reports this library's own faults.
   * @see {@link DiagnosticHandler}
   */
  onDiagnostic?: DiagnosticHandler;
}

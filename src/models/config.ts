// src/models/config.ts
//
// Configuration types. `ObservabilityConfig` is the input to `configure()`, and
// `ResolvedConfig` is what the runtime holds once the defaults are applied.
//
// `ResolvedConfig` doesn't use `Required<ObservabilityConfig>`, because that type removes `?`
// only at the top level. A nested field such as `sampling.defaultRate` could still be undefined.

import type { REMOTE_CAPTURE_FLAGS } from "../constants";
import type { DiagnosticCode, DiagnosticHandler } from "../core/diagnostics";
import type { DropSummary } from "./drop";
import type { LogLevel, LogRecord, LogType } from "./log-record";
import type { CapturePlugin } from "./plugin";
import type { ReplayLoader, ReplayMode, ReplayPluginLoader, ReplaySegment } from "./replay";
import type { LogSerializer } from "./serializer";

/** Backing store for undelivered records. "auto" picks the best one the host supports. */
export type StorageStrategy = "auto" | "indexeddb" | "localstorage" | "memory" | "none";

/**
 * Where the library keeps session, tab and journey ids. "storage" uses browser storage and
 * "memory" writes nothing.
 */
export type IdentityStrategy = "storage" | "memory";

/**
 * What this context does with its records. `sender` delivers its own records, `forwarder`
 * hands them to another context, and `auto` picks a role at startup. `off` turns the bus off,
 * so the context delivers its own records.
 */
export type BusMode = "auto" | "sender" | "forwarder" | "off";

/**
 * Structural type for the metric shape of the `web-vitals` package, so the library has no
 * hard dependency on it.
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

/** Sampling policy. Controls which records the library keeps. */
export interface SamplingOptions {
  /**
   * Default fraction of records kept, 0 to 1.
   * @default 1
   */
  defaultRate: number;
  /**
   * Per-namespace rate overrides, keyed by `app.namespace`. The most specific prefix wins. A
   * new map replaces the current one. A rate outside 0 to 1 is left out with a report, so a
   * shorter prefix or `defaultRate` applies.
   * @default {}
   */
  rates: Record<string, number>;
  /**
   * Log types always kept, regardless of the sampling rate.
   * @default ["action"]
   */
  alwaysSampleTypes: LogType[];
  /**
   * Lowest level that the sampling rate never drops. `errorCeiling` limits the log records at
   * this level and higher.
   * @default "ERROR"
   */
  alwaysSampleFrom: LogLevel;
  /**
   * Maximum log records at or above `alwaysSampleFrom` in one `errorCeilingWindowMs` window.
   * Metric points and spans do not count. Set 0 to drop every one, or null for no limit.
   * @default 500
   */
  errorCeiling: number | null;
  /**
   * Length of the `errorCeiling` window, in milliseconds, 1 or more.
   * @default 10000
   */
  errorCeilingWindowMs: number;
  /**
   * Read sampling rules from the `X-UiObs-Sampling` header of every accepted batch. The rules
   * stay in effect for their `ttlMs`. Set this in every context on the page.
   * @default false
   */
  remote: boolean;
  /**
   * Highest rate a remote rule can set, 0 to 1. Applies to `defaultRate` and to every
   * namespace rate.
   * @default 1
   */
  remoteMaxRate: number;
}

/** Bus settings. Controls how this context finds, trusts and sends messages to others. */
export interface BusOptions {
  /**
   * Which child windows are accepted. "registered" requires a window registration, while
   * "trusted-origin" accepts child windows from a trusted origin.
   * @default "registered"
   */
  sourcePolicy: "registered" | "trusted-origin";
  /**
   * Maximum encoded bytes in one message, 1 or more. Set null for no size limit.
   * @default 262144
   */
  maxMessageBytes: number | null;
  /**
   * Maximum records in one message, 1 or more. Set null for no record limit.
   * @default 100
   */
  maxRecordsPerMessage: number | null;
  /**
   * Maximum messages from one source in one second, 1 or more. Set null for no rate limit.
   * @default 100
   */
  maxMessagesPerSecond: number | null;
  /**
   * This context's role. Can't be changed after startup.
   * @default "auto"
   */
  mode: BusMode;
  /**
   * Additional trusted parent origins. With sourcePolicy "trusted-origin", the list also
   * permits child origins. A registered child uses the exact origin from its registration.
   * "null" is never accepted, so a sandboxed frame must set `mode: "sender"`. A new entry
   * doesn't reconnect a parent link that already exists.
   * @default []
   */
  trustedOrigins: string[];
  /**
   * Which OpenFin context this is. Only the platform provider answers a handshake, so with
   * the wrong value every view sends its own records. "auto" treats the window whose name
   * equals its application uuid as the provider. Can't be changed after startup.
   * @default "auto"
   */
  openFinRole: "auto" | "provider" | "client";
}

/**
 * Where a journey id applies.
 * - "context": every document, frame or worker keeps its own journey.
 * - "tab": a frame or worker adopts the journey of the context that owns it. A journey never
 *   crosses to another tab.
 * - "origin": every context on the origin adopts every journey. The broadcast link also
 *   reaches other tabs.
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
  /**
   * How long a journey can stay open, in milliseconds, before the library ends it. 1 minute
   * to 24 hours. Can't be changed after startup.
   * @default 1800000
   */
  maxAgeMs: number;
}

/**
 * Batch sizes, and the flush interval of log and span batches. The log keys also apply to spans.
 * A metric batch waits `metrics.intervalMs`. Can't be changed after startup.
 */
export interface BatchingOptions {
  /**
   * How long a partial log or span batch waits before it is sent, in milliseconds. 100 to 60000.
   * @default 2000
   */
  logFlushIntervalMs: number;
  /**
   * Maximum records in one log or span batch. 1 to 1000.
   * @default 100
   */
  logBatchSize: number;
  /**
   * Maximum records in one metric batch. 1 to 1000.
   * @default 500
   */
  metricBatchSize: number;
}

/**
 * Retention of undelivered batches. Can't be changed after startup. To keep a batch until it is
 * delivered, set `maxAgeMs` and `maxAttempts` to null. `maxBatches` still applies, and a
 * permanent error still drops the batch.
 */
export interface RetentionOptions {
  /**
   * Maximum stored batches. A new batch evicts the oldest batch that holds no action first.
   * 1 to 5000.
   * @default 500
   */
  maxBatches: number;
  /**
   * Maximum age of a stored batch, in milliseconds. 1 minute to 7 days. Set null for no age
   * limit.
   * @default 86400000
   */
  maxAgeMs: number | null;
  /**
   * Maximum send attempts for a stored batch. 1 to 20. Set null for no attempt limit.
   * @default 5
   */
  maxAttempts: number | null;
}

/** Size limits for each record. Can't be changed after startup. */
export interface LimitsOptions {
  /**
   * Maximum body length, in characters. 256 to 65536.
   * @default 4096
   */
  maxBodyChars: number;
  /**
   * Maximum length of a string attribute, in characters. 256 to 65536.
   * @default 8192
   */
  maxAttributeChars: number;
  /**
   * Maximum keys in one object. 1 to 1024.
   * @default 128
   */
  maxAttributeCount: number;
  /**
   * Maximum length of an error stack, in characters. 256 to 65536.
   * @default 8192
   */
  maxStackChars: number;
  /**
   * Maximum depth of a nested value. 1 to 16.
   * @default 6
   */
  maxDepth: number;
  /**
   * Maximum items in one array, set or map. 1 to 10000.
   * @default 100
   */
  maxArrayLength: number;
  /**
   * Maximum values in one sanitize pass. 100 to 100000.
   * @default 10000
   */
  maxNodes: number;
  /**
   * Maximum attribute bytes in one record. Above that, the library drops the caller's
   * attributes. 1024 to 60000.
   * @default 32768
   */
  maxRecordBytes: number;
}

/** Console method that the console capture can wrap. */
export type CapturedConsoleMethod = "error" | "warn" | "info" | "log";

/** Console capture settings. An object turns the capture on, and true uses the defaults below. */
export interface ConsoleCaptureOptions {
  /**
   * Console methods to wrap. `error` produces an ERROR record and `warn` a WARN record, while
   * `info` and `log` only add a breadcrumb. An empty list wraps nothing.
   * @default ["error", "warn"]
   */
  levels?: CapturedConsoleMethod[];
}

/** Long frame settings. An object turns the capture on, and true uses the defaults below. */
export interface LongFramesOptions {
  /**
   * Minimum frame duration to report, in milliseconds, 0 or more.
   * @default 100
   */
  thresholdMs?: number;
}

/** User timing settings. An object turns the capture on, and true uses the defaults below. */
export interface UserTimingOptions {
  /**
   * Names of the marks and measures to record, as strings and RegExp patterns. A string matches
   * any part of the name. An empty list records every name.
   * @default []
   */
  include?: (string | RegExp)[];
}

/** Web vitals settings. An object turns the capture on, and true uses the defaults below. */
export interface WebVitalsOptions {
  /**
   * Supplies the `web-vitals` module without a hard dependency on the package, for example
   * `() => import("web-vitals")`. Without it, the library reports `config.invalid` and records
   * only the navigation timing. Set null to remove it.
   * @returns A promise that resolves to the `web-vitals` module.
   */
  loader?: (() => Promise<WebVitalsModule>) | null;
}

/** Resource timing settings. Passing an object turns the capture on. */
export interface ResourceTimingOptions {
  /**
   * Minimum duration for a ui.resource.slow event, in milliseconds. Set 0 for no slow events.
   * @default 1000
   */
  slowMs?: number;
}

/** Capture switch that a remote rule can change. */
export type RemoteCaptureFlag = (typeof REMOTE_CAPTURE_FLAGS)[number];

/** Click settings. An object turns the capture on, and true uses the defaults below. */
export interface InteractionOptions {
  /**
   * Record the clicked element's textContent.
   * @default false
   */
  text?: boolean;
  /**
   * Record a DOM selector. Its attributes can identify a user or an account.
   * @default false
   */
  selector?: boolean;
  /**
   * CSS selector for regions to exclude. Set null to include all regions. Session replay always
   * blocks `[data-observability-ignore]`, whatever this value is.
   * @default "[data-observability-ignore]"
   */
  ignoreSelector?: string | null;
  /**
   * Maximum click text length, in characters.
   * @default 50
   */
  maxTextChars?: number;
  /**
   * Attribute that names the click action, for example "data-testid". The closest element
   * that has it supplies the breadcrumb message. Use letters, digits, hyphens and underscores.
   * @default "data-observability-action"
   */
  actionAttribute?: string;
  /**
   * Record one `ui.rage_click` event for every burst of `rageClickCount` clicks on one element
   * within `rageClickWindowMs`. The event carries the action name and the click count.
   * @default false
   */
  rageClicks?: boolean;
  /**
   * Number of clicks that count as a rage click. 2 to 20.
   * @default 3
   */
  rageClickCount?: number;
  /**
   * Time window that the clicks of a rage click must fall in, in milliseconds. 100 to 10000.
   * @default 1000
   */
  rageClickWindowMs?: number;
  /**
   * Record a `ui.dead_click` event when a click on a control causes no DOM change, no
   * navigation and no scroll within `deadClickMs`. The event carries only the action name. A
   * click on a `target="_blank"` or `download` link produces no event.
   * @default false
   */
  deadClicks?: boolean;
  /**
   * How long to wait for a visible response to a click, in milliseconds. 100 to 10000.
   * @default 1000
   */
  deadClickMs?: number;
}

/** Cache settings. A logger the app still holds keeps working after it leaves the cache. */
export interface LoggerCacheOptions {
  /**
   * Maximum cached loggers. The least recently used logger is removed first. Set 0 for no
   * cache. Set null for no cache limit.
   * @default 256
   */
  maxEntries: number | null;
}

/** Identity of one delivery context. Do not put secrets or personal data in the id. */
export interface SecurityContextOptions {
  /** Stable id for delivery after a page reload. With an empty id, the runtime creates one. */
  id: string;
  /**
   * Keep stored batches in separate contexts. When true, change the routing settings through
   * rotateSecurityContext() instead of configure().
   * @default true
   */
  isolation: boolean;
}

/**
 * Routing settings: where records go and how a request authenticates. The runtime replaces
 * them together when the security context changes.
 */
export type RoutingOptions = Pick<
  ObservabilityConfig,
  | "endpoint"
  | "metricsEndpoint"
  | "tracesEndpoint"
  | "headers"
  | "credentials"
  | "transport"
  | "transportOnExit"
  | "transportWorker"
>;

/** New security context. Any routing field that is left out or undefined resets to its default. */
export interface SecurityContextUpdate {
  /** New delivery context id. If omitted, the runtime creates one. */
  id?: string;
  /**
   * New routing settings. Any field that is left out or undefined resets to its default, unlike
   * configure(), because a rotation must not carry an old token into the new context. A key that
   * isn't a routing setting reports `config.invalid` and the rotation ignores it, so the other
   * settings stay.
   */
  routing: RoutingOptions;
  /** New ambient attributes. If omitted, the runtime removes the old ones. */
  context?: Record<string, unknown>;
}

/** Policy for old records. */
export interface SecurityContextRotationOptions {
  /**
   * What to do with old records. "discard" removes them, and "flush" tries to deliver them
   * before it removes them. "retain" keeps them in the old context, and "carry" moves them to
   * the new context.
   * @default "discard"
   */
  pending?: "discard" | "flush" | "retain" | "carry";
  /**
   * How long to wait for the old records to flush, in milliseconds. 0 to 600000. A value
   * outside the range rejects the rotation.
   * @default 5000
   */
  timeoutMs?: number;
}

/**
 * What the library instruments automatically. By default, only `errors` and `rejections`
 * are on. A capture that takes an options object also takes true for its defaults.
 */
export interface CaptureOptions {
  /**
   * Rewrites a URL before the capture records it. Applies to page, HTTP, resource and
   * WebSocket URLs.
   * Set null to remove it.
   * @param url Original URL, before the default URL changes.
   * @returns URL to record. Null, an invalid result or an exception produces an empty URL.
   */
  urlTransform?: ((url: string) => string | null) | null;
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
   * Record the `http.client.request.duration` histogram for every request the `fetch` or
   * `xhr` capture sees. The histogram is in seconds.
   * @default true
   */
  httpMetrics: boolean;
  /**
   * Log clicks and other interactions as breadcrumbs.
   * @default false
   */
  interactions: boolean | InteractionOptions;
  /**
   * Log route changes, including single-page-application navigation.
   * @default false
   */
  navigation: boolean;
  /**
   * Report web vitals as metrics, and the navigation timing. LCP, CLS and INP need a loader.
   * @default false
   */
  webVitals: boolean | WebVitalsOptions;
  /**
   * Report long animation frames as the `ui.long_frame.duration` histogram. A long frame
   * freezes the page. Browsers without `long-animation-frame` report `longtask` entries.
   * @default false
   */
  longFrames: boolean | LongFramesOptions;
  /**
   * Record the app's console calls. `true` wraps `error` and `warn`, and `levels` picks the
   * methods.
   * @default false
   */
  console: boolean | ConsoleCaptureOptions;
  /**
   * Keep the query string and fragment on every URL the library records. When off, they are
   * removed from page URLs, request targets and failed resource URLs.
   * @default false
   */
  fullUrls: boolean;
  /**
   * URLs the library doesn't log. The ingest endpoint is always included.
   * @default []
   */
  ignoreUrls: (string | RegExp)[];
  /**
   * Targets that receive a `traceparent` header. A string is an origin and matches only
   * requests to that origin. A RegExp tests the full URL. Start every RegExp with `^`, because
   * a pattern that matches all URLs breaks CORS on third-party endpoints. Needs `fetch` or `xhr`.
   * @default []
   */
  propagateTraceHeaderTo: (string | RegExp)[];
  /**
   * Record every WebSocket's open, close and error events, and count its messages in the
   * `ui.websocket.messages` counter. Message content is never recorded.
   * @default false
   */
  webSocket: boolean;
  /**
   * Report a page in this tab that ended without a clean close, for example after a crash.
   * The tab's next page logs WARN `ui.unclean_exit`. The capture writes one sessionStorage
   * key. A popup with an opener reports nothing, and `identity: "memory"` turns this off.
   * @default false
   */
  uncleanExit: boolean;
  /**
   * Record every `performance.measure()` the app makes in the `ui.user_timing.duration`
   * histogram, in milliseconds, with `user_timing.name`. Every `performance.mark()` adds a
   * breadcrumb. Names follow `fullUrls`.
   * @default false
   */
  userTiming: boolean | UserTimingOptions;
  /**
   * Capture switches that remote sampling rules can change for their TTL. Privacy controls stay local.
   * Needs `sampling.remote`.
   * @default []
   */
  remoteToggles: RemoteCaptureFlag[];
  /**
   * Add the response's Server-Timing entries to fetch and XHR records, and link a traceparent
   * entry to the client span.
   * @default false
   */
  serverTiming: boolean;
  /**
   * Record deprecation, intervention and CSP reports as WARN ui.report. Report URLs have no query or fragment.
   * @default false
   */
  reports: boolean;
  /**
   * Record resource durations in the histogram ui.resource.duration, by initiator type and host.
   * @default false
   */
  resourceTiming: boolean | ResourceTimingOptions;
  /**
   * Record visible, hidden, frozen, resumed and restored states with the time in the previous state.
   * @default false
   */
  lifecycle: boolean;
  /**
   * Capture modules supplied by the app. A new list replaces the current one.
   * @default []
   */
  plugins: CapturePlugin[];
}

/**
 * Serializer option after resolution. A name stays a name, and the transport picks the
 * implementation.
 */
export type SerializerChoice = "otlp" | "ecs" | LogSerializer;

/** Part of the console prefix that a style applies to: the namespace or one level. */
export type ConsoleStyleKey = "namespace" | LogLevel;

/**
 * CSS for each part of the console prefix, for example `"color:#0a7;font-weight:bold"`.
 * A browser applies it with `%c`. Node prints the text without the style.
 */
export type ConsoleStyles = Partial<Record<ConsoleStyleKey, string>>;

/** Object form of the consoleOutput option. */
export interface ConsoleOutputOptions {
  /**
   * Lowest level the console prints. If you leave it unset, the current level stays, and a
   * console that is off stays off.
   */
  level?: LogLevel;
  /** CSS for the namespace and for each level. Any key you leave unset keeps its style. */
  styles?: ConsoleStyles;
}

/** Console settings after resolution. */
export interface ResolvedConsole {
  /** Lowest level that the console prints, or null when the console is off. */
  level: LogLevel | null;
  /** CSS for the namespace and for each level. */
  styles: Required<ConsoleStyles>;
}

/**
 * Kind of batch. A batch of metric records is "metrics" when `metricsEndpoint` is set, and its
 * body is then an OTLP `ExportMetricsServiceRequest`. A batch of span records is "traces",
 * with an OTLP `ExportTraceServiceRequest` as its body.
 */
export type BatchKind = "logs" | "metrics" | "traces";

/** One batch that the library hands to a custom transport. */
export interface TransportRequest {
  /**
   * Abort signal for this delivery context. It aborts on `shutdown()` and on a rotation. A
   * custom transport must check it to cancel its work.
   */
  signal?: AbortSignal;
  /** Delivery context of this batch. */
  routingContextId?: string;
  /**
   * Kind of batch. Send a "metrics" body to your metrics endpoint and a "traces" body to your
   * traces endpoint.
   */
  kind: BatchKind;
  /** Serialized batch from the configured serializer. The library does not compress it. */
  body: string;
  /** Content type of `body`, from the serializer. */
  contentType: string;
  /** Batch id. Send it to the server for deduplication, for example as `X-UiObs-Batch-Id`. */
  batchId: string;
  /** Number of earlier send attempts, 0 for the first send. */
  attempt: number;
  /** Built records after `redact`. Don't change them, because the retry engine can resend them. */
  records: readonly LogRecord[];
}

/** A custom transport's answer. The status code means what it does in the ingest contract. */
export interface TransportResponse {
  /**
   * HTTP-like status code. 2xx accepts the batch. 413 splits it. 429 and 503 throttle.
   * 408 and 5xx retry. Any other code drops the batch.
   */
  status: number;
  /** Delay before the next send, for 429 and 503, in milliseconds. */
  retryAfterMs?: number;
  /** Largest payload that the server accepts, for 413, in bytes. */
  maxBytes?: number;
  /**
   * Sampling rules for a 2xx answer, as the header text or as a parsed object. Only read when
   * `sampling.remote` is on.
   */
  sampling?: unknown;
  /** `Date` header of a 2xx answer. The library computes `uiobs.clock_offset_ms` from it. */
  date?: string;
}

/**
 * Sends one batch through one of the app's own channels, such as an API client, a WebSocket
 * or IPC. A rejected promise counts as a network error, so the library sends the batch again.
 * @param request Batch to send.
 * @returns Promise that resolves to the server's answer.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * Sends one batch while the page closes. It must not wait for a promise.
 * @param request Batch to send.
 * @returns True if the channel accepted the batch. False puts the batch in the emergency queue.
 */
export type ExitTransport = (request: TransportRequest) => boolean;

/** Request timing, retry timing and delivery capacity. Durations are in milliseconds. */
export interface DeliveryOptions {
  /**
   * Maximum wait for one request. Must be at least 1.
   * @default 15000
   */
  requestTimeoutMs: number;
  /**
   * Maximum requests in flight at once. Must be at least 1.
   * @default 2
   */
  maxConcurrentRequests: number;
  /**
   * First retry delay. Set 0 for an immediate retry.
   * @default 2000
   */
  retryBaseDelayMs: number;
  /**
   * Maximum retry delay. Must be at least retryBaseDelayMs.
   * @default 60000
   */
  retryMaxDelayMs: number;
  /**
   * Fetch priority of every batch request. With "low", the app's own requests go first. The
   * exit flush and a keepalive send from a hidden page use the browser default.
   * @default "low"
   */
  priority: "low" | "auto" | "high";
}

/** Record and byte limits for the live delivery buffers, and the cap of a hold buffer. */
export interface BufferingOptions {
  /**
   * Maximum records in the buffers and requests, 1 or more. Set null for no record limit.
   * @default 10000
   */
  maxPendingRecords: number | null;
  /**
   * Maximum encoded JSON bytes in the buffers and requests, 1 or more. Set null for no byte
   * limit.
   * @default 16777216
   */
  maxPendingBytes: number | null;
  /**
   * Maximum records other than actions in one hold buffer. A hold buffer keeps the records
   * that arrive before startup ends, or while the sender loads. A full one keeps its first
   * 100 records and drops the oldest record after them. A lower value removes no held record.
   * 200 to 10000.
   * @default 500
   */
  maxHeldRecords: number;
  /**
   * What to do when a new record does not fit: remove old records, drop the new record, or
   * try storage.
   * @default "drop-oldest"
   */
  overflow: "drop-oldest" | "drop-newest" | "persist";
}

/** The metric interval, and the metric capacity in one interval. */
export interface MetricsOptions {
  /**
   * How often counters, histograms and profiler probes send their points, in milliseconds. A
   * partial metric batch also waits this long before it is sent. 1000 to 600000.
   * @default 10000
   */
  intervalMs: number;
  /**
   * Maximum histogram boundaries. With 0, only a histogram without boundaries is valid. Set
   * null for no limit.
   * @default 50
   */
  maxHistogramBoundaries: number | null;
  /**
   * Maximum attribute sets per instrument. Extra sets go into the overflow set, so 0 puts every
   * value there. Set null for no limit.
   * @default 100
   */
  maxSeries: number | null;
  /**
   * Maximum instrument names. Extra names are dropped, so 0 drops every metric value. Set null
   * for no limit.
   * @default 1000
   */
  maxInstruments: number | null;
}

/** Session and trace timing. The runtime sets these values at startup. */
export interface CorrelationOptions {
  /**
   * How long a stored session can stay idle, in milliseconds, 1 or more. Set null for no idle
   * expiration.
   * @default 1800000
   */
  sessionIdleMs: number | null;
  /**
   * Maximum age of an ambient trace, in milliseconds, 1 or more. The age counts from the trace's
   * start, and the next record after it gets a new trace. Set null for no age limit.
   * @default 300000
   */
  traceMaxAgeMs: number | null;
}

/** Rules for diagnostic reports and the console fallback. */
export interface DiagnosticsOptions {
  /**
   * Minimum wait between reports of one code, in milliseconds. Set 0 to report every event.
   * @default 1000
   */
  throttleMs: number;
  /**
   * Print a fixed warning if onDiagnostic throws. The exception itself is not printed.
   * @default false
   */
  consoleFallback: boolean;
  /**
   * Also send every reported diagnostic as a record in the `uiobs.diagnostics` namespace. A
   * list of codes sends only those codes. The `throttleMs` interval applies. A diagnostic from
   * the first `configure()` produces no record. In a record, the `url` and `endpoint` detail
   * fields have no query and no fragment, while `onDiagnostic` gets the full values.
   * @default false
   */
  records: boolean | DiagnosticCode[];
}

/** Storage of undelivered batches. Can't be changed after startup. */
export interface StorageOptions {
  /**
   * Backing store for undelivered batches. "auto" picks the best one the host supports.
   * @default "auto"
   */
  backend: StorageStrategy;
  /**
   * Namespace for batch storage and emergency queues. An empty value uses the previous storage keys.
   * @default ""
   */
  namespace: string;
  /**
   * Ask the browser to keep the stored batches under storage pressure. Firefox can show a
   * permission prompt. `getHealth()` reports the answer. It takes effect at startup.
   * @default false
   */
  requestPersistent: boolean;
}

/** Resource and page fields that the SDK records. */
export interface MetadataOptions {
  /**
   * Record the page URL. When false, page.url is empty.
   * @default true
   */
  pageUrl: boolean;
  /**
   * Include browser.user_agent in resource attributes.
   * @default true
   */
  userAgent: boolean;
  /**
   * Include the OpenFin application uuid and window name in resource attributes.
   * @default true
   */
  openfin: boolean;
  /**
   * Add `uiobs.clock_offset_ms` to every log and span record. The value comes from the `Date`
   * header of the last accepted answer, so the server must expose that header.
   * @default true
   */
  clockOffset: boolean;
}

/** Capture capacity, duplicate checks and rate limits. */
export interface CaptureLimitsOptions {
  /**
   * Maximum breadcrumbs to keep. Set 0 to keep none.
   * @default 50
   */
  breadcrumbs: number;
  /**
   * How long repeated errors are suppressed, in milliseconds. Set 0 to report every error.
   * @default 5000
   */
  errorDedupeMs: number;
  /**
   * Maximum captured errors in one window. Set 0 to capture none, or null for no limit.
   * @default 20
   */
  errorsPerWindow: number | null;
  /**
   * Maximum captured console records in one window. Set 0 to capture none, or null for no
   * limit.
   * @default 20
   */
  consolePerWindow: number | null;
  /**
   * Maximum long frames in one window. Set 0 to capture none, or null for no limit.
   * @default 20
   */
  longFramesPerWindow: number | null;
  /**
   * Maximum WebSocket events in one window. Set 0 to capture none, or null for no limit.
   * @default 20
   */
  webSocketPerWindow: number | null;
  /** Maximum reports in one window. Set 0 to capture none, or null for no limit. @default 20 */
  reportsPerWindow: number | null;
  /**
   * Maximum resource entries in one window. Set 0 to capture none, or null for no limit.
   * @default 100
   */
  resourcesPerWindow: number | null;
  /**
   * Maximum lifecycle events in one window. Set 0 to capture none, or null for no limit.
   * @default 20
   */
  lifecyclePerWindow: number | null;
  /**
   * Window of the capture rate limits above, in milliseconds, 1 or more. To turn the rate
   * limits off, set the limits of each window to null.
   * @default 10000
   */
  windowMs: number;
}

/** Records that minLevel or sampling drops, kept for the next error. */
export interface DebugBufferOptions {
  /**
   * Keep the records that minLevel or sampling drops. An ERROR or FATAL record from this
   * context sends them first, with `uiobs.debug_buffer: true`. A later change to `redact` or
   * `processors` empties the buffer.
   * @default false
   */
  enabled: boolean;
  /**
   * Maximum kept records. The oldest record is dropped first. 1 to 10000.
   * @default 200
   */
  maxRecords: number;
  /**
   * Maximum age of a kept record when the library reads it, in milliseconds, 1 or more. Set
   * null for no age limit.
   * @default 60000
   */
  maxAgeMs: number | null;
}

/** Duration probes. Each probe is reported as a histogram summary record. */
export interface ProfilerOptions {
  /**
   * Record probe durations. When false, probes do nothing and don't even read the clock.
   * @default false
   */
  enabled: boolean;
  /**
   * Maximum number of probes, 1 to 1024. Can't be changed after startup.
   * @default 64
   */
  maxProbes: number;
  /**
   * Attribute the phases of each long animation frame to every probe that had a span of 1 ms
   * or more in it. The phases are script, render callbacks, style and layout, and forced
   * layout. Needs `enabled` and a browser that supports long animation frames.
   * @default false
   */
  framePhases: boolean;
  /**
   * Measure the time between frames with the `frame.interval` probe. Needs `enabled`. Runs one
   * frame callback per frame while the page is visible.
   * @default false
   */
  framePacing: boolean;
}

/**
 * Session replay. The app's recorder records the DOM, and the library keeps the recent events
 * in memory and sends them in segments after an error.
 */
export interface ReplayOptions {
  /**
   * Record the DOM. Needs `loader`, plus either `endpoint` or `onSegment`.
   * @default false
   */
  enabled: boolean;
  /**
   * `"onError"` uploads the buffer after an ERROR or FATAL record.
   * @default "onError"
   */
  mode: ReplayMode;
  /**
   * URL that each segment is POSTed to. This is separate from the log endpoint. Set null to
   * turn it off. An empty or blank string also turns it off, and reports `config.invalid`.
   * @default null
   */
  endpoint: string | null;
  /**
   * When true, nothing is recorded until `startReplay()` is called.
   * @default false
   */
  requireConsent: boolean;
  /**
   * How much time before an error the buffer keeps, in milliseconds. At any moment the buffer
   * holds between 1x and 1.5x this much. 5000 to 600000.
   * @default 60000
   */
  bufferMs: number;
  /**
   * Maximum buffer size, measured as the JSON length of its events. When it is exceeded, the
   * buffer drops its oldest part. 100000 to 200000000.
   * @default 10000000
   */
  maxBufferBytes: number;
  /**
   * How long the library keeps sending events after an error, in milliseconds. Another error
   * inside that time doesn't extend it. 0 to 600000.
   * @default 5000
   */
  afterErrorMs: number;
  /**
   * Maximum uploads in one `uploadWindowMs` window. Set 0 to upload nothing, or null for no
   * limit.
   * @default 3
   */
  uploadsPerWindow: number | null;
  /**
   * Length of the `uploadsPerWindow` window, in milliseconds, 1 or more.
   * @default 10000
   */
  uploadWindowMs: number;
  /**
   * Maximum events in one segment. 1 to 10000.
   * @default 200
   */
  maxSegmentEvents: number;
  /**
   * Maximum segment size, measured as the JSON length of its events. A single event larger
   * than this gets a segment to itself. 10000 to 10000000.
   * @default 512000
   */
  maxSegmentBytes: number;
  /**
   * How long a partial segment waits before it is sent, in milliseconds. 100 to 60000.
   * @default 2000
   */
  flushIntervalMs: number;
  /**
   * Maximum total size of the segments waiting to be sent. When it is exceeded, the library
   * drops the oldest segment. 100000 to 200000000.
   * @default 20000000
   */
  maxQueueBytes: number;
  /**
   * Maximum send attempts per segment. 1 to 10.
   * @default 3
   */
  maxAttempts: number;
  /**
   * Mask all element text. Only text inside an element with `data-observability-unmask` is left alone.
   * The recorder does not mask attribute values, URLs, CSS text or comments.
   * @default true
   */
  maskText: boolean;
  /**
   * Mask the value of every `input`, `textarea` and `select`, including hidden and file
   * inputs. Password inputs are always masked. The recorder does not mask the `value` of
   * checkboxes, radio buttons, buttons or `<option>` elements.
   * @default true
   */
  maskInputs: boolean;
  /**
   * Record canvas elements.
   * @default false
   */
  recordCanvas: boolean;
  /**
   * CSS selectors for elements whose text is always masked.
   * @default []
   */
  maskSelectors: string[];
  /**
   * CSS selectors for elements the recorder should skip entirely. The recorder also always
   * skips `[data-observability-ignore]`, the regions click capture ignores.
   * @default []
   */
  blockSelectors: string[];
  /**
   * Loads the recorder, e.g. `() => import("@rrweb/record")`.
   * @default null
   */
  loader: ReplayLoader | null;
  /**
   * Receives each segment instead of the POST to `endpoint`.
   * @default null
   */
  onSegment: ((segment: ReplaySegment) => void | Promise<void>) | null;
  /**
   * Request headers for `endpoint`, or a function that returns them. The log endpoint's
   * `headers` are never sent to the replay endpoint.
   * @default null
   */
  headers:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | null;
  /**
   * Loaders for the recorder's record plugins.
   * @default []
   */
  plugins: ReplayPluginLoader[];
  /**
   * Extra options for the `record` function, such as `sampling` and `slimDOMOptions`. The
   * library sets the mask, block, canvas, plugin and event options itself and ignores them here.
   * @default {}
   */
  recordOptions: Record<string, unknown>;
}

/** Options passed to `configure()`. */
export interface ObservabilityConfig {
  /** Capture capacity and rate limits. */
  captureLimits?: Partial<CaptureLimitsOptions>;
  /** Resource and page fields to record. */
  metadata?: Partial<MetadataOptions>;
  /** Diagnostic report and console fallback settings. */
  diagnostics?: Partial<DiagnosticsOptions>;
  /** Session and trace timing. */
  correlation?: Partial<CorrelationOptions>;
  /** The metric interval and the metric capacity in one interval. */
  metrics?: Partial<MetricsOptions>;
  /** Live buffer capacity and the overflow rule. */
  buffering?: Partial<BufferingOptions>;
  /** Request timing and delivery capacity. */
  delivery?: Partial<DeliveryOptions>;
  /** Records that minLevel or sampling drops, kept for the next error. */
  debugBuffer?: Partial<DebugBufferOptions>;
  /** Duration probes. Each probe is reported as a histogram summary record. */
  profiler?: Partial<ProfilerOptions>;
  /** Session replay. Off by default. */
  replay?: Partial<ReplayOptions>;
  /**
   * Refuse changes through configure(). Call setConfigurationLocked(false) to permit changes again.
   * @default false
   */
  lockConfiguration?: boolean;
  /** Logger cache capacity. The app can change it until configuration is locked. */
  loggerCache?: Partial<LoggerCacheOptions>;
  /** Delivery identity and isolation rule. Use rotateSecurityContext() to change the identity. */
  securityContext?: Partial<SecurityContextOptions>;
  /**
   * Ingest endpoint URL. Set `null` for console-only mode, where the library sends nothing
   * and writes records to the console only if you set `consoleOutput`. If the key is missing or
   * `""`, the library reports `config.invalid`. A relative URL resolves against the page, and a
   * URL with a user name or a password is refused.
   */
  endpoint?: string | null;

  /**
   * OTLP metrics endpoint URL, for example `"https://ingest.example/v1/metrics"`. When set,
   * the library sends every batch of metric records there as an OTLP
   * `ExportMetricsServiceRequest`. Without it, metric records are log records on `endpoint`.
   * Needs `serializer: "otlp"`. Set null to turn it off. A blank string also turns it off, and
   * reports `config.invalid`.
   * @default null
   */
  metricsEndpoint?: string | null;

  /**
   * OTLP traces endpoint URL, for example `"https://ingest.example/v1/traces"`. When set, the
   * library records one root span for every trace it creates and one CLIENT span for every
   * request that gets `traceparent`, and sends them there as an OTLP
   * `ExportTraceServiceRequest`. Without it, the library sends no spans. Needs
   * `serializer: "otlp"`. Set null to turn it off. A blank string also turns it off, and reports
   * `config.invalid`.
   * @default null
   */
  tracesEndpoint?: string | null;

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
   * Master switch. When false, every log call does nothing.
   * @default true
   */
  enabled?: boolean;
  /**
   * Copy payloads at the call, or keep references to them until idle time. The debug buffer
   * always builds at the call.
   * @default "copy"
   */
  payloadMode?: "copy" | "defer";
  /**
   * Minimum level that the library logs.
   * @default "INFO"
   */
  minLevel?: LogLevel;
  /**
   * Minimum level for each namespace prefix. The longest matching prefix wins. For example,
   * `{ "trading.ticks": "DEBUG" }` logs the DEBUG records of `trading.ticks` and its child
   * namespaces. A namespace with no match uses `minLevel`. A new map replaces the current one.
   * @default {}
   */
  minLevels?: Record<string, LogLevel>;

  /**
   * "gzip" compresses any payload larger than the compression threshold. Use "none" for an
   * ingest endpoint that rejects gzip.
   * @default "gzip"
   */
  compression?: "gzip" | "none";
  /**
   * Payload format, either a name or a custom implementation.
   * @default "otlp"
   */
  serializer?: SerializerChoice;
  /**
   * Passed to `fetch`. Set "include" for an ingest endpoint that authenticates with cookies.
   * @default "omit"
   */
  credentials?: RequestCredentials;
  /**
   * Extra request headers, or a function returning them. undefined keeps the current headers.
   * With isolation off, null removes them. With isolation on, the default, use
   * rotateSecurityContext() at logout, because configure() refuses a routing change. The
   * library has no default headers.
   */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | null;

  /**
   * Backing store, namespace and persistence request for undelivered batches. Can't be changed
   * after startup.
   * @see {@link StorageOptions}
   */
  storage?: Partial<StorageOptions>;
  /**
   * Where the library keeps session, tab and journey ids. "memory" writes no key to
   * localStorage or sessionStorage, so every page load starts a new session. Can't be changed
   * after startup.
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
   * Batch size and flush interval for each record stream.
   * @see {@link BatchingOptions}
   */
  batching?: Partial<BatchingOptions>;
  /**
   * Retention of undelivered batches.
   * @see {@link RetentionOptions}
   */
  retention?: Partial<RetentionOptions>;
  /**
   * Size limits for each record.
   * @see {@link LimitsOptions}
   */
  limits?: Partial<LimitsOptions>;
  /**
   * Automatic instrumentation.
   * @see {@link CaptureOptions}
   */
  capture?: Partial<CaptureOptions>;
  /**
   * Prints records to the browser console. The line format is `[namespace][LEVEL] message`.
   * `false` turns it off, and `true` prints records at DEBUG and above. A level prints records
   * at that level and above. An object sets the level and the styles.
   * @default false
   */
  consoleOutput?: boolean | LogLevel | ConsoleOutputOptions;

  /**
   * Sends batches through one of the app's own channels instead of HTTP. With `transport`,
   * `endpoint` is optional. The library does not compress the body for a custom transport.
   * Set null to remove it.
   * @see {@link Transport}
   */
  transport?: Transport | null;
  /**
   * Sends the last batch while the page closes, for a custom transport. Without it, the
   * library puts that batch in the emergency queue and the next page load sends it. Needs
   * `transport`. Set null to remove it.
   * @see {@link ExitTransport}
   */
  transportOnExit?: ExitTransport | null;
  /**
   * Creates a dedicated worker for encoding, compression and HTTP sends. The worker calls serveTransportWorker().
   * Headers functions, retries, storage and exit sends stay on the main thread. With `transport`
   * set, the library doesn't start the worker. Set null to remove it.
   */
  transportWorker?: (() => Worker) | null;

  /**
   * Loads the `@opentelemetry/api` module. Example: `() => import("@opentelemetry/api")`.
   * OTel stays off unless you set it. Set null to remove it.
   * @see {@link OtelLoader}
   */
  otelLoader?: OtelLoader | null;

  /**
   * Returns attributes for every record the library builds. Its values override `setContext()`
   * values, and the logger scope and the call payload override its values. It is called for
   * every built record, including records used only for the console or breadcrumbs. Keep it
   * fast and synchronous. If it throws or returns a non-object, it adds nothing to the record.
   * Set null to remove it.
   * @returns The attributes, or undefined for none.
   */
  contextProvider?: (() => Record<string, unknown> | undefined) | null;

  /**
   * Change or drop a record. Processors run in list order, before `redact`, and follow the
   * same contract as `redact`. If one throws or returns something that isn't a record, the
   * library drops the record. A list with an entry that isn't a function keeps the current list,
   * and with no current list the library drops every record until a later call sets a list of
   * functions or [].
   */
  processors?: ((record: LogRecord) => LogRecord | null)[];

  /**
   * Changes or drops a record before the SDK prints or sends it. If the hook throws or returns
   * something that isn't a record, the library drops the record. An omitted key or undefined
   * keeps the current hook. Set null to remove it. A value that isn't a function keeps the
   * current hook, and with no current hook the library drops every record until a later call
   * sets a function or null.
   * @param record Record to process. It may be destined only for the console or breadcrumbs.
   * @returns The record to send, or `null` to drop it.
   */
  redact?: ((record: LogRecord) => LogRecord | null) | null;

  /**
   * Reports this library's own faults. Set null to remove it.
   * @see {@link DiagnosticHandler}
   */
  onDiagnostic?: DiagnosticHandler | null;

  /**
   * Receives a summary when the library loses records it has already built. Sampling,
   * `minLevel`, `processors` and `redact` do not cause a loss. Losses with the same reason in
   * the same task are merged. Do not log through the library in the hook, because a record
   * from the hook can evict a stored batch. A batch that storage evicts during its send can
   * still reach the server. Set null to remove it.
   * @param summary The loss's reason, record count, batch ids, journey ids and action names.
   * @see {@link DropSummary}
   */
  onDrop?: ((summary: DropSummary) => void) | null;
}

/** Fully resolved configuration that the runtime holds. */
export interface ResolvedConfig {
  /** Capture capacity and rate limits. */
  captureLimits: CaptureLimitsOptions;
  /** Resource and page fields to record. */
  metadata: MetadataOptions;
  /** Diagnostic report and console fallback settings. */
  diagnostics: DiagnosticsOptions;
  /** Session and trace timing. */
  correlation: CorrelationOptions;
  /** The metric interval and the metric capacity in one interval. */
  metrics: MetricsOptions;
  /** Live buffer capacity and the overflow rule. */
  buffering: BufferingOptions;
  /** Request timing and delivery capacity. */
  delivery: DeliveryOptions;
  /** Records that minLevel or sampling drops, kept for the next error. */
  debugBuffer: DebugBufferOptions;
  /** Duration probes. Each probe is reported as a histogram summary record. */
  profiler: ProfilerOptions;
  /** Session replay settings. */
  replay: ReplayOptions;
  /** True if configure() must refuse changes to the active settings. */
  lockConfiguration: boolean;
  /** Logger cache capacity. */
  loggerCache: LoggerCacheOptions;
  /** Active delivery context id and isolation rule. */
  securityContext: SecurityContextOptions;
  /** Ingest endpoint URL, or null in console-only mode. */
  endpoint: string | null;
  /** OTLP metrics endpoint URL, or null to send metric records as log records. */
  metricsEndpoint: string | null;
  /** OTLP traces endpoint URL, or null when the library sends no span. */
  tracesEndpoint: string | null;
  /** Reported as `service.name`. */
  serviceName: string;
  /** Reported as `service.version`. */
  serviceVersion: string;
  /** Reported as `deployment.environment`. */
  environment: string;
  /** Master switch. When false, every log call does nothing. */
  enabled: boolean;
  /** When logger calls read their payloads. */
  payloadMode: "copy" | "defer";
  /** Minimum level that the library logs. */
  minLevel: LogLevel;
  /** Minimum level for each namespace prefix. */
  minLevels: Record<string, LogLevel>;
  /** Hooks that change or drop a record before `redact`. */
  processors: NonNullable<ObservabilityConfig["processors"]>;
  /** "gzip" compresses any payload larger than the compression threshold. */
  compression: "gzip" | "none";
  /** Passed to `fetch`. */
  credentials: RequestCredentials;
  /** Backing store, namespace and persistence request for undelivered batches. */
  storage: StorageOptions;
  /** Where session, tab and journey ids are kept. */
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
   * Batch size and flush interval for each record stream.
   * @see {@link BatchingOptions}
   */
  batching: BatchingOptions;
  /**
   * Retention of undelivered batches.
   * @see {@link RetentionOptions}
   */
  retention: RetentionOptions;
  /**
   * Size limits for each record.
   * @see {@link LimitsOptions}
   */
  limits: LimitsOptions;
  /**
   * Automatic instrumentation.
   * @see {@link CaptureOptions}
   */
  capture: CaptureOptions;
  /** Console output level and styles. */
  consoleOutput: ResolvedConsole;
  /** Payload format name, or a custom implementation. */
  serializer: SerializerChoice;
  /** Extra request headers, or a function returning them. */
  headers?: NonNullable<ObservabilityConfig["headers"]>;
  /** Sends batches through one of the app's own channels instead of HTTP. */
  transport?: Transport;
  /** Sends the last batch while the page closes, for a custom transport. */
  transportOnExit?: ExitTransport;
  /** Creates the dedicated HTTP transport worker. */
  transportWorker?: NonNullable<ObservabilityConfig["transportWorker"]>;
  /** Supplies the `@opentelemetry/api` module in place of importing it. */
  otelLoader?: OtelLoader;
  /** Returns attributes for every record the library builds. */
  contextProvider?: NonNullable<ObservabilityConfig["contextProvider"]>;
  /**
   * Changes or drops a record before the SDK prints or sends it.
   * @param record Record to process. It may be destined only for the console or breadcrumbs.
   * @returns The record to send, or `null` to drop it.
   */
  redact?: NonNullable<ObservabilityConfig["redact"]>;
  /**
   * Reports this library's own faults.
   * @see {@link DiagnosticHandler}
   */
  onDiagnostic?: DiagnosticHandler;
  /** Receives a summary when the library loses records it has already built. */
  onDrop?: NonNullable<ObservabilityConfig["onDrop"]>;
}

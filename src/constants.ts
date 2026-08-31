// src/constants.ts
//
// All limits, thresholds, timing windows, storage keys, patterns, and
// defaults used by the library.

import type { ResolvedConfig } from "./models/config";
import type { LogLevel, LogType } from "./models/log-record";

// ----------------------------------
// Library-wide
// ----------------------------------

/** Prefix on console messages this library writes. */
export const LIBRARY_LOG_PREFIX = "[ui-observability]";

// ----------------------------------
// Diagnostics
// ----------------------------------

/** Throttle window per diagnostic code, in milliseconds. Limits how often an error loop can spam the handler. */
export const DIAGNOSTIC_THROTTLE_MS = 1000;

// ----------------------------------
// Identity
// ----------------------------------

/** `localStorage` key for the session id and its last-seen time. */
export const SESSION_ID_KEY = "ui-observability.session";

/** `sessionStorage` key for the tab id. */
export const TAB_ID_KEY = "ui-observability.tab";

/** Session idle timeout, in milliseconds. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Min gap between session last-seen writes, in milliseconds. */
export const SESSION_TOUCH_MS = 60_000;

/** Random id length, in bytes, used when `crypto.randomUUID` is unavailable. */
export const ID_BYTE_LENGTH = 16;

/** Distinct values in one byte (256). */
export const BYTE_VALUE_COUNT = 256;

// ----------------------------------
// Platform detection
// ----------------------------------

/** Matches OpenFin's user agent. */
export const OPENFIN_UA_PATTERN = /OpenFin/i;

/** Matches Android's webview token (`wv`). */
export const ANDROID_WEBVIEW_UA_PATTERN = /\bwv\b/;

/** Matches iOS hardware: iPhone, iPad, iPod. */
export const IOS_DEVICE_UA_PATTERN = /\b(iPhone|iPad|iPod)\b/;

/** Matches desktop macOS in a user agent. */
export const MACINTOSH_UA_PATTERN = /\bMacintosh\b/;

/** Matches the mobile token. */
export const MOBILE_UA_PATTERN = /\bMobile\b/;

/** WebKit engine token, present in every WebKit browser including webviews. */
export const WEBKIT_UA_TOKEN = "AppleWebKit";

/** Safari token sent by real iOS browsers, not in-app webviews. */
export const SAFARI_UA_TOKEN = "Safari/";

// ----------------------------------
// Sanitizing and size estimation
// ----------------------------------

/** First UTF-16 high surrogate code unit. */
export const HIGH_SURROGATE_MIN = 0xd800;

/** Last UTF-16 high surrogate code unit. */
export const HIGH_SURROGATE_MAX = 0xdbff;

/** Code units below this encode as one UTF-8 byte. */
export const UTF8_ONE_BYTE_CEILING = 0x80;

/** Code units below this, and at or above the one-byte ceiling, encode as two UTF-8 bytes. */
export const UTF8_TWO_BYTE_CEILING = 0x800;

/** Class names kept in a `describeNode` selector. */
export const MAX_NODE_CLASS_NAMES = 3;

/** Byte cost of a null or undefined value. */
export const BYTES_PER_NULL = 4;

/** Byte cost of a number (flat estimate). */
export const BYTES_PER_NUMBER = 8;

/** Byte cost of a boolean. */
export const BYTES_PER_BOOLEAN = 5;

/** Byte cost of an object or array's wrapping braces or brackets. */
export const BYTES_PER_CONTAINER = 2;

/** Byte cost of a string's wrapping quotes. */
export const BYTES_PER_QUOTED_STRING = 2;

/** Byte cost of one key's punctuation: quotes, colon, comma. */
export const BYTES_PER_KEY_OVERHEAD = 4;

// ----------------------------------
// Record model
// ----------------------------------

/**
 * Log level to OpenTelemetry severity number.
 * @see {@link LEVEL_ORDER}
 */
export const SEVERITY_NUMBER: Record<LogLevel, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

/**
 * Alias for `SEVERITY_NUMBER`, used by the level filter.
 * @see {@link SEVERITY_NUMBER}
 */
export const LEVEL_ORDER: Record<LogLevel, number> = SEVERITY_NUMBER;

// ----------------------------------
// Attribute and resource keys
// ----------------------------------
//
// Attribute and resource key names records carry on the wire, following
// OpenTelemetry conventions. `uiobs.` marks this library's own fields.

/** Record kind attribute key. */
export const ATTR_LOG_TYPE = "log.type";

/** Record sequence number within its context, from zero. */
export const ATTR_LOG_SEQ = "log.seq";

/** Logger namespace attribute key. */
export const ATTR_APP_NAMESPACE = "app.namespace";

/** Document URL when the record was built. */
export const ATTR_PAGE_URL = "page.url";

/**
 * HTTP request URL attribute key, set by network capture. Don't reuse `ATTR_PAGE_URL`; it would overwrite the request's target.
 * @see {@link ATTR_PAGE_URL}
 */
export const ATTR_URL_FULL = "url.full";

/** Journey id attribute key. */
export const ATTR_JOURNEY_ID = "journey.id";

/** Journey name attribute key. */
export const ATTR_JOURNEY_NAME = "journey.name";

/** Parent journey id, present only on a child journey. */
export const ATTR_JOURNEY_PARENT_ID = "journey.parent_id";

/** Marks a record whose attributes failed to sanitize. */
export const ATTR_SANITIZE_FAILED = "uiobs.sanitize_failed";

/**
 * Marks a record whose attributes were dropped for exceeding the byte budget.
 * @see {@link ATTR_ATTRIBUTES_BYTES}
 */
export const ATTR_ATTRIBUTES_DROPPED = "uiobs.attributes_dropped";

/**
 * Byte size of the dropped attributes.
 * @see {@link ATTR_ATTRIBUTES_DROPPED}
 */
export const ATTR_ATTRIBUTES_BYTES = "uiobs.attributes_bytes";

/** Application name resource key. */
export const RESOURCE_SERVICE_NAME = "service.name";

/** Application build version resource key. */
export const RESOURCE_SERVICE_VERSION = "service.version";

/** Deployment environment resource key. */
export const RESOURCE_DEPLOYMENT_ENVIRONMENT = "deployment.environment";

/**
 * Producer library name resource key.
 * @see {@link TELEMETRY_SDK_NAME}
 */
export const RESOURCE_TELEMETRY_SDK_NAME = "telemetry.sdk.name";

/**
 * Producer library version resource key.
 * @see {@link TELEMETRY_SDK_VERSION}
 */
export const RESOURCE_TELEMETRY_SDK_VERSION = "telemetry.sdk.version";

/**
 * Producer SDK language resource key.
 * @see {@link TELEMETRY_SDK_LANGUAGE}
 */
export const RESOURCE_TELEMETRY_SDK_LANGUAGE = "telemetry.sdk.language";

/** Host platform resource key: browser, webview, or OpenFin. */
export const RESOURCE_HOST_PLATFORM = "host.platform";

/** Session id resource key. */
export const RESOURCE_SESSION_ID = "session.id";

/** Tab id resource key. */
export const RESOURCE_TAB_ID = "tab.id";

/** Context (realm) id resource key. */
export const RESOURCE_CONTEXT_ID = "context.id";

/** Raw user agent resource key. */
export const RESOURCE_BROWSER_USER_AGENT = "browser.user_agent";

/** OpenFin application uuid resource key. */
export const RESOURCE_OPENFIN_UUID = "openfin.uuid";

/** OpenFin window or view name resource key. */
export const RESOURCE_OPENFIN_NAME = "openfin.name";

/**
 * Value of `telemetry.sdk.name`.
 * @see {@link RESOURCE_TELEMETRY_SDK_NAME}
 */
export const TELEMETRY_SDK_NAME = "@utk09/ui-observability";

/**
 * Value of `telemetry.sdk.version`. A literal, not read from package.json. Bump by hand alongside package.json.
 * @see {@link RESOURCE_TELEMETRY_SDK_VERSION}
 */
export const TELEMETRY_SDK_VERSION = "0.1.2";

/**
 * Value of `telemetry.sdk.language`.
 * @see {@link RESOURCE_TELEMETRY_SDK_LANGUAGE}
 */
export const TELEMETRY_SDK_LANGUAGE = "webjs";

// ----------------------------------
// Serializers
// ----------------------------------

/** OTLP/JSON serializer name. */
export const SERIALIZER_NAME_OTLP = "otlp";

/** ECS serializer name. */
export const SERIALIZER_NAME_ECS = "ecs";

/** Content type for an OTLP/JSON body. */
export const CONTENT_TYPE_JSON = "application/json";

/** Content type for newline-delimited JSON. */
export const CONTENT_TYPE_NDJSON = "application/x-ndjson";

/** Nanoseconds per millisecond. */
export const NANOS_PER_MILLI = 1000000n;

/**
 * Matches a nanosecond epoch written as decimal digits, e.g. "1755543600123000000".
 * @see {@link NANOS_PER_MILLI}
 */
export const NANOS_PATTERN = /^\d+$/;

// ----------------------------------
// HTTP transport
// ----------------------------------

/** Content-Type header name. */
export const HEADER_CONTENT_TYPE = "Content-Type";

/** Content-Encoding header name. */
export const HEADER_CONTENT_ENCODING = "Content-Encoding";

/** Retry-After header name. */
export const HEADER_RETRY_AFTER = "Retry-After";

/**
 * Batch deduplication key header name.
 * @see {@link QUERY_PARAM_BATCH_ID}
 */
export const HEADER_BATCH_ID = "X-UiObs-Batch-Id";

/** Delivery attempt number header name. */
export const HEADER_ATTEMPT = "X-UiObs-Attempt";

/** Gzip encoding name. */
export const ENCODING_GZIP = "gzip";

/** 401, credentials missing or rejected. */
export const HTTP_UNAUTHORIZED = 401;

/** 403, valid credentials but access denied. */
export const HTTP_FORBIDDEN = 403;

/** 408, the server closed the connection after a timeout. Retryable. */
export const HTTP_REQUEST_TIMEOUT = 408;

/** 413, payload too large; batch must be split. */
export const HTTP_PAYLOAD_TOO_LARGE = 413;

/** 429, backpressure. */
export const HTTP_TOO_MANY_REQUESTS = 429;

/** 500, floor for server-side errors. */
export const HTTP_SERVER_ERROR_MIN = 500;

/** 503, temporary unavailability. */
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** Milliseconds per second. */
export const MILLIS_PER_SECOND = 1000;

// ----------------------------------
// Exit flush
// ----------------------------------

/** Max exit payload size, in bytes (`sendBeacon`/`fetch(keepalive)` shared budget). */
export const BEACON_LIMIT_BYTES = 60_000;

/** Content type for an exit payload. CORS-safelisted, avoids a preflight. */
export const CONTENT_TYPE_TEXT_PLAIN = "text/plain;charset=UTF-8";

/**
 * Batch id query param name, for the exit path.
 * @see {@link HEADER_BATCH_ID}
 */
export const QUERY_PARAM_BATCH_ID = "uiobs_batch_id";

/** Exit reason query param name, for logs only. */
export const QUERY_PARAM_EXIT_REASON = "uiobs_exit";

// ----------------------------------
// Storage
// ----------------------------------

/** localStorage key prefix for a parked batch. */
export const BATCH_STORAGE_KEY_PREFIX = "ui-observability.batch.";

/** Zero-padded digit width for the creation time in a batch key. */
export const BATCH_KEY_TIME_WIDTH = 14;

/** localStorage key prefix for a batch parked by exit flush. */
export const EMERGENCY_STORAGE_KEY_PREFIX = "ui-observability.emergency.";

/** Max exit batches held at once. */
export const EMERGENCY_MAX_ENTRIES = 20;

/** Key used to test whether localStorage accepts writes. */
export const STORAGE_PROBE_KEY = "ui-observability.probe";

/** Fraction of the store evicted on a quota error (1 in N). */
export const QUOTA_EVICTION_DIVISOR = 4;

/** DOMException name for a full store. */
export const QUOTA_EXCEEDED_ERROR = "QuotaExceededError";

/** IndexedDB schema version. Bumping it requires a matching Dexie migration. */
export const INDEXEDDB_SCHEMA_VERSION = 1;

/** IndexedDB adapter/strategy name. */
export const STORAGE_NAME_INDEXEDDB = "indexeddb";

/** localStorage adapter/strategy name. */
export const STORAGE_NAME_LOCAL = "localstorage";

/** In-memory adapter/strategy name. */
export const STORAGE_NAME_MEMORY = "memory";

/** No-op adapter/strategy name. */
export const STORAGE_NAME_NONE = "none";

// ----------------------------------
// Retry
// ----------------------------------

/**
 * Origin-wide lock name a drain runs under.
 * @see {@link EMERGENCY_LOCK_NAME}
 */
export const DRAIN_LOCK_NAME = "ui-observability.drain";

/**
 * Lock name startup recovery runs under.
 * @see {@link DRAIN_LOCK_NAME}
 */
export const EMERGENCY_LOCK_NAME = "ui-observability.emergency";

/** Batches sent per drain tick. */
export const BATCHES_PER_DRAIN = 20;

// ----------------------------------
// Journey
// ----------------------------------

/** `sessionStorage` key for the current journey. */
export const JOURNEY_STORAGE_KEY = "ui-observability.journey";

/**
 * Max journey name length in a token, in characters.
 * @see {@link JOURNEY_TOKEN_MAX_CHARS}
 */
export const JOURNEY_TOKEN_NAME_MAX_CHARS = 64;

/**
 * Max whole-token length, in characters. A tripwire, not validation.
 * @see {@link JOURNEY_TOKEN_NAME_MAX_CHARS}
 */
export const JOURNEY_TOKEN_MAX_CHARS = 256;

/**
 * How long to wait for `fin.me.getOptions()` before giving up on a seeded journey,
 * in milliseconds.
 * @see {@link OPENFIN_JOURNEY_CUSTOM_DATA_KEY}
 */
export const OPENFIN_OPTIONS_TIMEOUT_MS = 2000;

/** Key under an OpenFin window's `customData` carrying a seeded journey token. */
export const OPENFIN_JOURNEY_CUSTOM_DATA_KEY = "uiObsJourney";

/** Matches `+` in standard base64 (`-` in URL-safe). */
export const BASE64_PLUS_PATTERN = /\+/g;

/** Matches `/` in standard base64 (`_` in URL-safe). */
export const BASE64_SLASH_PATTERN = /\//g;

/** Matches trailing `=` padding. */
export const BASE64_PADDING_PATTERN = /=+$/;

/** Matches `-` in URL-safe base64 (`+` in standard). */
export const BASE64URL_DASH_PATTERN = /-/g;

/** Matches `_` in URL-safe base64 (`/` in standard). */
export const BASE64URL_UNDERSCORE_PATTERN = /_/g;

/** Base64 characters per 3-byte group. */
export const BASE64_GROUP_CHARS = 4;

// ----------------------------------
// Tracing
// ----------------------------------

/** W3C trace id width, in bytes. */
export const TRACE_ID_BYTES = 16;

/** W3C span id width, in bytes. */
export const SPAN_ID_BYTES = 8;

/** Max ambient trace lifetime with no activity, in milliseconds. */
export const TRACE_MAX_AGE_MS = 5 * 60 * 1000;

/** trace-flags value with the sampled bit set. */
export const TRACE_FLAGS_SAMPLED = 1;

/** Mask for the one-byte trace-flags field. */
export const TRACE_FLAGS_MASK = 0xff;

/**
 * W3C trace context header name
 * @see {@link TRACEPARENT_VERSION}
 */
export const TRACEPARENT_HEADER = "traceparent";

/** traceparent header version prefix. */
export const TRACEPARENT_VERSION = "00";

// ----------------------------------
// Breadcrumbs
// ----------------------------------

/** Smallest valid breadcrumb buffer capacity. */
export const BREADCRUMB_MIN_CAPACITY = 1;

// ----------------------------------
// Sampling
// ----------------------------------
//
// FNV-1a hash constants, used to turn a sampling key into a stable 0-1
// fraction.

/** FNV-1a 32-bit offset basis. */
export const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
export const FNV_PRIME = 0x01000193;

/** Largest 32-bit unsigned value. */
export const UINT32_MAX = 0xffffffff;

// ----------------------------------
// Pipeline
// ----------------------------------

/** Record kind routed to the metric stream. */
export const LOG_TYPE_METRIC: LogType = "metric";

/** Batches held per stream buffer before the oldest is dropped. */
export const PENDING_BUFFER_BATCHES = 10;

// ----------------------------------
// Bus
// ----------------------------------

/** Protocol identifier for bus envelopes. Mismatched versions are dropped. */
export const BUS_PROTOCOL = "ui-observability/1";

/** Global window property key used to locate a same-origin runtime instance. */
export const RUNTIME_GLOBAL_KEY = "ui-observability.runtime";

// ----------------------------------
// Capture
// ----------------------------------

/** Maximum error records captured per throttling window before suppression. */
export const ERROR_STORM_MAX_PER_WINDOW = 20;

/** Error rate-limiting window duration in milliseconds. */
export const ERROR_STORM_WINDOW_MS = 10_000;

/** Maximum distinct error signatures tracked for deduplication before LRU eviction. */
export const MAX_TRACKED_ERROR_SIGNATURES = 200;

/** Maximum character length retained from clicked element text in breadcrumbs. */
export const CLICK_TEXT_MAX_CHARS = 50;

/** Maximum character length retained from an aria-label attribute in generated selectors. */
export const ARIA_LABEL_MAX_CHARS = 40;

/** Maximum class names included per element in generated CSS selectors. */
export const SELECTOR_MAX_CLASSES = 2;

/** CSS styling applied to console prefix labels. */
export const CONSOLE_PREFIX_STYLE = "color:#888";

/** Scaling factor for rounding duration measurements to three decimal places. */
export const DURATION_PRECISION = 1000;

// ----------------------------------
// Runtime
// ----------------------------------

/** Minimum duration in milliseconds between storage gap warning reports. */
export const GAP_REPORT_THROTTLE_MS = 60_000;

/** Default namespace for telemetry records emitted by auto-capture modules. */
export const CAPTURE_NAMESPACE = "uiobs.capture";

/** Default namespace for telemetry records emitted by storage subsystems. */
export const STORAGE_NAMESPACE = "uiobs.storage";

/** Fallback measurement unit applied when none is specified. */
export const DEFAULT_METRIC_UNIT = "count";

// ----------------------------------
// Configuration
// ----------------------------------

/** Default `service.name` when a consumer sets none. */
export const UNKNOWN_SERVICE_NAME = "unknown-service";

/** Lowest sampling rate (drop everything). */
export const SAMPLING_RATE_MIN = 0;

/** Highest sampling rate (keep everything). */
export const SAMPLING_RATE_MAX = 1;

/**
 * Fallback for an invalid sampling rate (keep everything).
 * @see {@link SAMPLING_RATE_MAX}
 */
export const SAMPLING_RATE_FALLBACK = 1;

/**
 * Config keys with no default, excluded from `DEFAULT_CONFIG`.
 * @see {@link DEFAULT_CONFIG}
 */
export const UNDEFAULTED_CONFIG_KEYS = ["redact", "onDiagnostic", "headers", "serializer"] as const;

/**
 * Nested config section keys.
 * @see {@link ResolvedConfig}
 */
export const CONFIG_SECTIONS = [
  "streams",
  "storage",
  "retry",
  "sampling",
  "journey",
  "bus",
  "capture",
  "limits",
  "console",
] as const;

/**
 * Default runtime config, before a consumer's `configure()` call.
 * Excludes `serializer`; `resolveConfig` supplies its default to avoid a circular import.
 * @see {@link ResolvedConfig}
 * @see {@link UNDEFAULTED_CONFIG_KEYS}
 */
export const DEFAULT_CONFIG: Omit<ResolvedConfig, "serializer"> = {
  endpoint: "",
  serviceName: "",
  serviceVersion: "",
  environment: "",
  enabled: true,
  minLevel: "INFO",
  streams: {
    logs: { flushIntervalMs: 2000, batchSize: 100 },
    // Metrics batch harder than logs: higher volume, nothing waits on them.
    metrics: { flushIntervalMs: 10_000, batchSize: 500 },
  },
  maxConcurrentRequests: 2,
  requestTimeoutMs: 15000,
  compression: "gzip",
  compressionThresholdBytes: 1024,
  credentials: "include",
  storage: {
    strategy: "auto",
    dbName: "UiObservability",
    maxBatches: 500,
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxAttempts: 5,
  },
  retry: { baseDelayMs: 2000, maxDelayMs: 60000, idleDelayMs: 30000 },
  sampling: { defaultRate: 1, rates: {}, alwaysSampleTypes: ["action"] },
  journey: {
    maxAgeMs: 30 * 60 * 1000,
    endOnOwnerClose: false,
    urlParam: "__uiobs_journey",
  },
  bus: {
    mode: "auto",
    channelName: "ui_observability_control",
    trustedOrigins: [],
    handshakeTimeoutMs: 1500,
    openFinHost: "provider",
    openFinRole: "auto",
    maxBootBufferRecords: 500,
    orphanPolicy: "auto",
    maxHandshakeAttempts: 3,
  },
  capture: {
    errors: true,
    rejections: true,
    resourceErrors: false,
    fetch: false,
    xhr: false,
    interactions: false,
    navigation: false,
    webVitals: false,
    maxBreadcrumbs: 50,
    ignoreUrls: [],
    propagateTraceHeaderTo: [],
    errorDedupeMs: 5000,
  },
  limits: {
    maxBodyChars: 4096,
    maxAttributeChars: 8192,
    maxAttributeCount: 128,
    maxStackChars: 8192,
    maxDepth: 6,
    maxArrayLength: 100,
    maxRecordBytes: 32768,
  },
  console: { enabled: false, level: "DEBUG" },
};

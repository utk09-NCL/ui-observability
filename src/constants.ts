// src/constants.ts
//
// Defines all limits, thresholds, timing windows, storage keys, patterns, and
// defaults that the library uses.

import type { ConsoleStyles, ResolvedConfig } from "./models/config";
import type { LogLevel, LogType } from "./models/log-record";
import type { StorageLimits } from "./models/storage";

// ----------------------------------
// Library-wide
// ----------------------------------

/** Prefix on console messages this library writes. */
export const LIBRARY_LOG_PREFIX = "[ui-observability]";

// ----------------------------------
// Diagnostics
// ----------------------------------

/**
 * Throttle window for each diagnostic code, in milliseconds. It limits how often an error
 * loop calls the handler.
 */
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
 * Maps each log level to its OpenTelemetry severity number.
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
// Attribute and resource key names that records carry in the payload. The names
// follow OpenTelemetry conventions. The `uiobs.` prefix marks the fields of this library.

/** Record kind attribute key. */
export const ATTR_LOG_TYPE = "log.type";

/** Record sequence number in its context. It starts at 1. */
export const ATTR_LOG_SEQ = "log.seq";

/** Logger namespace attribute key. */
export const ATTR_APP_NAMESPACE = "app.namespace";

/** Document URL when the library built the record. */
export const ATTR_PAGE_URL = "page.url";

/**
 * HTTP request URL attribute key. Network capture sets it. Do not reuse `ATTR_PAGE_URL`.
 * The page URL overwrites the request target under that key.
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

/** Own fields of an Error reason, or the whole reason when it is not an Error. */
export const ATTR_ERROR_DATA = "error.data";

/** Breadcrumb history of an error record. */
export const ATTR_BREADCRUMBS = "breadcrumbs";

/**
 * Marks a record when the library drops its attributes because they exceed the byte budget.
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
 * Value of `telemetry.sdk.version`. The code does not read it from package.json.
 * Change it by hand when you change the version in package.json.
 * @see {@link RESOURCE_TELEMETRY_SDK_VERSION}
 */
export const TELEMETRY_SDK_VERSION = "0.9.2";

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

/**
 * ECS `log.level` names that differ from the lowercase severity text. ECS spells
 * the warning level in full. All other levels match in lowercase.
 * @see {@link SERIALIZER_NAME_ECS}
 */
export const ECS_LEVEL_NAMES: Partial<Record<LogLevel, string>> = { WARN: "warning" };

/** Content type for an OTLP/JSON body. */
export const CONTENT_TYPE_JSON = "application/json";

/** Content type for newline-delimited JSON. */
export const CONTENT_TYPE_NDJSON = "application/x-ndjson";

/** Nanoseconds per millisecond. */
export const NANOS_PER_MILLI = 1000000n;

/**
 * Matches a nanosecond epoch in decimal digits, for example "1755543600123000000".
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

/** Response header that carries sampling rules from the ingest server. */
export const HEADER_SAMPLING = "X-UiObs-Sampling";

/** Gzip encoding name. */
export const ENCODING_GZIP = "gzip";

/** Lowest valid HTTP status code. */
export const HTTP_STATUS_MIN = 100;

/** Highest valid HTTP status code. */
export const HTTP_STATUS_MAX = 599;

/** Lowest HTTP status code that accepts a batch. */
export const HTTP_SUCCESS_MIN = 200;

/** Lowest HTTP status code above the success range. */
export const HTTP_SUCCESS_END = 300;

/** 401, credentials missing or rejected. */
export const HTTP_UNAUTHORIZED = 401;

/** 403, valid credentials but access denied. */
export const HTTP_FORBIDDEN = 403;

/** 408, the server closed the connection after a timeout. The transport can retry. */
export const HTTP_REQUEST_TIMEOUT = 408;

/** 413, payload too large. The transport must split the batch. */
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

/** Content type for an exit payload. It is CORS-safelisted and does not cause a preflight. */
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

/** localStorage key prefix for a stored batch. */
export const BATCH_STORAGE_KEY_PREFIX = "ui-observability.batch.";

/** Zero-padded digit width for the creation time in a batch key. */
export const BATCH_KEY_TIME_WIDTH = 14;

/** localStorage key prefix for a batch that exit flush stores. */
export const EMERGENCY_STORAGE_KEY_PREFIX = "ui-observability.emergency.";

/** Maximum number of exit batches in the emergency queue. */
export const EMERGENCY_MAX_ENTRIES = 20;

/** Key that the library writes to test if localStorage accepts writes. */
export const STORAGE_PROBE_KEY = "ui-observability.probe";

/** Fraction of the store to evict on a quota error (1 in N). */
export const QUOTA_EVICTION_DIVISOR = 4;

/** DOMException name for a full store. */
export const QUOTA_EXCEEDED_ERROR = "QuotaExceededError";

/**
 * Native IndexedDB version. It starts at 11. Dexie, the previous adapter, opened the
 * same database at ten times its declared version. A version below 11 makes open()
 * fail with VersionError for an existing installation. Then no code can read the
 * batches in that database.
 */
export const INDEXEDDB_SCHEMA_VERSION = 11;

/** IndexedDB object store that holds batches. Dexie set this name before the library removed it. */
export const INDEXEDDB_STORE_NAME = "batches";

/** Index on the batch store that orders reads by creation time. */
export const INDEXEDDB_CREATED_AT_INDEX = "createdAt";

/** IndexedDB adapter/strategy name. */
export const STORAGE_NAME_INDEXEDDB = "indexeddb";

/** localStorage adapter/strategy name. */
export const STORAGE_NAME_LOCAL = "localstorage";

/** In-memory adapter/strategy name. */
export const STORAGE_NAME_MEMORY = "memory";

/** Name of the storage adapter that keeps nothing. */
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
 * Max whole-token length, in characters. It rejects an oversized token. It does not
 * validate the token content.
 * @see {@link JOURNEY_TOKEN_NAME_MAX_CHARS}
 */
export const JOURNEY_TOKEN_MAX_CHARS = 256;

/**
 * Time to wait for `fin.me.getOptions()`, in milliseconds. After this time, the
 * runtime continues without a seeded journey.
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
// FNV-1a hash constants. The sampler uses them to change a sampling key into a
// stable 0-1 fraction.

/** FNV-1a 32-bit offset basis. */
export const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
export const FNV_PRIME = 0x01000193;

/** Largest 32-bit unsigned value. */
export const UINT32_MAX = 0xffffffff;

/**
 * Types that minLevel does not drop. An action is an audit fact and a metric is a measurement.
 * The remote rate cap for records below minLevel does not apply to them.
 */
export const LEVEL_BYPASS_TYPES: readonly LogType[] = ["action", "metric"];

// ----------------------------------
// Pipeline
// ----------------------------------

/** Record kind routed to the metric stream. */
export const LOG_TYPE_METRIC: LogType = "metric";

/** Record kind of an audit fact. Storage and the hold buffers drop it last. */
export const LOG_TYPE_ACTION: LogType = "action";

// ----------------------------------
// Bus
// ----------------------------------

/** Protocol identifier for bus envelopes. The bus drops an envelope with a different version. */
export const BUS_PROTOCOL = "ui-observability/1";

/** Global window property key used to locate a same-origin runtime instance. */
export const RUNTIME_GLOBAL_KEY = "ui-observability.runtime";

/** Global key of the runtime that shutdown() stopped. Calls go to it until the next configure(). */
export const RUNTIME_STOPPED_KEY = "ui-observability.stopped";

/** Global symbol key of the library request scope count. All library copies on a page share it. */
export const LIBRARY_REQUEST_KEY = "ui-observability.request-scope";

/** Global symbol key of the library console scope count. All library copies on a page share it. */
export const LIBRARY_CONSOLE_KEY = "ui-observability.console-scope";

/** Global symbol key of the count of custom transport calls that wait for an answer. */
export const TRANSPORT_CALL_KEY = "ui-observability.transport-calls";

// ----------------------------------
// Capture
// ----------------------------------

/** Maximum error records captured per throttling window before suppression. */
export const ERROR_STORM_MAX_PER_WINDOW = 20;

/** Error rate-limiting window duration in milliseconds. */
export const ERROR_STORM_WINDOW_MS = 10_000;

/**
 * Max ERROR and FATAL records that the pipeline admits in each storm window.
 * It is a safety limit for a render loop. It does not shape normal traffic.
 * ERROR and FATAL records skip sampling. A direct logger.error call has no other limit.
 */
export const ERROR_CEILING_MAX_PER_WINDOW = 500;

/** Default minimum duration of a long frame that the library records, in milliseconds. */
export const LONG_FRAME_THRESHOLD_MS = 100;

/** Maximum long frames recorded in each storm window. A frozen tab cannot flood the pipeline. */
export const LONG_FRAME_MAX_PER_WINDOW = 20;

/** Maximum character length of a console breadcrumb message. */
export const CONSOLE_BREADCRUMB_MAX_CHARS = 200;

/** Maximum distinct error signatures tracked for deduplication before LRU eviction. */
export const MAX_TRACKED_ERROR_SIGNATURES = 200;

/** Maximum character length retained from clicked element text in breadcrumbs. */
export const CLICK_TEXT_MAX_CHARS = 50;

/** Maximum character length retained from an aria-label attribute in generated selectors. */
export const ARIA_LABEL_MAX_CHARS = 40;

/** Maximum class names included per element in generated CSS selectors. */
export const SELECTOR_MAX_CLASSES = 2;

/** Default CSS of the console prefix. The colors are readable on light and dark devtools. */
export const CONSOLE_DEFAULT_STYLES: Readonly<Required<ConsoleStyles>> = {
  namespace: "color:#888",
  TRACE: "color:#888;font-weight:bold",
  DEBUG: "color:#888;font-weight:bold",
  INFO: "color:#1e6fd9;font-weight:bold",
  WARN: "color:#c77700;font-weight:bold",
  ERROR: "color:#d32f2f;font-weight:bold",
  FATAL: "color:#d32f2f;font-weight:bold",
};

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

/** Measurement unit that the library uses when the call gives no unit. */
export const DEFAULT_METRIC_UNIT = "count";

/** Namespace of the points that the counter and histogram instruments give. */
export const METRIC_NAMESPACE = "uiobs.metrics";

/** Maximum attribute sets of one instrument in one interval. More sets go to one overflow set. */
export const METRIC_MAX_SERIES = 100;

/** Maximum bucket boundaries of one histogram. More boundaries make a large point. */
export const METRIC_MAX_BOUNDARIES = 50;

/** Attribute of the overflow set. OpenTelemetry uses the same key. */
export const ATTR_METRIC_OVERFLOW = "otel.metric.overflow";

/** Default histogram boundaries. They are the OpenTelemetry default boundaries. */
export const METRIC_DEFAULT_BOUNDARIES: readonly number[] = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
];

/**
 * Attribute keys of an aggregated metric point. The OTLP metrics serializer reads them.
 * Sampling keeps each record with a start time. A sample of a sum gives a false sum.
 */
export const METRIC_KEYS = {
  start: "metric.start_time_unix_nano",
  attributeKeys: "metric.attribute_keys",
  count: "metric.count",
  sum: "metric.sum",
  min: "metric.min",
  max: "metric.max",
  bounds: "metric.bounds",
  buckets: "metric.bucket_counts",
} as const;

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

/** Version of the remote sampling rules that the library accepts. */
export const REMOTE_SAMPLING_VERSION = 1;

/** Maximum length of the sampling header, in characters. */
export const REMOTE_SAMPLING_MAX_CHARS = 4096;

/** Maximum time that remote sampling rules stay in force, in milliseconds. */
export const REMOTE_SAMPLING_MAX_TTL_MS = 60 * 60 * 1000;

/** Maximum namespace rates in one set of remote sampling rules. */
export const REMOTE_SAMPLING_MAX_RATES = 100;

/** Time between two requests of a forwarder for the remote sampling rules, in milliseconds. */
export const REMOTE_SAMPLING_POLL_MS = 30_000;

/**
 * Config keys with no default, excluded from `DEFAULT_CONFIG`.
 * @see {@link DEFAULT_CONFIG}
 */
export const UNDEFAULTED_CONFIG_KEYS = [
  "redact",
  "onDiagnostic",
  "onDrop",
  "headers",
  "serializer",
  "otelLoader",
  "transport",
  "transportOnExit",
] as const;

/**
 * Nested config section keys.
 * @see {@link ResolvedConfig}
 */
export const CONFIG_SECTIONS = [
  "sampling",
  "bus",
  "journey",
  "batching",
  "retention",
  "limits",
  "capture",
] as const;

/**
 * Section keys with no default, excluded from their section of `DEFAULT_CONFIG`.
 * @see {@link UNDEFAULTED_CONFIG_KEYS}
 */
export const UNDEFAULTED_SECTION_KEYS: Record<(typeof CONFIG_SECTIONS)[number], string[]> = {
  sampling: [],
  bus: [],
  journey: [],
  batching: [],
  retention: [],
  limits: [],
  capture: ["webVitalsLoader"],
};

/** Console mirroring level used when a consumer passes `console: true`. */
export const CONSOLE_DEFAULT_LEVEL: LogLevel = "DEBUG";

// ----------------------------------
// Batching
// ----------------------------------

/** Max time a partial log batch waits before the pipeline sends it, in milliseconds. */
export const LOG_FLUSH_INTERVAL_MS = 2000;

/** Max records per log batch. At this count, the pipeline sends the batch early. */
export const LOG_BATCH_SIZE = 100;

/**
 * Max time a partial metric batch waits before the pipeline sends it, in milliseconds.
 * Metric batches wait longer than log batches. Metrics have a higher volume, and no
 * caller waits for them.
 */
export const METRIC_FLUSH_INTERVAL_MS = 10_000;

/** Max records per metric batch. At this count, the pipeline sends the batch early. */
export const METRIC_BATCH_SIZE = 500;

/** Max concurrent ingest requests, across both streams. */
export const MAX_CONCURRENT_REQUESTS = 2;

// ----------------------------------
// HTTP transport
// ----------------------------------

/** Max time for one ingest request, in milliseconds. Then the transport aborts and retries it. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Min payload size to compress, in bytes. */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

// ----------------------------------
// Storage retention
// ----------------------------------

/** IndexedDB database name. */
export const STORAGE_DB_NAME = "UiObservability";

/** Capacity and retention thresholds every storage adapter enforces. */
export const STORAGE_LIMITS: StorageLimits = {
  maxBatches: 500,
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxAttempts: 5,
};

/**
 * Max time for one storage call, in milliseconds. Then the library treats the call as failed.
 * A call that does not settle keeps a dispatch slot or the drain flag.
 */
export const STORAGE_DEADLINE_MS = 10_000;

// ----------------------------------
// Retry backoff
// ----------------------------------

/** First backoff step, in milliseconds. Each attempt doubles it. */
export const RETRY_BASE_DELAY_MS = 2000;

/** Backoff ceiling, in milliseconds. */
export const RETRY_MAX_DELAY_MS = 60_000;

/** How often to check for stored work when nothing has failed recently, in milliseconds. */
export const RETRY_IDLE_DELAY_MS = 30_000;

// ----------------------------------
// Journey lifetime
// ----------------------------------

/** Max time a journey stays open, in milliseconds. Then the library treats it as abandoned. */
export const JOURNEY_MAX_AGE_MS = 30 * 60 * 1000;

/** True if the journey ends for all contexts when the owning context closes. */
export const JOURNEY_END_ON_OWNER_CLOSE = false;

/** Query parameter checked at boot for a seeded journey token. */
export const JOURNEY_URL_PARAM = "__uiobs_journey";

// ----------------------------------
// Bus handshake
// ----------------------------------

/** BroadcastChannel name for the control plane. */
export const BUS_CHANNEL_NAME = "ui_observability_control";

/** Max time a forwarder waits for an owner to answer before it promotes itself, in milliseconds. */
export const BUS_HANDSHAKE_TIMEOUT_MS = 1500;

/** Handshake attempts allowed before a cross-origin forwarder promotes itself to sender. */
export const BUS_MAX_HANDSHAKE_ATTEMPTS = 3;

/** Max records that are not actions in one hold buffer. A full buffer drops the oldest. */
export const BUS_MAX_BOOT_BUFFER_RECORDS = 500;

/** Max action records in one hold buffer. Actions have their own cap. A log storm cannot push one out. */
export const BUS_MAX_BOOT_BUFFER_ACTIONS = 2000;

/** Max different values in each list of an onDrop summary. */
export const DROP_SUMMARY_MAX_ITEMS = 20;

/** Max characters of an untrusted message type in a diagnostic detail. The sender sets the text. */
export const BUS_TYPE_DETAIL_MAX_CHARS = 32;

// ----------------------------------
// Capture
// ----------------------------------

/** Breadcrumbs kept as context for the next error. */
export const MAX_BREADCRUMBS = 50;

/**
 * Time window in which the library counts identical errors but does not send them again,
 * in milliseconds.
 */
export const ERROR_DEDUPE_MS = 5000;

// ----------------------------------
// Per-record size caps
// ----------------------------------

/** Size caps for every record. The library applies them after sanitize and after redact. */
export const RECORD_LIMITS = {
  maxBodyChars: 4096,
  maxAttributeChars: 8192,
  maxAttributeCount: 128,
  maxStackChars: 8192,
  maxDepth: 6,
  maxArrayLength: 100,
  maxNodes: 10_000,
  maxRecordBytes: 32_768,
};

// ----------------------------------
// Config defaults
// ----------------------------------

/**
 * Default runtime config before the consumer calls `configure()`. It excludes `serializer`.
 * `resolveConfig` supplies that default to prevent a circular import.
 * It comes after the constants that it reads. A const cannot be read before its line.
 * @see {@link ResolvedConfig}
 * @see {@link UNDEFAULTED_CONFIG_KEYS}
 */
export const DEFAULT_CONFIG: Omit<ResolvedConfig, "serializer"> = {
  endpoint: "",
  metricsEndpoint: "",
  serviceName: "",
  serviceVersion: "",
  environment: "",
  enabled: true,
  minLevel: "INFO",
  compression: "gzip",
  credentials: "omit",
  storage: "auto",
  identity: "storage",
  sampling: {
    defaultRate: 1,
    rates: {},
    alwaysSampleTypes: ["action"],
    remote: false,
    remoteMaxRate: 1,
  },
  bus: { mode: "auto", trustedOrigins: [], openFinRole: "auto" },
  journey: { scope: "auto", maxAgeMs: JOURNEY_MAX_AGE_MS },
  batching: {
    logFlushIntervalMs: LOG_FLUSH_INTERVAL_MS,
    logBatchSize: LOG_BATCH_SIZE,
    metricFlushIntervalMs: METRIC_FLUSH_INTERVAL_MS,
    metricBatchSize: METRIC_BATCH_SIZE,
  },
  retention: { mode: "limited", ...STORAGE_LIMITS },
  limits: { ...RECORD_LIMITS },
  capture: {
    errors: true,
    rejections: true,
    resourceErrors: false,
    fetch: false,
    xhr: false,
    httpMetrics: true,
    interactions: false,
    navigation: false,
    webVitals: false,
    longFrames: false,
    longFrameThresholdMs: LONG_FRAME_THRESHOLD_MS,
    console: false,
    fullUrls: false,
    ignoreUrls: [],
    propagateTraceHeaderTo: [],
  },
  console: { level: null, styles: CONSOLE_DEFAULT_STYLES },
};

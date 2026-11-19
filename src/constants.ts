// src/constants.ts
//
// Every limit, threshold, timing window, storage key, pattern and default the
// library uses.

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
 * Throttle window per diagnostic code, in milliseconds. Limits how often an error
 * loop can call the handler.
 */
export const DIAGNOSTIC_THROTTLE_MS = 1000;

// ----------------------------------
// Identity
// ----------------------------------

/** `localStorage` key for the session id and its last-seen time. */
export const SESSION_ID_KEY = "ui-observability.session";

/** `sessionStorage` key for the tab id. */
export const TAB_ID_KEY = "ui-observability.tab";

/** sessionStorage key for a live page's marker. A clean close removes it. */
export const ALIVE_KEY = "ui-observability.alive";

/** How often the alive marker is updated, in milliseconds. */
export const ALIVE_UPDATE_MS = 30_000;

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
// The attribute and resource key names records carry in the payload. They follow the
// OpenTelemetry conventions, and the `uiobs.` prefix marks this library's own fields.

/** Record kind attribute key. */
export const ATTR_LOG_TYPE = "log.type";

/** A record's sequence number within its context. Starts at 1. */
export const ATTR_LOG_SEQ = "log.seq";

/** Logger namespace attribute key. */
export const ATTR_APP_NAMESPACE = "app.namespace";

/** The document URL at the time the record was built. */
export const ATTR_PAGE_URL = "page.url";

/**
 * HTTP request URL attribute key, set by network capture. Don't reuse `ATTR_PAGE_URL` for it,
 * because the page URL overwrites the request target under that key.
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

/** An Error reason's own fields, or the whole reason when it isn't an Error. */
export const ATTR_ERROR_DATA = "error.data";

/** An error record's breadcrumb history. */
export const ATTR_BREADCRUMBS = "breadcrumbs";

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

/** Server time minus client time, in milliseconds, from an accepted answer's Date header. */
export const ATTR_CLOCK_OFFSET_MS = "uiobs.clock_offset_ms";

/** Marks a record the debug buffer held until an error. */
export const ATTR_DEBUG_BUFFER = "uiobs.debug_buffer";

/** Half the HTTP Date header's resolution. Centers the clock offset's error. */
export const DATE_HEADER_HALF_STEP_MS = 500;

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
 * Value of `telemetry.sdk.version`. The build writes the package.json version here.
 * @see {@link RESOURCE_TELEMETRY_SDK_VERSION}
 */
export const TELEMETRY_SDK_VERSION = __UIOBS_VERSION__;

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
 * the warning level out in full, and every other level matches in lowercase.
 * @see {@link SERIALIZER_NAME_ECS}
 */
export const ECS_LEVEL_NAMES: Partial<Record<LogLevel, string>> = { WARN: "warning" };

/** The ECS version of the documents, the same one the Elastic ECS logging libraries write. */
export const ECS_VERSION = "8.10.0";

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

/** Response header that gives the server time. The server must expose it to CORS. */
export const HEADER_DATE = "Date";

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

/** 415, unsupported media type. A stock OpenTelemetry Collector gives it to a text/plain batch. */
export const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;

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

/** Largest ingest response body the library reads, in bytes. It skips a larger body. */
export const RESPONSE_BODY_LIMIT_BYTES = 16_384;

/** Longest server message that a diagnostic repeats. The server controls this text. */
export const SERVER_MESSAGE_MAX_CHARS = 256;

/** Content type for an exit payload. CORS-safelisted, so it doesn't trigger a preflight. */
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

/** localStorage key prefix for a batch stored by the exit flush. */
export const EMERGENCY_STORAGE_KEY_PREFIX = "ui-observability.emergency.";

/** Maximum number of exit batches in the emergency queue. */
export const EMERGENCY_MAX_ENTRIES = 20;

/** Key we write to check whether localStorage accepts writes. */
export const STORAGE_PROBE_KEY = "ui-observability.probe";

/** Fraction of the store to evict on a quota error (1 in N). */
export const QUOTA_EVICTION_DIVISOR = 4;

/** DOMException name for a full store. */
export const QUOTA_EXCEEDED_ERROR = "QuotaExceededError";

/**
 * Native IndexedDB version. Version 11 replaced Dexie, and version 12 adds the context index.
 * Dexie opened this database at ten times its declared version, so a version below 11 makes
 * open() fail with VersionError on an existing installation, and then nothing can read its
 * batches.
 */
export const INDEXEDDB_SCHEMA_VERSION = 12;

/** IndexedDB object store that holds the batches. The name dates from Dexie, since removed. */
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
 * Max length of a journey id from startJourney(), in characters. A journey with an id this long
 * and a full-length name still gets a token below the token limit.
 * @see {@link JOURNEY_TOKEN_MAX_CHARS}
 */
export const JOURNEY_ID_MAX_CHARS = 64;

/**
 * Accepted journey id from startJourney(): letters, digits, "_", ".", ":" and "-". Every
 * character is one byte in UTF-8. A multibyte id would push the token over its limit.
 */
export const JOURNEY_ID_PATTERN = new RegExp(`^[\\w.:-]{1,${String(JOURNEY_ID_MAX_CHARS)}}$`);

/**
 * How far ahead of this clock a journey token's start time can be, in milliseconds. Two machines
 * can disagree on the time, but a token further ahead than this would never expire.
 */
export const JOURNEY_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Max whole-token length, in characters. This only rejects an oversized token. It doesn't
 * validate the token's content.
 * @see {@link JOURNEY_TOKEN_NAME_MAX_CHARS}
 */
export const JOURNEY_TOKEN_MAX_CHARS = 256;

/**
 * How long to wait for `fin.me.getOptions()`, in milliseconds. After that, the
 * runtime carries on without a seeded journey.
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
// FNV-1a hash constants. The sampler uses them to turn a sampling key into a
// stable 0-1 fraction.

/** FNV-1a 32-bit offset basis. */
export const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
export const FNV_PRIME = 0x01000193;

/** Largest 32-bit unsigned value. */
export const UINT32_MAX = 0xffffffff;

/**
 * Types that minLevel never drops. An action is an audit fact, and a metric or a span is a
 * measurement. The remote rate cap for records below minLevel doesn't apply to them either.
 */
export const LEVEL_BYPASS_TYPES: readonly LogType[] = ["action", "metric", "span"];

// ----------------------------------
// Pipeline
// ----------------------------------

/** Record kind routed to the metric stream. */
export const LOG_TYPE_METRIC: LogType = "metric";

/** Record kind of an audit fact. Storage and the hold buffers drop it last. */
export const LOG_TYPE_ACTION: LogType = "action";

/** Record kind routed to the trace stream. */
export const LOG_TYPE_SPAN: LogType = "span";

// ----------------------------------
// Bus
// ----------------------------------

/** Protocol identifier for bus envelopes. The bus drops an envelope with a different version. */
export const BUS_PROTOCOL = "ui-observability/2";

/**
 * Type tag for every bus message. Every frame must use the same values. The prefix makes a
 * message easy to spot in a postMessage log, but it is still the BUS_PROTOCOL envelope tag that
 * separates the bus from other traffic.
 */
export const BUS_TYPE = {
  hello: "ui-observability.message.hello",
  welcome: "ui-observability.message.welcome",
  records: "ui-observability.message.records",
  securityContext: "ui-observability.message.security-context",
  journey: "ui-observability.message.journey",
  journeyRequest: "ui-observability.message.journey-request",
  sampling: "ui-observability.message.sampling",
  samplingRequest: "ui-observability.message.sampling-request",
  tab: "ui-observability.message.tab",
  flushRequest: "ui-observability.message.flush-request",
  flushResult: "ui-observability.message.flush-result",
} as const;

/** Global window property key used to locate a same-origin runtime instance. */
export const RUNTIME_GLOBAL_KEY = "ui-observability.runtime";

/** Global key for the runtime shutdown() stopped. Calls go to it until the next configure(). */
export const RUNTIME_STOPPED_KEY = "ui-observability.stopped";

/** Global symbol key for the library request scope count, shared by every copy on the page. */
export const LIBRARY_REQUEST_KEY = "ui-observability.request-scope";

/** Global symbol key for the library console scope count, shared by every copy on the page. */
export const LIBRARY_CONSOLE_KEY = "ui-observability.console-scope";

/** Global symbol key for the number of custom transport calls still waiting for an answer. */
export const TRANSPORT_CALL_KEY = "ui-observability.transport-calls";

// ----------------------------------
// Capture
// ----------------------------------

/** Maximum error records captured per throttling window before suppression. */
export const ERROR_STORM_MAX_PER_WINDOW = 20;

/**
 * Default length of the capture rate limit window, and of the replay upload and error ceiling
 * windows, in milliseconds.
 */
export const ERROR_STORM_WINDOW_MS = 10_000;

/**
 * Max ERROR and FATAL records the pipeline admits per storm window. This is a safety limit for
 * a render loop, not a way to shape normal traffic. ERROR and FATAL records skip sampling, so a
 * direct logger.error call has no other limit.
 */
export const ERROR_CEILING_MAX_PER_WINDOW = 500;

/** Default minimum duration for a long frame to be recorded, in milliseconds. */
export const LONG_FRAME_THRESHOLD_MS = 100;

/** Maximum long frames recorded per storm window, so a frozen tab can't flood the pipeline. */
export const LONG_FRAME_MAX_PER_WINDOW = 20;

/** Max WebSocket events recorded per storm window, so a reconnect loop can't flood the pipeline. */
export const WEBSOCKET_MAX_PER_WINDOW = 20;

/** Maximum character length of a console breadcrumb message. */
export const CONSOLE_BREADCRUMB_MAX_CHARS = 200;

/** Maximum distinct error signatures tracked for deduplication before LRU eviction. */
export const MAX_TRACKED_ERROR_SIGNATURES = 200;

/** Maximum characters of a clicked element's text kept in a breadcrumb. */
export const CLICK_TEXT_MAX_CHARS = 50;

/** Attribute that names a click action, unless the app configures a different one. */
export const ACTION_ATTRIBUTE_DEFAULT = "data-observability-action";

/**
 * Selector for the regions the app keeps out of the records. Click capture skips them by
 * default, and session replay always blocks them, so a hidden region can't leak through either.
 */
export const IGNORE_SELECTOR = "[data-observability-ignore]";

/** How many clicks on one element make a rage click, by default. */
export const RAGE_CLICK_COUNT = 3;

/** The time window a rage click's clicks must fall within, in milliseconds, by default. */
export const RAGE_CLICK_WINDOW_MS = 1000;

/** How long to wait for a visible response before a click counts as dead, in milliseconds. */
export const DEAD_CLICK_MS = 1000;

/** Controls that should respond visibly to a click. Only these get a dead click check. */
export const DEAD_CLICK_CONTROLS =
  'a, button, summary, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [role="link"], [role="menuitem"], [role="tab"]';

/** Maximum characters of an aria-label kept in a generated selector. */
export const ARIA_LABEL_MAX_CHARS = 40;

/** Maximum class names per element in a generated CSS selector. */
export const SELECTOR_MAX_CLASSES = 2;

/** Default CSS for the console prefix. The colors are readable in light and dark devtools. */
export const CONSOLE_DEFAULT_STYLES: Readonly<Required<ConsoleStyles>> = {
  namespace: "color:#888",
  TRACE: "color:#888;font-weight:bold",
  DEBUG: "color:#888;font-weight:bold",
  INFO: "color:#1e6fd9;font-weight:bold",
  WARN: "color:#c77700;font-weight:bold",
  ERROR: "color:#d32f2f;font-weight:bold",
  FATAL: "color:#d32f2f;font-weight:bold",
};

// ----------------------------------
// Runtime
// ----------------------------------

/** Minimum time between storage gap warning reports, in milliseconds. */
export const GAP_REPORT_THROTTLE_MS = 60_000;

/** Default namespace for records the auto-capture modules emit. */
export const CAPTURE_NAMESPACE = "uiobs.capture";

/** Default namespace for records the storage subsystems emit. */
export const STORAGE_NAMESPACE = "uiobs.storage";

/** Namespace for the records `diagnostics.records` produces. */
export const DIAGNOSTICS_NAMESPACE = "uiobs.diagnostics";

/** The measurement unit used when a call doesn't give one. */
export const DEFAULT_METRIC_UNIT = "count";

/** Namespace for the points the counter and histogram instruments produce. */
export const METRIC_NAMESPACE = "uiobs.metrics";

/** Maximum attribute sets per instrument per interval. Any more go into one overflow set. */
export const METRIC_MAX_SERIES = 100;

/** Maximum bucket boundaries per histogram. More than that makes for a large point. */
export const METRIC_MAX_BOUNDARIES = 50;

/** Attribute on the overflow set. OpenTelemetry uses the same key. */
export const ATTR_METRIC_OVERFLOW = "otel.metric.overflow";

/** Default histogram boundaries, the same as OpenTelemetry's defaults. */
export const METRIC_DEFAULT_BOUNDARIES: readonly number[] = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
];

/**
 * Attribute keys on an aggregated metric point, read by the OTLP metrics serializer.
 * Sampling keeps every record that has a start time, because sampling a sum gives a false sum.
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

/** Precision of the profiler histogram: 2^4 = 16 sub-buckets per power of two. */
export const PROFILE_SUB_BITS = 4;

/** Buckets per probe: 16 for 0 to 15 us, then 16 for each exponent from 4 to 25. */
export const PROFILE_BUCKETS = 368;

/** Largest tracked duration in microseconds (2^26 - 1). Larger values go in the last bucket. */
export const PROFILE_MAX_US = 67_108_863;

/** Cap on the buckets in one profiler summary record, to keep the payload small. */
export const PROFILE_POINT_BUCKETS = 100;

/** Default probe limit. The runtime fixes the limit at startup. */
export const PROFILER_MAX_PROBES = 64;

/** Metric name for profiler summary records. */
export const PROFILE_METRIC_NAME = "ui.profile.duration";

/** Attribute keys on profiler summary records. */
export const PROFILE_KEYS = {
  probe: "profile.probe",
  sampleEvery: "profile.sample_every",
  p50: "profile.p50",
  p90: "profile.p90",
  p99: "profile.p99",
  overhead: "profile.overhead_ns",
  selfP99: "profile.self_p99",
  framePhase: "profile.frame_phase",
} as const;

/** How deep spans can nest and still get a self time. Going deeper drops the frames below. */
export const PROFILER_STACK_DEPTH = 32;

/** How many recent spans the profiler keeps for linking to long animation frames. */
export const PROFILER_RING_SPANS = 256;

/** Shortest span, in ms, that gets linked to a long animation frame. */
export const PROFILER_LINK_MIN_MS = 1;

/** Metric name for long animation frame phases, reported per probe in the frame. */
export const PROFILE_FRAME_METRIC_NAME = "ui.profile.frame.duration";

/** Probe name for frame pacing. Each value is the time between two frames. */
export const PROFILE_FRAME_PROBE = "frame.interval";

/** Reported when the library can't read an instrument's options. */
export const INSTRUMENT_OPTIONS_FAULT =
  "The library could not read the options of an instrument. The library uses the defaults.";

/** Ambient attribute that ties every record to the session replay recording. */
export const REPLAY_ID_KEY = "replay.id";

/** Put this attribute on an element to leave its text unmasked in session replay. */
export const REPLAY_UNMASK_ATTRIBUTE = "data-observability-unmask";

/** Hard cap on registered probe names, and so the upper bound for profiler.maxProbes. */
export const PROFILER_PROBE_LIMIT = 1024;

/** Global symbol key for the profiler core. Copies of the same library version share the core. */
export const PROFILER_GLOBAL_KEY = "ui-observability.profiler";

/** Minimum window for the profiler's overhead measurement, in ms. */
export const PROFILER_CALIBRATION_MS = 2;

/** Cap on begin()/end() pairs in the profiler's overhead measurement. */
export const PROFILER_CALIBRATION_PAIRS = 100_000;

/** Namespace of the span records. */
export const TRACE_NAMESPACE = "uiobs.traces";

/** Attribute keys for the span fields on a span record, read by the traces serializer. */
export const SPAN_KEYS = {
  kind: "span.kind",
  parentId: "span.parent_id",
  start: "span.start_time_unix_nano",
  end: "span.end_time_unix_nano",
  status: "span.status",
  linkTraceId: "span.link.trace_id",
  linkSpanId: "span.link.span_id",
} as const;

// ----------------------------------
// Configuration
// ----------------------------------

/** Protocol for the private transport worker channel. */
export const TRANSPORT_WORKER_PROTOCOL = "ui-observability.transport/1";

/** Type tags for the private transport worker messages. */
export const TRANSPORT_WORKER_TYPE = {
  connect: "connect",
  ready: "ready",
  send: "send",
  result: "result",
  cancel: "cancel",
} as const;

/** The worker entry's refusal message. A constant keeps the protocol code out of the main chunk. */
export const TRANSPORT_WORKER_REFUSAL = {
  p: TRANSPORT_WORKER_PROTOCOL,
  v: TELEMETRY_SDK_VERSION,
  t: TRANSPORT_WORKER_TYPE.ready,
  ok: false,
} as const;

/** Maximum requests in one transport worker. */
export const TRANSPORT_WORKER_MAX_JOBS = 64;

/**
 * Extra wait for the transport worker's answer after the request deadline. The worker replies
 * with a status it got in time when the deadline ends its body read, and that reply needs a
 * message hop.
 */
export const WORKER_REPLY_GRACE_MS = 1_000;

/** Longest the deferred logger waits for idle time before it builds its records. */
export const DEFER_IDLE_TIMEOUT_MS = 1000;

/** Maximum pending payload references per runtime. A full queue builds its records first. */
export const DEFER_QUEUE_LIMIT = 1000;

/** Default minimum duration for a slow resource event, in milliseconds. */
export const RESOURCE_SLOW_MS = 1000;

/** Response header with server duration entries. */
export const SERVER_TIMING_HEADER = "Server-Timing";

/** Maximum Server-Timing header length and entry count. */
export const SERVER_TIMING_MAX_CHARS = 4096;
export const SERVER_TIMING_MAX_ENTRIES = 32;

/** Capture switches a remote rule can change. Privacy controls stay local. */
export const REMOTE_CAPTURE_FLAGS = [
  "errors",
  "rejections",
  "resourceErrors",
  "fetch",
  "xhr",
  "httpMetrics",
  "navigation",
  "webVitals",
  "longFrames",
  "interactions",
  "console",
  "webSocket",
  "uncleanExit",
  "userTiming",
  "serverTiming",
  "reports",
  "resourceTiming",
  "lifecycle",
] as const;

/** Default `service.name` when a consumer sets none. */
export const UNKNOWN_SERVICE_NAME = "unknown-service";

/** Lowest sampling rate (drop everything). */
export const SAMPLING_RATE_MIN = 0;

/** Highest sampling rate (keep everything). */
export const SAMPLING_RATE_MAX = 1;

/** The remote sampling rules version this library accepts. */
export const REMOTE_SAMPLING_VERSION = 1;

/** Maximum length of the sampling header, in characters. */
export const REMOTE_SAMPLING_MAX_CHARS = 4096;

/** Longest that remote sampling rules stay in effect, in milliseconds. */
export const REMOTE_SAMPLING_MAX_TTL_MS = 60 * 60 * 1000;

/** Maximum namespace rates in one set of remote sampling rules. */
export const REMOTE_SAMPLING_MAX_RATES = 100;

/** How often a forwarder asks for the remote sampling rules, in milliseconds. */
export const REMOTE_SAMPLING_POLL_MS = 30_000;

/**
 * Config keys with no default, excluded from `DEFAULT_CONFIG`.
 * @see {@link DEFAULT_CONFIG}
 */
export const UNDEFAULTED_CONFIG_KEYS = [
  "contextProvider",
  "redact",
  "onDiagnostic",
  "onDrop",
  "headers",
  "serializer",
  "otelLoader",
  "transport",
  "transportOnExit",
  "transportWorker",
] as const;

/**
 * Nested config section keys.
 * @see {@link ResolvedConfig}
 */
export const CONFIG_SECTIONS = [
  "captureLimits",
  "metadata",
  "storage",
  "diagnostics",
  "correlation",
  "metrics",
  "buffering",
  "delivery",
  "loggerCache",
  "securityContext",
  "sampling",
  "bus",
  "journey",
  "batching",
  "retention",
  "limits",
  "capture",
  "debugBuffer",
  "profiler",
  "replay",
] as const;

/**
 * Section keys with no default, excluded from their section of `DEFAULT_CONFIG`.
 * @see {@link UNDEFAULTED_CONFIG_KEYS}
 */
export const UNDEFAULTED_SECTION_KEYS: Record<(typeof CONFIG_SECTIONS)[number], string[]> = {
  captureLimits: [],
  metadata: [],
  storage: [],
  diagnostics: [],
  correlation: [],
  metrics: [],
  buffering: [],
  delivery: [],
  loggerCache: [],
  securityContext: [],
  sampling: [],
  bus: [],
  journey: [],
  batching: [],
  retention: [],
  limits: [],
  capture: ["urlTransform"],
  debugBuffer: [],
  profiler: [],
  replay: [],
};

/** Console output level used when a consumer passes `consoleOutput: true`. */
export const CONSOLE_DEFAULT_LEVEL: LogLevel = "DEBUG";

// ----------------------------------
// Batching
// ----------------------------------

/** Max time a partial log batch waits before the pipeline sends it, in milliseconds. */
export const LOG_FLUSH_INTERVAL_MS = 2000;

/** Max records per log batch. At this count, the pipeline sends the batch early. */
export const LOG_BATCH_SIZE = 100;

/**
 * Default interval of the counter, histogram and profiler points, in milliseconds. A partial
 * metric batch waits this long too, longer than a log batch, because metrics have a higher
 * volume and no caller is waiting for them.
 */
export const METRIC_INTERVAL_MS = 10_000;

/** Max records per metric batch. At this count, the pipeline sends the batch early. */
export const METRIC_BATCH_SIZE = 500;

/** Max concurrent ingest requests, across both streams. */
export const MAX_CONCURRENT_REQUESTS = 2;

// ----------------------------------
// HTTP transport
// ----------------------------------

/** Max time for one ingest request, in milliseconds. The transport then aborts and retries it. */
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
 * Max time for one storage call, in milliseconds. After that the call counts as failed, because
 * a call that never settles would hold on to a dispatch slot or the drain flag.
 */
export const STORAGE_DEADLINE_MS = 10_000;

/** Default wait of flush() and of a rotation's flush, in milliseconds. */
export const FLUSH_TIMEOUT_MS = 5000;

/**
 * Longest wait of flush() and of a rotation's flush, in milliseconds. A browser timer fires at
 * once for a delay above 2^31 - 1 ms, so the wait has a ceiling.
 */
export const FLUSH_TIMEOUT_MAX_MS = 600_000;

// ----------------------------------
// Retry backoff
// ----------------------------------

/** First backoff step, in milliseconds. Doubles with every attempt. */
export const RETRY_BASE_DELAY_MS = 2000;

/** Backoff ceiling, in milliseconds. */
export const RETRY_MAX_DELAY_MS = 60_000;

/** How often to check for stored work when nothing has failed recently, in milliseconds. */
export const RETRY_IDLE_DELAY_MS = 30_000;

// ----------------------------------
// Journey lifetime
// ----------------------------------

/** Max time a journey stays open, in milliseconds. After that it counts as abandoned. */
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

/**
 * Max named sources, for example OpenFin identities, whose message rate the bus tracks at once.
 * A new source past it is refused, so a flood of fake names can't grow the map without end.
 */
export const BUS_MAX_TRACKED_SOURCES = 256;

/**
 * Max flush requests from other contexts that wait for the next flush. A request past it gets
 * no answer, so a flood of requests can't grow the list without end.
 */
export const BUS_MAX_FLUSH_REQUESTS = 100;

/** Max flush requests of one source that wait, so one frame can't fill the whole list. */
export const BUS_MAX_FLUSH_REQUESTS_PER_SOURCE = 4;

/**
 * Min time between the starts of two flushes that the bus runs for other contexts, in
 * milliseconds. A request in the gap joins the next one, so a flood can't flush without a pause.
 */
export const BUS_FLUSH_GAP_MS = 1000;

/**
 * Share of a forwarder's time left that it gives its sender in a flush request. The rest is for
 * the answer, so the caller's wait outlasts the callee's deadline at each hop of a chain.
 */
export const FLUSH_REQUEST_SHARE = 0.9;

/** Default of buffering.maxHeldRecords, the cap on non-action records in one hold buffer. */
export const BUS_MAX_BOOT_BUFFER_RECORDS = 500;

/** Max action records in one hold buffer. Their own cap means a log storm can't push one out. */
export const BUS_MAX_BOOT_BUFFER_ACTIONS = 2000;

/**
 * Records of each kind that a full hold buffer never drops, counted from the first one. The
 * first error of a failed startup is usually the cause, so it has to outlive the storm.
 */
export const HOLD_BUFFER_HEAD_RECORDS = 100;

/** Max distinct values in each list of an onDrop summary. */
export const DROP_SUMMARY_MAX_ITEMS = 20;

/**
 * Max characters of an untrusted message type in a diagnostic detail, since the sender controls
 * that text. The longest BUS_TYPE value is 41 characters, so every valid type fits.
 */
export const BUS_TYPE_DETAIL_MAX_CHARS = 48;

// ----------------------------------
// Capture
// ----------------------------------

/** Breadcrumbs kept as context for the next error. */
export const MAX_BREADCRUMBS = 50;

/** How long identical errors are counted without being sent again, in milliseconds. */
export const ERROR_DEDUPE_MS = 5000;

// ----------------------------------
// Per-record size caps
// ----------------------------------

/** Size caps for every record, applied after sanitize and after redact. */
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
 * Routing settings a rotation resets when the update leaves them out. The rotation also spreads
 * this into its base, where undefined means no hook, so an undefined key in the update resets too.
 */
export const ROUTING_RESET = {
  endpoint: null,
  metricsEndpoint: null,
  tracesEndpoint: null,
  headers: undefined,
  credentials: "omit",
  transport: undefined,
  transportOnExit: undefined,
  transportWorker: undefined,
} as const;

/** Routing settings that configure() can't change while isolation is on. */
export const ROUTING_KEYS = Object.keys(ROUTING_RESET) as (keyof typeof ROUTING_RESET)[];

/**
 * The default runtime config, before the consumer calls `configure()`. `serializer` is left
 * out, because `resolveConfig` supplies that default to avoid a circular import.
 * This sits below the constants it reads, since a const can't be read before its own line.
 * @see {@link ResolvedConfig}
 * @see {@link UNDEFAULTED_CONFIG_KEYS}
 */
export const DEFAULT_CONFIG: Omit<ResolvedConfig, "serializer"> = {
  captureLimits: {
    breadcrumbs: MAX_BREADCRUMBS,
    errorDedupeMs: ERROR_DEDUPE_MS,
    errorsPerWindow: 20,
    consolePerWindow: 20,
    longFramesPerWindow: 20,
    webSocketPerWindow: 20,
    reportsPerWindow: 20,
    resourcesPerWindow: 100,
    lifecyclePerWindow: 20,
    windowMs: ERROR_STORM_WINDOW_MS,
  },
  metadata: { pageUrl: true, userAgent: true, openfin: true, clockOffset: true },
  debugBuffer: { enabled: false, maxRecords: 200, maxAgeMs: 60_000 },
  profiler: {
    enabled: false,
    maxProbes: PROFILER_MAX_PROBES,
    framePhases: false,
    framePacing: false,
  },
  replay: {
    enabled: false,
    mode: "onError",
    endpoint: null,
    requireConsent: false,
    bufferMs: 60_000,
    maxBufferBytes: 10_000_000,
    afterErrorMs: 5000,
    uploadsPerWindow: 3,
    uploadWindowMs: ERROR_STORM_WINDOW_MS,
    maxSegmentEvents: 200,
    maxSegmentBytes: 512_000,
    flushIntervalMs: 2000,
    maxQueueBytes: 20_000_000,
    maxAttempts: 3,
    maskText: true,
    maskInputs: true,
    recordCanvas: false,
    maskSelectors: [],
    blockSelectors: [],
    loader: null,
    onSegment: null,
    headers: null,
    plugins: [],
    recordOptions: {},
  },
  storage: { backend: "auto", namespace: "", requestPersistent: false },
  diagnostics: { throttleMs: 1000, consoleFallback: false, records: false },
  correlation: { sessionIdleMs: SESSION_IDLE_MS, traceMaxAgeMs: TRACE_MAX_AGE_MS },
  metrics: {
    intervalMs: METRIC_INTERVAL_MS,
    maxSeries: METRIC_MAX_SERIES,
    maxInstruments: 1000,
    maxHistogramBoundaries: METRIC_MAX_BOUNDARIES,
  },
  buffering: {
    maxPendingRecords: 10000,
    maxPendingBytes: 16777216,
    maxHeldRecords: BUS_MAX_BOOT_BUFFER_RECORDS,
    overflow: "drop-oldest",
  },
  delivery: {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
    retryBaseDelayMs: RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: RETRY_MAX_DELAY_MS,
    priority: "low",
  },
  lockConfiguration: false,
  loggerCache: { maxEntries: 256 },
  securityContext: { id: "", isolation: true },
  // "" means not set, so a configure() without an endpoint reports it. An app can't pass "".
  endpoint: "",
  metricsEndpoint: null,
  tracesEndpoint: null,
  serviceName: "",
  serviceVersion: "",
  environment: "",
  enabled: true,
  payloadMode: "copy",
  minLevel: "INFO",
  minLevels: {},
  processors: [],
  compression: "gzip",
  credentials: "omit",
  identity: "storage",
  sampling: {
    defaultRate: 1,
    rates: {},
    alwaysSampleTypes: ["action"],
    alwaysSampleFrom: "ERROR",
    errorCeiling: ERROR_CEILING_MAX_PER_WINDOW,
    errorCeilingWindowMs: ERROR_STORM_WINDOW_MS,
    remote: false,
    remoteMaxRate: 1,
  },
  bus: {
    mode: "auto",
    trustedOrigins: [],
    openFinRole: "auto",
    sourcePolicy: "registered",
    maxMessageBytes: 262144,
    maxRecordsPerMessage: 100,
    maxMessagesPerSecond: 100,
  },
  journey: { scope: "auto", maxAgeMs: JOURNEY_MAX_AGE_MS },
  batching: {
    logFlushIntervalMs: LOG_FLUSH_INTERVAL_MS,
    logBatchSize: LOG_BATCH_SIZE,
    metricBatchSize: METRIC_BATCH_SIZE,
  },
  retention: { ...STORAGE_LIMITS },
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
    console: false,
    fullUrls: false,
    ignoreUrls: [],
    propagateTraceHeaderTo: [],
    webSocket: false,
    uncleanExit: false,
    userTiming: false,
    remoteToggles: [],
    serverTiming: false,
    reports: false,
    resourceTiming: false,
    lifecycle: false,
    plugins: [],
  },
  consoleOutput: { level: null, styles: CONSOLE_DEFAULT_STYLES },
};

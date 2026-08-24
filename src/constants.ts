// src/constants.ts
//
// Every constant the library uses, in one file. A default beside the code that
// reads it is invisible to everyone else, and two modules needing the same
// number end up with two copies that drift.
//
// Here: every limit, threshold, timing window, storage key, pattern and
// default, plus any literal more than one module has to agree on.
//
// Inline instead: arithmetic that explains itself, such as the byte widths in
// the UTF-8 estimator, and single-use display fallbacks read at the line that
// produces them.
//
// Values only. A "constant" needing a branch to compute is not one, and it
// would put an untestable branch in the file no test imports directly.

import type { ResolvedConfig } from "./models/config";
import type { LogLevel } from "./models/log-record";

// ----------------------------------
// Library-wide
// ----------------------------------

/** Tag on anything this library writes to the host console, so a consumer can spot and filter it. */
export const LIBRARY_LOG_PREFIX = "[ui-observability]";

// ----------------------------------
// Diagnostics
// ----------------------------------

/**
 * Default window in which one diagnostic code may emit at most one event. A
 * broken render loop produces ten thousand identical errors a second, and a
 * handler called that often is itself the outage. Counting is never throttled.
 */
export const DIAGNOSTIC_THROTTLE_MS = 1000;

// ----------------------------------
// Identity
// ----------------------------------

/**
 * localStorage key holding the session id and the time it was last seen. Shared by every tab on the
 * origin.
 */
export const SESSION_ID_KEY = "ui-observability.session";

/**
 * sessionStorage key holding the tab id. Per tab rather than per origin, which is why the store
 * differs from the session's.
 */
export const TAB_ID_KEY = "ui-observability.tab";

/** Idle time after which the stored session id is abandoned and a new visit begins. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * Minimum spacing between two writes of the session's last-seen time. The
 * record path is the only place that knows the user is still here, and it is
 * hot, so keeping a session alive costs one compare rather than a write.
 */
export const SESSION_TOUCH_MS = 60_000;

/**
 * Length of a generated id in bytes, when there is no `crypto.randomUUID` to call. Sixteen bytes
 * matches a UUID.
 */
export const ID_BYTE_LENGTH = 16;

/**
 * The number of distinct values one byte holds, used as the exclusive ceiling for a random byte.
 */
export const BYTE_VALUE_COUNT = 256;

// ----------------------------------
// Platform detection
// ----------------------------------

/**
 * Marks the OpenFin desktop runtime in a user agent. Both it and the Core Web
 * adapter expose `fin`, so this pattern is the only thing separating them.
 */
export const OPENFIN_UA_PATTERN = /OpenFin/i;

/**
 * The `wv` token Android stamps into the user agent of a webview, as opposed to Chrome for Android.
 */
export const ANDROID_WEBVIEW_UA_PATTERN = /\bwv\b/;

/**
 * iOS hardware in a user agent. iOS has no webview token of its own, so the platform has to be
 * identified first.
 */
export const IOS_DEVICE_UA_PATTERN = /\b(iPhone|iPad|iPod)\b/;

/**
 * Desktop macOS in a user agent. An iPad requesting a desktop site reports this instead of its
 * hardware.
 */
export const MACINTOSH_UA_PATTERN = /\bMacintosh\b/;

/** The mobile token that, next to `Macintosh`, gives away an iPad requesting a desktop site. */
export const MOBILE_UA_PATTERN = /\bMobile\b/;

/** Engine token present in every WebKit user agent, webviews included. */
export const WEBKIT_UA_TOKEN = "AppleWebKit";

/**
 * Token sent by every real iOS browser and by no in-application webview, so its
 * absence identifies a webview. Matching `Mobile.*Safari` positively instead
 * reports every ordinary iPhone as one.
 */
export const SAFARI_UA_TOKEN = "Safari/";

// ----------------------------------
// Sanitizing and size estimation
// ----------------------------------

/**
 * First code unit of the UTF-16 high surrogate range. A string must never be cut between this and
 * its low half.
 */
export const HIGH_SURROGATE_MIN = 0xd800;

/** Last code unit of the UTF-16 high surrogate range. */
export const HIGH_SURROGATE_MAX = 0xdbff;

/** Code units below this encode as a single UTF-8 byte. */
export const UTF8_ONE_BYTE_CEILING = 0x80;

/** Code units below this, and at or above the one-byte ceiling, encode as two UTF-8 bytes. */
export const UTF8_TWO_BYTE_CEILING = 0x800;

/**
 * How many class names `describeNode` keeps in the selector it builds. Enough to identify an
 * element, short enough to stay readable.
 */
export const MAX_NODE_CLASS_NAMES = 3;

/** Size charged for a null or an undefined. Both serialize as the four characters of `null`. */
export const BYTES_PER_NULL = 4;

/**
 * Size charged for a number. A flat estimate, since the exact digit count is not worth a `toString`
 * per value.
 */
export const BYTES_PER_NUMBER = 8;

/** Size charged for a boolean, taking the longer of the two spellings. */
export const BYTES_PER_BOOLEAN = 5;

/** Size charged for the braces or brackets wrapping one object or array. */
export const BYTES_PER_CONTAINER = 2;

/** Size charged for the two quote characters wrapping one string, on top of its own bytes. */
export const BYTES_PER_QUOTED_STRING = 2;

/**
 * Size charged for the punctuation around one key: two quotes, a colon and a comma, on top of the
 * key's own bytes.
 */
export const BYTES_PER_KEY_OVERHEAD = 4;

// ----------------------------------
// Record model
// ----------------------------------

/**
 * Each level as its OpenTelemetry severity number. Fixed by that specification,
 * not chosen here: a backend sorts and filters on them, and invented values
 * would make these records incomparable with every other source. The gaps are
 * standard too, reserved for finer grades such as `INFO2`.
 *
 * Typed as a total `Record<LogLevel, number>`, so adding a level without
 * numbering it fails the build rather than shipping an undefined severity.
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
 * The same table under the name the level filter reads it by. The identical
 * object, not a copy: ordering levels and numbering them for the wire are one
 * fact, and once two tables drifted a record would be filtered as one level and
 * reported as another. Both names exist because the call sites read
 * differently, a threshold test against an encoding step.
 */
export const LEVEL_ORDER: Record<LogLevel, number> = SEVERITY_NUMBER;

// ----------------------------------
// Attribute and resource keys
// ----------------------------------
//
// The names records carry on the wire. Constants because the record builder
// writes them and the serializers read them back, so a typo in either place is
// a field that stops arriving rather than a build error. Dotted names follow
// the OpenTelemetry semantic conventions where one exists; the `uiobs.` prefix
// marks this library talking about its own behaviour.

/** What kind of thing the record describes. Dashboards split on it and sampling rates are keyed by it. */
export const ATTR_LOG_TYPE = "log.type";

/**
 * Position of this record in its context's own stream. Monotonic within one
 * `context.id`, meaningless across two, and the strongest ordering a browser
 * offers: timestamps are client clocks and can move backwards.
 */
export const ATTR_LOG_SEQ = "log.seq";

/** Which logger, and therefore which part of a composed application, emitted the record. */
export const ATTR_APP_NAMESPACE = "app.namespace";

/**
 * The document URL when the record was built. An attribute, not a resource
 * field: it changes on every route change, and a resource field is by
 * definition identical for every record from one context.
 */
export const ATTR_PAGE_URL = "page.url";

/**
 * The target of the HTTP request a record is about, owned by the network
 * capture. Distinct from `ATTR_PAGE_URL`: stamping the page URL over this
 * rewrites every captured request to the page that made it.
 */
export const ATTR_URL_FULL = "url.full";

/** The journey this record belongs to, which is what correlates records across windows. */
export const ATTR_JOURNEY_ID = "journey.id";

/** The journey's human-readable name, carried so a backend query does not need a second lookup. */
export const ATTR_JOURNEY_NAME = "journey.name";

/** The journey this one branched from, present only on a journey started as a child. */
export const ATTR_JOURNEY_PARENT_ID = "journey.parent_id";

/** Marks a record whose attributes could not be sanitized, so the gap is visible rather than silent. */
export const ATTR_SANITIZE_FAILED = "uiobs.sanitize_failed";

/** Marks a record whose attributes were dropped for exceeding the per-record byte budget. */
export const ATTR_ATTRIBUTES_DROPPED = "uiobs.attributes_dropped";

/** How many bytes those dropped attributes measured, which is what makes the budget tunable with evidence. */
export const ATTR_ATTRIBUTES_BYTES = "uiobs.attributes_bytes";

/** The application these records come from. Every backend groups on it first. */
export const RESOURCE_SERVICE_NAME = "service.name";

/** The build of that application, which is what makes a spike in errors attributable to a release. */
export const RESOURCE_SERVICE_VERSION = "service.version";

/** Which deployment the records come from, so production and staging do not share a dashboard. */
export const RESOURCE_DEPLOYMENT_ENVIRONMENT = "deployment.environment";

/** Identifies this library as the producer, which is how a collector tells our records from a backend agent's. */
export const RESOURCE_TELEMETRY_SDK_NAME = "telemetry.sdk.name";

/** The version of this library that produced the record, which is what makes a client-side regression datable. */
export const RESOURCE_TELEMETRY_SDK_VERSION = "telemetry.sdk.version";

/** The language the producing SDK is written in, fixed by the OpenTelemetry conventions rather than chosen. */
export const RESOURCE_TELEMETRY_SDK_LANGUAGE = "telemetry.sdk.language";

/** Which kind of host the records came from: a browser, a webview, or an OpenFin runtime. */
export const RESOURCE_HOST_PLATFORM = "host.platform";

/** One visit to this origin, shared by every tab in it. */
export const RESOURCE_SESSION_ID = "session.id";

/** One tab, OpenFin window or OpenFin view, surviving a reload. */
export const RESOURCE_TAB_ID = "tab.id";

/** One realm. Two iframes of the same tab differ here and nowhere else. */
export const RESOURCE_CONTEXT_ID = "context.id";

/** The raw user agent, kept so a platform detection this library got wrong stays diagnosable after the fact. */
export const RESOURCE_BROWSER_USER_AGENT = "browser.user_agent";

/** The OpenFin application uuid, present only on a desktop runtime. */
export const RESOURCE_OPENFIN_UUID = "openfin.uuid";

/** The OpenFin window or view name, present only on a desktop runtime. */
export const RESOURCE_OPENFIN_NAME = "openfin.name";

/** The value of `telemetry.sdk.name`: this package, as a collector sees it. */
export const TELEMETRY_SDK_NAME = "ui-observability";

/**
 * The value of `telemetry.sdk.version`. A literal, because importing
 * package.json pulls a JSON module into the bundle and pins the published
 * package's shape. Bump it by hand alongside the version in package.json.
 */
export const TELEMETRY_SDK_VERSION = "1.0.0";

/** The value of `telemetry.sdk.language`, fixed by the OpenTelemetry conventions as the name for browser JavaScript. */
export const TELEMETRY_SDK_LANGUAGE = "webjs";

// ----------------------------------
// Serializers
// ----------------------------------

/**
 * The OTLP/JSON serializer's name. Two readers: the serializer stamps it on
 * itself, and config resolves this spelling when a consumer names a format
 * rather than passing an implementation.
 */
export const SERIALIZER_NAME_OTLP = "otlp";

/** The Elastic Common Schema serializer's name, resolved from config the same way. */
export const SERIALIZER_NAME_ECS = "ecs";

/** Content type of an OTLP/JSON body, which is what the collector's logs endpoint accepts. */
export const CONTENT_TYPE_JSON = "application/json";

/** Content type of newline-delimited JSON, which is what a bulk ingest endpoint accepts. */
export const CONTENT_TYPE_NDJSON = "application/x-ndjson";

/** Nanoseconds in one millisecond. A bigint, because a record timestamp is past exact double range. */
export const NANOS_PER_MILLI = 1000000n;

// ----------------------------------
// HTTP transport
// ----------------------------------

/** Names the payload format. Taken from the serializer, never from a consumer. */
export const HEADER_CONTENT_TYPE = "Content-Type";

/** Labels a compressed body. Set only when compression actually happened. */
export const HEADER_CONTENT_ENCODING = "Content-Encoding";

/** Response header asking to be left alone: delta seconds or an HTTP date. */
export const HEADER_RETRY_AFTER = "Retry-After";

/**
 * The batch's deduplication key. The exit flush repeats it as a query
 * parameter, since `sendBeacon` cannot set headers.
 */
export const HEADER_BATCH_ID = "X-UiObs-Batch-Id";

/** Which delivery attempt this is, so a server can tell a retry from a first send. */
export const HEADER_ATTEMPT = "X-UiObs-Attempt";

/** The one compression this library speaks. Both a config value and a Content-Encoding. */
export const ENCODING_GZIP = "gzip";

/** 401, credentials missing or rejected. */
export const HTTP_UNAUTHORIZED = 401;

/** 403, credentials understood and refused. */
export const HTTP_FORBIDDEN = 403;

/** 408, the server gave up waiting. Retryable. */
export const HTTP_REQUEST_TIMEOUT = 408;

/** 413, the batch has to be split before it can be delivered. */
export const HTTP_PAYLOAD_TOO_LARGE = 413;

/** 429, explicit backpressure, usually with a Retry-After. */
export const HTTP_TOO_MANY_REQUESTS = 429;

/** 500, and the floor for treating a status as the server's fault rather than the payload's. */
export const HTTP_SERVER_ERROR_MIN = 500;

/** 503, temporary unavailability. Treated as backpressure whether or not Retry-After is set. */
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** Milliseconds in a second, for a Retry-After given in delta seconds. */
export const MILLIS_PER_SECOND = 1000;

// ----------------------------------
// Storage
// ----------------------------------

/** Key prefix for a batch parked in localStorage. */
export const BATCH_STORAGE_KEY_PREFIX = "ui-observability.batch.";

/**
 * Digits the creation time is padded to inside that key. Fixed width, so
 * lexicographic order is chronological. Fourteen lasts to the year 5138.
 */
export const BATCH_KEY_TIME_WIDTH = 14;

/** Written and deleted to find out whether localStorage accepts writes at all. */
export const STORAGE_PROBE_KEY = "ui-observability.probe";

/** Share of the store thrown away when a write is refused for space: one in this many. */
export const QUOTA_EVICTION_DIVISOR = 4;

/** The DOMException name every browser uses when a store is full. */
export const QUOTA_EXCEEDED_ERROR = "QuotaExceededError";

/** IndexedDB schema version. Bumping it means writing a Dexie migration. */
export const INDEXEDDB_SCHEMA_VERSION = 1;

/** Adapter name, and the `storage.strategy` spelling that selects it. */
export const STORAGE_NAME_INDEXEDDB = "indexeddb";

/** Adapter name, and the `storage.strategy` spelling that selects it. */
export const STORAGE_NAME_LOCAL = "localstorage";

/** Adapter name, and the `storage.strategy` spelling that selects it. */
export const STORAGE_NAME_MEMORY = "memory";

/** Adapter name for the store that keeps nothing, and the strategy that selects it. */
export const STORAGE_NAME_NONE = "none";

// ----------------------------------
// Journey
// ----------------------------------

/**
 * sessionStorage key holding the journey this context is in. sessionStorage,
 * not localStorage: a journey belongs to one tab, and a localStorage key would
 * hand one tab's finished journey to every other tab on the origin. Compare
 * `SESSION_ID_KEY`, which is localStorage for the opposite reason.
 */
export const JOURNEY_STORAGE_KEY = "ui-observability.journey";

/**
 * Longest journey name a token carries. A token rides in a query string, which
 * has a hard length limit and proxy truncation, and the name is its only
 * free-form field. The full name still reaches storage and every record.
 */
export const JOURNEY_TOKEN_NAME_MAX_CHARS = 64;

/**
 * Cap on a whole token, past which none is issued. Three fields and a capped
 * name cannot reach it, so this firing means the encoder grew a field. A
 * tripwire on the query-string budget, not input validation.
 */
export const JOURNEY_TOKEN_MAX_CHARS = 256;

/**
 * Key under an OpenFin window's `customData` carrying a seeded journey token. A
 * provider-created window has no URL of its own to read one from. The consumer
 * writing it and this library reading it must agree on the spelling, and
 * nothing else checks that they do.
 */
export const OPENFIN_JOURNEY_CUSTOM_DATA_KEY = "uiObsJourney";

/**
 * The `+` of standard base64, which is `-` in the URL-safe alphabet.
 *
 * These five are module-level despite the `g` flag: `replace` resets
 * `lastIndex` before it runs, so a shared instance carries no state between
 * calls. `test` and `exec` do not, which is why none is used with them.
 */
export const BASE64_PLUS_PATTERN = /\+/g;

/** The `/` of standard base64, which is `_` in the URL-safe alphabet. */
export const BASE64_SLASH_PATTERN = /\//g;

/** Trailing `=` padding, dropped from a URL-safe token and recomputed on the way back. */
export const BASE64_PADDING_PATTERN = /=+$/;

/** The `-` of the URL-safe alphabet, which is `+` in standard base64. */
export const BASE64URL_DASH_PATTERN = /-/g;

/** The `_` of the URL-safe alphabet, which is `/` in standard base64. */
export const BASE64URL_UNDERSCORE_PATTERN = /_/g;

/** Base64 spends four characters on every three bytes, so a short final group is padded back to four. */
export const BASE64_GROUP_CHARS = 4;

// ----------------------------------
// Tracing
// ----------------------------------

/** Width of a W3C trace id: sixteen bytes, thirty-two hex characters. */
export const TRACE_ID_BYTES = 16;

/** Width of a W3C span id: eight bytes, sixteen hex characters. */
export const SPAN_ID_BYTES = 8;

/**
 * How long one ambient trace lives before it rotates on its own. The id rotates
 * on a click, a route change, an explicit call, and failing those, this age,
 * so a tab left open all day does not pile a week of records into one trace.
 */
export const TRACE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * trace-flags with the sampled bit set. Every record has already survived
 * sampling by the time it is built, so an unsampled flag would tell the backend
 * to discard what this library deliberately kept.
 */
export const TRACE_FLAGS_SAMPLED = 1;

/**
 * trace-flags is one byte on the wire, so the field is masked to eight bits
 * before printing. The bitfield's further bits are already defined, and
 * collapsing it to sampled or not discards what an upstream tracer set.
 */
export const TRACE_FLAGS_MASK = 0xff;

/** The only `traceparent` version defined so far, and the prefix of every header this library writes. */
export const TRACEPARENT_VERSION = "00";

// ----------------------------------
// Breadcrumbs
// ----------------------------------

/**
 * Smallest breadcrumb buffer that still functions. The write pointer advances
 * modulo the capacity, and modulo zero is NaN: a capacity of zero writes every
 * crumb to index NaN and reads none back. Turning breadcrumbs off is what the
 * capture flags are for, so this clamps instead.
 */
export const BREADCRUMB_MIN_CAPACITY = 1;

// ----------------------------------
// Configuration
// ----------------------------------

/**
 * What `service.name` becomes when a consumer configures none. A fixed
 * placeholder is searchable in the backend and says the field was never set
 * rather than lost in transit.
 */
export const UNKNOWN_SERVICE_NAME = "unknown-service";

/** Lowest accepted sampling rate: drop everything. */
export const SAMPLING_RATE_MIN = 0;

/** Highest accepted sampling rate: keep everything. */
export const SAMPLING_RATE_MAX = 1;

/**
 * What an out-of-range sampling rate falls back to. Keeps everything: a typo in
 * a rate should cost volume, not visibility.
 */
export const SAMPLING_RATE_FALLBACK = 1;

/**
 * Valid config keys that carry no default and so never appear in
 * `DEFAULT_CONFIG`. The unknown-key check reads that object's own keys, and
 * without this list would report every callback a consumer passes as a typo.
 */
export const UNDEFAULTED_CONFIG_KEYS = ["redact", "onDiagnostic", "headers", "serializer"] as const;

/**
 * The nested config sections, merged into the objects already in place rather
 * than replaced. Components hold a reference to a section from construction, so
 * preserving the identity of these nine is what makes a change reach them.
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
 * Every setting the runtime reads, at the value it takes when the consumer says
 * nothing. Fully populated: downstream code reads these without checking, so a
 * hole here becomes an undefined in arithmetic far away.
 *
 * The base of a first `configure()` only. A later call merges onto the config
 * in force, never back onto this.
 *
 * Every default except the serializer, which is an implementation rather than a
 * value: naming one here would import the transport into this file, and the
 * serializers import these constants back. `resolveConfig` supplies it.
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
    // Metrics trickle in from timers and web vitals and nobody waits on one, so
    // they batch harder. That is most of the point of splitting the streams.
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

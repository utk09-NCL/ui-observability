// src/constants.ts
//
// Every constant the library uses, in one file.
//
// One place to look is the whole point. A default that lives beside the code
// that reads it is invisible to everyone else: whoever wants to tune a batch
// size first has to know which module owns it, and two modules needing the same
// number quietly end up with two copies that drift apart.
//
// What lives here: every limit, threshold, timing window, storage key, pattern
// and default, plus any literal that more than one module has to agree on.
//
// What deliberately stays inline: arithmetic that is its own explanation, such
// as the one, two, three and four byte widths inside the UTF-8 estimator, and
// single-use display fallbacks such as the "anonymous" in `[Function anonymous]`
// that are read at the line producing them.
//
// This module holds values only. No functions, no conditions, nothing that runs
// at import beyond building these objects. A "constant" that needs a branch to
// compute is not a constant, and it would put an untestable branch in the one
// file that no test imports directly.

import type { ResolvedConfig } from "./models/config";
import type { LogLevel } from "./models/log-record";

// ----------------------------------
// Library-wide
// ----------------------------------

/**
 * Tag on anything this library writes to the host console.
 *
 * A consumer reading their own console needs to see at a glance that a line is
 * ours and not theirs, and a fixed prefix is also what makes our output
 * filterable out of theirs.
 */
export const LIBRARY_LOG_PREFIX = "[ui-observability]";

// ----------------------------------
// Diagnostics
// ----------------------------------

/**
 * Default window in which one diagnostic code may emit at most one event.
 *
 * A broken render loop can produce ten thousand identical errors a second, and a
 * consumer handler invoked ten thousand times a second is itself the outage.
 * Counting is never throttled, so the true total still rides on the next event
 * that gets through.
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
 * Minimum spacing between two writes of the session's last-seen time.
 *
 * The record path is the only place that reliably knows the user is still here,
 * and it is hot, so keeping the session alive has to cost one integer compare
 * rather than a storage write per record.
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
 * Marks the OpenFin desktop runtime in a user agent.
 *
 * Both the desktop runtime and the Core Web adapter expose `fin`, so this
 * pattern is the only thing separating them.
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
 * Token sent by every real iOS browser and by no in-application webview.
 *
 * Its absence is what identifies an iOS webview. Matching positively on
 * something like `Mobile.*Safari` instead reports every ordinary iPhone as a
 * webview, and then every dashboard split by platform is wrong for all iOS
 * traffic.
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

/**
 * Size charged for a null or an undefined.
 *
 * Both serialize as the four characters of `null`, since `JSON.stringify` has no
 * representation for undefined.
 */
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
 * Each level as its OpenTelemetry severity number.
 *
 * These numbers are fixed by that specification rather than chosen here. A
 * backend sorts, filters and colours on them, so inventing values would make
 * this library's records incomparable with every other source feeding the same
 * collector. The gaps are part of the standard too, which reserves the space
 * between named levels for finer grades such as `INFO2`.
 *
 * Typed as a total `Record<LogLevel, number>` on purpose: adding a level to
 * `LogLevel` without numbering it here then fails the build, rather than
 * shipping an undefined severity to the wire.
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
 * The same table, under the name the level filter reads it by.
 *
 * Deliberately the identical object and not a copy. Ordering levels and
 * numbering them for the wire are one fact, so a second table would be a second
 * thing to keep in step, and the first time the two drifted a record would be
 * filtered as one level and reported as another. Both names exist because the
 * call sites read differently: comparing `LEVEL_ORDER` values is a threshold
 * test, reading `SEVERITY_NUMBER` is an encoding step.
 */
export const LEVEL_ORDER: Record<LogLevel, number> = SEVERITY_NUMBER;

// ----------------------------------
// Attribute and resource keys
// ----------------------------------
//
// The names records carry on the wire. They are constants because the record
// builder writes them and the serializers read them back by name, so a typo in
// either place is a field that silently stops arriving rather than a build
// error. Dotted names follow the OpenTelemetry semantic conventions wherever
// one exists, and the `uiobs.` prefix marks the few that are this library
// talking about its own behaviour.

/** What kind of thing the record describes. Dashboards split on it and sampling rates are keyed by it. */
export const ATTR_LOG_TYPE = "log.type";

/**
 * Position of this record in its context's own stream.
 *
 * Monotonic within one `context.id` and meaningless across two, which is the
 * strongest ordering a browser can offer: timestamps are client clocks and can
 * be skewed or move backwards.
 */
export const ATTR_LOG_SEQ = "log.seq";

/** Which logger, and therefore which part of a composed application, emitted the record. */
export const ATTR_APP_NAMESPACE = "app.namespace";

/**
 * The document URL at the moment the record was built.
 *
 * An attribute rather than a resource field, because it changes on every route
 * change in a single-page application, and a resource field is by definition
 * identical for every record from one context.
 */
export const ATTR_PAGE_URL = "page.url";

/**
 * The target of the HTTP request a record is about, owned by the network capture.
 *
 * Deliberately distinct from `ATTR_PAGE_URL`. This is the OpenTelemetry name
 * for the request being described, so stamping the page URL over it rewrites
 * every captured request to the page it was made from and leaves the real
 * target only inside the body string.
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
 * The value of `telemetry.sdk.version`.
 *
 * A literal rather than a read of package.json, which cannot be imported
 * without pulling a JSON module into the bundle and pinning the published
 * package's shape. It therefore has to be bumped by hand alongside the version
 * in package.json, and this is the note saying so.
 */
export const TELEMETRY_SDK_VERSION = "1.0.0";

/** The value of `telemetry.sdk.language`, fixed by the OpenTelemetry conventions as the name for browser JavaScript. */
export const TELEMETRY_SDK_LANGUAGE = "webjs";

// ----------------------------------
// Journey
// ----------------------------------

/**
 * sessionStorage key holding the journey this context is in.
 *
 * sessionStorage rather than localStorage, and the choice is load bearing: a
 * journey belongs to one tab, so a localStorage key would hand one tab's
 * finished journey to every other tab on the origin. Compare `SESSION_ID_KEY`,
 * which is localStorage for exactly the opposite reason.
 */
export const JOURNEY_STORAGE_KEY = "ui-observability.journey";

/**
 * Longest journey name a token carries.
 *
 * A token rides in a query string, which is the one channel with a hard length
 * limit, proxy truncation and access-log noise. The name is the only free-form
 * field in it and therefore the only one that needs a cap. The untruncated name
 * survives in what is persisted and on every record, so this costs nothing
 * outside the token.
 */
export const JOURNEY_TOKEN_NAME_MAX_CHARS = 64;

/**
 * Cap on a whole token, past which no token is issued at all.
 *
 * Three fields and a capped name cannot reach this, so this firing means the
 * encoder grew a field rather than that a caller did anything wrong. It is a
 * tripwire on the query-string budget, not input validation.
 */
export const JOURNEY_TOKEN_MAX_CHARS = 256;

/**
 * Key under an OpenFin window's `customData` that carries a seeded journey token.
 *
 * A window a platform provider creates has no URL of its own to read a token
 * from, so `customData` is the seeding channel there. The consumer code that
 * writes it when creating the window and the code that reads it here have to
 * agree on this spelling, and nothing else checks that they do.
 */
export const OPENFIN_JOURNEY_CUSTOM_DATA_KEY = "uiObsJourney";

/**
 * The `+` of standard base64, which is `-` in the URL-safe alphabet.
 *
 * These five patterns are module-level despite the `g` flag, which is safe:
 * `String.prototype.replace` resets `lastIndex` on a global regex before it
 * runs, so a shared instance carries no state between calls. That is not true
 * of `test` and `exec`, which is why nothing here is used with them.
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
 * How long one ambient trace lives before it rotates on its own.
 *
 * A trace id is not minted per record. Records that share one hold together as
 * a single trace in the backend, which is the entire value of the field, so the
 * id rotates on meaningful boundaries: a click, a route change, an explicit
 * call, and failing all of those, this age. The cap exists because a tab left
 * open all day would otherwise pile a week of records into one trace.
 */
export const TRACE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * trace-flags with the sampled bit set.
 *
 * Every record this library emits has already survived sampling by the time it
 * is built, so an unsampled flag would tell the backend to discard something
 * this library deliberately kept.
 */
export const TRACE_FLAGS_SAMPLED = 1;

/**
 * trace-flags is one byte on the wire, so the field is masked to eight bits before it is printed.
 *
 * The mask matters rather than being decoration: the field is a bitfield whose
 * further bits are already defined, and collapsing it to sampled or not
 * silently discards every other flag an upstream tracer set.
 */
export const TRACE_FLAGS_MASK = 0xff;

/** The only `traceparent` version defined so far, and the prefix of every header this library writes. */
export const TRACEPARENT_VERSION = "00";

// ----------------------------------
// Breadcrumbs
// ----------------------------------

/**
 * Smallest breadcrumb buffer that still functions.
 *
 * The buffer is a ring whose write pointer advances modulo the capacity, and
 * modulo zero is NaN, so a capacity of zero does not store nothing, it writes
 * every crumb to index NaN and reads none of them back. A consumer asking for
 * zero breadcrumbs is asking to turn a feature off, which is what the capture
 * flags are for, so the capacity clamps to this rather than throwing out of a
 * constructor that runs inside `configure()`.
 */
export const BREADCRUMB_MIN_CAPACITY = 1;

// ----------------------------------
// Configuration
// ----------------------------------

/**
 * What `service.name` becomes when a consumer configures no service name.
 *
 * A fixed placeholder is better than an empty string, because it is searchable
 * in the backend and it tells whoever finds it that the field was never set
 * rather than lost in transit.
 */
export const UNKNOWN_SERVICE_NAME = "unknown-service";

/** Lowest accepted sampling rate: drop everything. */
export const SAMPLING_RATE_MIN = 0;

/** Highest accepted sampling rate: keep everything. */
export const SAMPLING_RATE_MAX = 1;

/**
 * What an out-of-range sampling rate falls back to.
 *
 * It keeps everything on purpose. A typo in a rate should cost volume, not
 * visibility, and silently dropping records is the harder failure to notice.
 */
export const SAMPLING_RATE_FALLBACK = 1;

/**
 * Config keys that are valid but carry no default, so they never appear in
 * `DEFAULT_CONFIG`.
 *
 * The unknown-key check reads the default's own keys to decide what it
 * recognises, and without this list it would report every callback a consumer
 * passes as a typo.
 */
export const UNDEFAULTED_CONFIG_KEYS = ["redact", "onDiagnostic", "headers"] as const;

/**
 * The nested config sections, which are merged into the objects already in
 * place rather than replaced.
 *
 * Components capture a reference to a section once at construction, so
 * preserving the identity of these nine objects across a reconfigure is what
 * makes a changed setting reach the code already holding it.
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
 * nothing.
 *
 * Fully populated on purpose: downstream code reads these without checking
 * them first, so a hole here becomes an undefined in arithmetic somewhere far
 * away. This object is the base of a first `configure()` call only. A later
 * call merges onto the config already in force, never back onto this.
 */
export const DEFAULT_CONFIG: ResolvedConfig = {
  endpoint: "",
  serviceName: "",
  serviceVersion: "",
  environment: "",
  enabled: true,
  minLevel: "INFO",
  streams: {
    logs: { flushIntervalMs: 2000, batchSize: 100 },
    // Metrics arrive from timers and web vitals at a steady trickle, and nobody
    // is waiting for one. Batching them harder is most of the point of
    // splitting the streams at all.
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
  // There is no default serializer because there is no serializer: the wire
  // format lives at the transport boundary, which does not exist yet. Nothing
  // reads this field, so a placeholder would only be a value no code can use.
  // Final form:
  //   serializer: otlpSerializer,
};

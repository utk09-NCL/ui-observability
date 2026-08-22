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

// src/core/config.ts
//
// Resolves partial consumer options into a validated config, and updates the live config.
// Three rules to follow here, because breaking any one fails silently:
//   1. Merge a reconfigure onto the current config, not onto the defaults.
//   2. Change the resolved object in place, never replace it. Subsystems keep the
//      reference they got at construction.
//   3. An omitted key or undefined keeps the current value at every depth. Only null clears a
//      hook or lifts a limit, so an unset variable can't remove redact.
// A getter in the app's input can throw here. ObservabilityRuntime.configure() catches it, so
// configure() never throws into the app.

import {
  ACTION_ATTRIBUTE_DEFAULT,
  BEACON_LIMIT_BYTES,
  CONFIG_SECTIONS,
  CONSOLE_DEFAULT_LEVEL,
  CONSOLE_DEFAULT_STYLES,
  DEAD_CLICK_IGNORE_SELECTOR,
  DEAD_CLICK_MS,
  DEFAULT_CONFIG,
  HOLD_BUFFER_HEAD_RECORDS,
  LEVEL_ORDER,
  LONG_FRAME_THRESHOLD_MS,
  PROFILER_PROBE_LIMIT,
  REMOTE_CAPTURE_FLAGS,
  RESOURCE_SLOW_MS,
  RAGE_CLICK_COUNT,
  RAGE_CLICK_WINDOW_MS,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
  SERIALIZER_NAME_ECS,
  SERIALIZER_NAME_OTLP,
  UNDEFAULTED_CONFIG_KEYS,
  UNDEFAULTED_SECTION_KEYS,
  UNKNOWN_SERVICE_NAME,
} from "../constants";
import type {
  BatchingOptions,
  BusOptions,
  CaptureOptions,
  CapturedConsoleMethod,
  ConsoleStyles,
  InteractionOptions,
  JourneyOptions,
  LimitsOptions,
  ObservabilityConfig,
  ResolvedConfig,
  ResolvedConsole,
  RetentionOptions,
  SamplingOptions,
  SerializerChoice,
} from "../models/config";
import type { LogLevel, LogType } from "../models/log-record";
import type { CapturePlugin } from "../models/plugin";
import type { LogSerializer } from "../models/serializer";
import { hasOwn, isObject } from "../utils/guards";
import type { Diagnostics } from "./diagnostics";

/** Level names in severity order. */
const LEVEL_NAMES = Object.keys(LEVEL_ORDER) as readonly LogLevel[];

/** Accepted values for each choice option. */
const COMPRESSION_VALUES = ["gzip", "none"] as const;
const CREDENTIALS_VALUES = ["omit", "same-origin", "include"] as const;
const STORAGE_VALUES = ["auto", "indexeddb", "localstorage", "memory", "none"] as const;
const IDENTITY_VALUES = ["storage", "memory"] as const;
const BUS_MODE_VALUES = ["auto", "sender", "forwarder", "off"] as const;
const OPENFIN_ROLE_VALUES = ["auto", "provider", "client"] as const;
const JOURNEY_SCOPE_VALUES = ["auto", "context", "tab", "origin"] as const;
const CONSOLE_METHOD_VALUES = ["error", "warn", "info", "log"] as const;
const LOG_TYPE_VALUES: readonly LogType[] = ["action", "event", "metric", "log", "system", "span"];

/** Lowest and highest value an integer option accepts. */
type Range = readonly [min: number, max: number];

/** Accepted range for each batching key. */
const BATCHING_RANGES: Record<keyof BatchingOptions, Range> = {
  logFlushIntervalMs: [100, 60_000],
  logBatchSize: [1, 1000],
  metricBatchSize: [1, 1000],
};

/** Accepted range for retention.maxBatches. */
const MAX_BATCHES_RANGE: Range = [1, 5000];

/** Accepted range for retention.maxAgeMs. null lifts the age limit. */
const RETENTION_AGE_RANGE: Range = [60_000, 7 * 24 * 60 * 60 * 1000];

/** Accepted range for retention.maxAttempts. null lifts the attempt limit. */
const RETENTION_ATTEMPTS_RANGE: Range = [1, 20];

/**
 * Accepted range for each record limit. maxRecordBytes tops out at one beacon, and the body
 * and error fields don't count toward it. An exit batch larger than one beacon goes to the
 * emergency queue.
 */
const LIMIT_RANGES: Record<keyof LimitsOptions, Range> = {
  maxBodyChars: [256, 65_536],
  maxAttributeChars: [256, 65_536],
  maxAttributeCount: [1, 1024],
  maxStackChars: [256, 65_536],
  maxDepth: [1, 16],
  maxArrayLength: [1, 10_000],
  maxNodes: [100, 100_000],
  maxRecordBytes: [1024, BEACON_LIMIT_BYTES],
};

/** Accepted range for journey.maxAgeMs. */
const JOURNEY_AGE_RANGE: Range = [60_000, 24 * 60 * 60 * 1000];

/** Range for a duration. The maximum is the largest delay a browser timer accepts. */
const DURATION_RANGE: Range = [0, 2_147_483_647];

/** Range for a duration that must be at least 1 ms, because 0 would expire at once. */
const POSITIVE_DURATION_RANGE: Range = [1, DURATION_RANGE[1]];

/** Range for a count. Zero allows nothing. */
const COUNT_RANGE: Range = [0, Number.MAX_SAFE_INTEGER];

/** Range for a count that must be at least 1. */
const POSITIVE_RANGE: Range = [1, Number.MAX_SAFE_INTEGER];

/** Range for the rage click and dead click detection waits. */
const CLICK_WAIT_RANGE: Range = [100, 10_000];

/** The keys of a policy section whose values are numbers. */
type NumberKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

/** The keys of a policy section that take a number, or null for no limit. */
type LimitKeys<T> = {
  [K in keyof T]: T[K] extends number | null ? (null extends T[K] ? K : never) : never;
}[keyof T];

/** The policy sections resolvePolicy() checks. */
type PolicySection =
  | "captureLimits"
  | "metadata"
  | "storage"
  | "diagnostics"
  | "correlation"
  | "metrics"
  | "buffering"
  | "delivery"
  | "debugBuffer"
  | "profiler"
  | "replay";

/**
 * Reads one policy key the generic checks can't handle, for example a list.
 * @param key Full config key for the diagnostic message.
 * @param value The value the consumer passed.
 * @param fallback The current value.
 * @param diagnostics Diagnostics reporter.
 * @returns The value to use.
 */
type CustomResolver = (
  key: string,
  value: unknown,
  fallback: unknown,
  diagnostics: Diagnostics,
) => unknown;

/** True for an array of strings. */
const isStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** True for an array of functions. */
const isFunctions = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "function");

/** True for a function or null. */
const isFunctionOrNull = (value: unknown): boolean => value === null || typeof value === "function";

/** True for null. */
const isNull = (value: unknown): boolean => value === null;

/** Matches a URL that names its scheme, for example "https:". A relative URL has none. */
const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

/** True for a sampling rate from 0 to 1. NaN fails both comparisons, so it's rejected too. */
const isRate = (value: unknown): value is number =>
  typeof value === "number" && value >= SAMPLING_RATE_MIN && value <= SAMPLING_RATE_MAX;

/** How a hook value and a URL value read in a config.invalid message. */
const HOOK_EXPECTED = "a function or null";
const URL_EXPECTED = "a URL string or null";

/** True for request headers: an object of strings, a function, or null. */
const isHeaders = (value: unknown): boolean =>
  isFunctionOrNull(value) ||
  (isRecord(value) && Object.values(value as object).every((entry) => typeof entry === "string"));

/** True for an object that isn't an array. */
const isRecord = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Builds the resolver for a key whose value isn't a number, a boolean or a string.
 * @param test Checks the value.
 * @param expected What the report says was expected.
 * @param describe Describes a rejected value. A key whose text can hold a secret passes
 * describeKind.
 * @returns The resolver. A value that fails the test is ignored, and the current one stays.
 */
function keepKind(
  test: (value: unknown) => boolean,
  expected: string,
  describe: (value: unknown) => string = describeValue,
): CustomResolver {
  return (key, value, fallback, diagnostics) => {
    if (value === undefined) {
      return fallback;
    }

    // null is a valid value for some keys, and it replaces the current value.
    if (test(value)) {
      return value;
    }

    reportInvalid(diagnostics, key, expected, value, "the current value", describe);
    return fallback;
  };
}

/**
 * Returns the URL that a relative destination resolves against. A worker has no document, so
 * it uses its own location.
 * @returns The base URL, or undefined when the scope has neither.
 */
function pageBase(): string | undefined {
  if (typeof document !== "undefined") {
    return document.baseURI;
  }

  return typeof location === "undefined" ? undefined : location.href;
}

/**
 * Checks a destination URL and returns the form the library sends to. A relative URL resolves
 * against the page, so the records go where the app's own requests go, and the report names
 * that origin. A URL with a user name or a password is refused, because each request would
 * carry it.
 * @param key Config key.
 * @param value The URL the consumer passed.
 * @param fallback The current destination.
 * @param diagnostics Diagnostics reporter.
 * @returns The URL, its absolute form for a relative URL, or the fallback for a refused URL.
 */
function absoluteUrl(
  key: string,
  value: string,
  fallback: unknown,
  diagnostics: Diagnostics,
): unknown {
  let url: URL;
  try {
    url = new URL(value, pageBase());
  } catch (error) {
    // The URL can hold a token, and this message can become a record.
    diagnostics.report(
      "config.invalid",
      `${key} is not a valid URL. The library keeps the current value.`,
      undefined,
      error,
    );
    return fallback;
  }

  if (url.username !== "" || url.password !== "") {
    diagnostics.report(
      "config.invalid",
      `${key} has a user name or a password. The library keeps the current value.`,
    );
    return fallback;
  }

  if (SCHEME_PATTERN.test(value)) {
    return value;
  }

  diagnostics.report("config.invalid", `${key} is relative. The library sends to ${url.origin}.`);
  return url.href;
}

/**
 * Reads a destination that null turns off. An empty or blank string turns it off too, with a
 * report, because an empty environment variable must not leave the records going to the old
 * destination. A rotation runs it too, to find a refused URL.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current destination.
 * @param diagnostics Diagnostics reporter.
 * @returns The URL, null when it's off, or the fallback for a refused value.
 */
export function resolveDestination(
  key: string,
  value: unknown,
  fallback: unknown,
  diagnostics: Diagnostics,
): unknown {
  if (typeof value !== "string") {
    return keepKind(isNull, URL_EXPECTED, describeKind)(key, value, fallback, diagnostics);
  }

  if (value.trim() === "") {
    diagnostics.report(
      "config.invalid",
      `${key} is empty. The library turns it off. Use null to turn it off.`,
    );
    return null;
  }

  // The current value passed the check already, so it gets no second report.
  return value === fallback ? value : absoluteUrl(key, value, fallback, diagnostics);
}

/**
 * Reads the endpoint. "" stays "", the value for "not set", so resolveConfig reports a missing
 * endpoint. A blank string is refused, because it would send to the page itself. A rotation
 * runs it too, to find a refused URL.
 * @param value The value the consumer passed.
 * @param fallback The current endpoint.
 * @param diagnostics Diagnostics reporter.
 * @returns The endpoint, null for console-only mode, or the fallback for a refused value.
 */
export function resolveEndpoint(
  value: unknown,
  fallback: unknown,
  diagnostics: Diagnostics,
): unknown {
  if (typeof value !== "string") {
    return keepKind(isNull, URL_EXPECTED, describeKind)("endpoint", value, fallback, diagnostics);
  }

  if (value === "" || value === fallback) {
    return value;
  }

  if (value.trim() === "") {
    diagnostics.report("config.invalid", "endpoint is blank. The library keeps the current value.");
    return fallback;
  }

  return absoluteUrl("endpoint", value, fallback, diagnostics);
}

/** Rules for one policy section. Every number key must have a range. */
interface PolicyRules<T> {
  /** Accepted range for each number key. */
  ranges: Record<NumberKeys<T>, Range>;
  /** Accepted range for each key that also takes null, which means no limit. */
  limits: Record<LimitKeys<T>, Range>;
  /** Accepted values for each choice key. */
  choices?: Partial<Record<keyof T, readonly string[]>>;
  /** Resolver for each key with any other value type. */
  custom?: Partial<Record<keyof T, CustomResolver>>;
}

/** Rules for every policy section. A new number key without a range won't compile. */
const POLICY_RULES: { [K in PolicySection]: PolicyRules<ResolvedConfig[K]> } = {
  captureLimits: {
    ranges: {
      // A larger capacity fails as an invalid array allocation.
      breadcrumbs: [0, 1_000_000],
      errorDedupeMs: DURATION_RANGE,
      // A window of 0 ms starts a new window for every event, so no rate limit would apply.
      windowMs: POSITIVE_DURATION_RANGE,
    },
    limits: {
      errorsPerWindow: COUNT_RANGE,
      consolePerWindow: COUNT_RANGE,
      longFramesPerWindow: COUNT_RANGE,
      webSocketPerWindow: COUNT_RANGE,
      reportsPerWindow: COUNT_RANGE,
      resourcesPerWindow: COUNT_RANGE,
      lifecyclePerWindow: COUNT_RANGE,
    },
  },
  metadata: { ranges: {}, limits: {} },
  storage: { ranges: {}, limits: {}, choices: { backend: STORAGE_VALUES } },
  diagnostics: {
    ranges: { throttleMs: DURATION_RANGE },
    limits: {},
    custom: { records: resolveDiagnosticRecords },
  },
  correlation: {
    ranges: {},
    // 0 would end a session or a trace at once, so these start at 1, and null lifts them.
    limits: { sessionIdleMs: POSITIVE_DURATION_RANGE, traceMaxAgeMs: POSITIVE_DURATION_RANGE },
  },
  metrics: {
    ranges: { intervalMs: [1000, 600_000] },
    limits: {
      maxSeries: COUNT_RANGE,
      maxInstruments: COUNT_RANGE,
      maxHistogramBoundaries: COUNT_RANGE,
    },
  },
  buffering: {
    ranges: {
      // Two heads at least, or a full buffer keeps its first records but too few of the newest.
      // The maximum bounds the memory of a startup storm.
      maxHeldRecords: [2 * HOLD_BUFFER_HEAD_RECORDS, 10_000],
    },
    // A buffer that holds nothing would drop every record, so these start at 1.
    limits: { maxPendingRecords: POSITIVE_RANGE, maxPendingBytes: POSITIVE_RANGE },
    choices: { overflow: ["drop-oldest", "drop-newest", "persist"] },
  },
  delivery: {
    ranges: {
      requestTimeoutMs: [1, DURATION_RANGE[1]],
      maxConcurrentRequests: POSITIVE_RANGE,
      retryBaseDelayMs: DURATION_RANGE,
      retryMaxDelayMs: DURATION_RANGE,
    },
    limits: {},
    choices: { priority: ["low", "auto", "high"] },
  },
  debugBuffer: {
    ranges: { maxRecords: [1, 10_000] },
    limits: { maxAgeMs: POSITIVE_DURATION_RANGE },
  },
  profiler: {
    ranges: { maxProbes: [1, PROFILER_PROBE_LIMIT] },
    limits: {},
  },
  replay: {
    ranges: {
      bufferMs: [5000, 600_000],
      maxBufferBytes: [100_000, 200_000_000],
      afterErrorMs: [0, 600_000],
      // A window of 0 ms starts a new window for every upload, so the limit would never apply.
      uploadWindowMs: POSITIVE_DURATION_RANGE,
      maxSegmentEvents: [1, 10_000],
      maxSegmentBytes: [10_000, 10_000_000],
      flushIntervalMs: [100, 60_000],
      maxQueueBytes: [100_000, 200_000_000],
      maxAttempts: [1, 10],
    },
    limits: { uploadsPerWindow: COUNT_RANGE },
    choices: { mode: ["onError"] },
    custom: {
      endpoint: resolveDestination,
      maskSelectors: keepKind(isStrings, "a list of strings"),
      blockSelectors: keepKind(isStrings, "a list of strings"),
      loader: keepKind(isFunctionOrNull, HOOK_EXPECTED, describeKind),
      onSegment: keepKind(isFunctionOrNull, HOOK_EXPECTED, describeKind),
      // A string can be a token, so the report gives only the type.
      headers: keepKind(isHeaders, "an object of strings, a function or null", describeKind),
      plugins: keepKind(isFunctions, "a list of functions"),
      recordOptions: keepKind(isRecord, "an object"),
    },
  },
};

/** The boolean keys of the capture section. */
const CAPTURE_FLAG_KEYS = [
  "errors",
  "rejections",
  "resourceErrors",
  "fetch",
  "xhr",
  "httpMetrics",
  "navigation",
  "fullUrls",
  "webSocket",
  "uncleanExit",
  "serverTiming",
  "reports",
  "lifecycle",
] as const;

/** The origin of a sandboxed frame that lacks allow-same-origin. */
const SANDBOX_ORIGIN = "null";

/** How each expected value reads in a config.invalid message. */
const LEVEL_EXPECTED = `a level name: ${listOf(LEVEL_NAMES)}`;
const CONSOLE_LEVELS_EXPECTED = `a list of ${listOf(CONSOLE_METHOD_VALUES)}`;
const PATTERN_LIST_EXPECTED = "a list of strings and RegExp patterns";
const TARGET_LIST_EXPECTED =
  'a list of origin URLs such as "https://api.example" and RegExp patterns';
const ORIGIN_LIST_EXPECTED =
  'a list of origin URLs such as "https://app.example". For a sandboxed frame, set bus.mode: "sender" in the frame';
const LOG_TYPE_LIST_EXPECTED = `a list of log types: ${listOf(LOG_TYPE_VALUES)}`;
const DIAGNOSTIC_RECORDS_EXPECTED = "true, false or a list of diagnostic codes";

/** Function form of the headers option. */
type HeadersFunction = () => Record<string, string> | Promise<Record<string, string>>;

/** The headers option, after null has removed it. */
type HeadersOption = NonNullable<ObservabilityConfig["headers"]> | undefined;

/**
 * Formats a list of values as text, for example `"a", "b" or "c"`.
 * @param values Values to list.
 * @returns The text.
 */
function listOf(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/**
 * Describes a config value for a message. Never prints an object or a function.
 * @param value The value the consumer passed.
 * @returns Short text for the value.
 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }

  if (typeof value === "function") {
    return "a function";
  }

  if (typeof value === "object" && value !== null) {
    return "an object";
  }

  return String(value);
}

/**
 * Describes only the type of a value. A hook or a URL key can hold a token as a string, and
 * a diagnostic can become a record, so its text must not appear.
 * @param value The value the consumer passed.
 * @returns The type, for example "a string".
 */
function describeKind(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "a list";
  }

  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * Reports a value the option doesn't accept.
 * @param diagnostics Diagnostics reporter.
 * @param key Config key, for example `bus.mode`.
 * @param expected Describes the accepted values.
 * @param value The value the consumer passed.
 * @param kept Describes the value that stays in effect.
 * @param describe Describes the value. A key whose text can hold a secret passes describeKind.
 */
function reportInvalid(
  diagnostics: Diagnostics,
  key: string,
  expected: string,
  value: unknown,
  kept: string,
  describe: (value: unknown) => string = describeValue,
): void {
  diagnostics.report(
    "config.invalid",
    `${key} must be ${expected}. The value is ${describe(value)}. The library keeps ${kept}.`,
  );
}

/**
 * Reads an option that takes one value from a fixed list.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param accepted Accepted values.
 * @param fallback The current value.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value isn't accepted.
 */
function resolveChoice<T extends string>(
  key: string,
  value: unknown,
  accepted: readonly T[],
  fallback: T,
  diagnostics: Diagnostics,
): T {
  if (value === undefined) {
    return fallback;
  }

  const match = accepted.find((entry) => entry === value);
  if (match !== undefined) {
    return match;
  }

  // The value isn't printed, because a string can be a token put into the wrong key.
  diagnostics.report(
    "config.invalid",
    `${key} must be ${listOf(accepted)}. The library keeps "${fallback}".`,
  );
  return fallback;
}

/**
 * Reads a boolean option.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current value.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value isn't a boolean.
 */
function resolveBoolean(
  key: string,
  value: unknown,
  fallback: boolean,
  diagnostics: Diagnostics,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  reportInvalid(diagnostics, key, "true or false", value, String(fallback));
  return fallback;
}

/**
 * Reads an option that takes a finite number, 0 or more.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current value.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value isn't accepted.
 */
function resolveNonNegative(
  key: string,
  value: unknown,
  fallback: number,
  diagnostics: Diagnostics,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  reportInvalid(diagnostics, key, "a finite number of 0 or more", value, String(fallback));
  return fallback;
}

/**
 * Reads an option that takes an integer in a range.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param range Lowest and highest accepted value.
 * @param fallback The current value.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value isn't accepted.
 */
function resolveInteger(
  key: string,
  value: unknown,
  range: Range,
  fallback: number,
  diagnostics: Diagnostics,
): number {
  if (value === undefined) {
    return fallback;
  }

  const [min, max] = range;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }

  const expected = `an integer from ${String(min)} to ${String(max)}`;
  reportInvalid(diagnostics, key, expected, value, String(fallback));
  return fallback;
}

/**
 * Reads a limit that takes an integer in a range, or null for no limit.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param range Lowest and highest accepted value.
 * @param fallback The current limit. Null means no limit.
 * @param diagnostics Diagnostics reporter.
 * @returns The limit, or the fallback when the value isn't accepted.
 */
function resolveLimit(
  key: string,
  value: unknown,
  range: Range,
  fallback: number | null,
  diagnostics: Diagnostics,
): number | null {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  const [min, max] = range;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }

  const expected = `an integer from ${String(min)} to ${String(max)}, or null for no limit`;
  reportInvalid(diagnostics, key, expected, value, String(fallback));
  return fallback;
}

/**
 * Reads a hook. Undefined keeps the current hook and null removes it.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current hook.
 * @param diagnostics Diagnostics reporter.
 * @returns The hook, or undefined when there is none.
 */
function resolveHook<T>(
  key: string,
  value: unknown,
  fallback: T | undefined,
  diagnostics: Diagnostics,
): T | undefined {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return undefined;
  }

  if (typeof value === "function") {
    return value as T;
  }

  reportInvalid(diagnostics, key, HOOK_EXPECTED, value, "the current value", describeKind);
  return fallback;
}

/**
 * Stands in for a redact value that isn't a function when no redact hook was set before. The
 * record builder drops each record while it's the hook, so a record the app meant to redact
 * never leaves the page.
 * @returns null, which drops the record.
 */
export const REFUSE_RECORDS = (): null => null;

/**
 * Reads the redact hook. A value that isn't a function keeps the current hook, or fails closed
 * when there is none. Otherwise a typo such as `{ default: fn }` would send raw records.
 * @param value The value the consumer passed.
 * @param fallback The current hook.
 * @param diagnostics Diagnostics reporter.
 * @returns The hook, REFUSE_RECORDS, or undefined when there is none.
 */
function resolveRedact(
  value: unknown,
  fallback: ResolvedConfig["redact"],
  diagnostics: Diagnostics,
): ResolvedConfig["redact"] {
  if (value === undefined || value === null || typeof value === "function" || fallback) {
    return resolveHook("redact", value, fallback, diagnostics);
  }

  diagnostics.report(
    "config.invalid",
    `redact must be ${HOOK_EXPECTED}. The value is ${describeKind(value)}. The library drops each record until redact is a function or null.`,
  );
  return REFUSE_RECORDS;
}

/**
 * Reads the processors. A list with one entry that isn't a function is refused as a whole,
 * because running the other processors without it could let a record through unmasked. With
 * no current list, the library drops each record instead.
 * @param value The value the consumer passed.
 * @param fallback The current processors.
 * @param diagnostics Diagnostics reporter.
 * @returns A copy of the new list, the current list, or a list that drops each record.
 */
function resolveProcessors(
  value: unknown,
  fallback: ResolvedConfig["processors"],
  diagnostics: Diagnostics,
): ResolvedConfig["processors"] {
  if (value === undefined) {
    return fallback;
  }

  if (isFunctions(value)) {
    return [...(value as ResolvedConfig["processors"])];
  }

  if (fallback.length > 0) {
    reportInvalid(
      diagnostics,
      "processors",
      "a list of functions",
      value,
      "the current list",
      describeKind,
    );
    return fallback;
  }

  // No list to keep, and the app meant to process each record, so fail closed.
  diagnostics.report(
    "config.invalid",
    `processors must be a list of functions. The value is ${describeKind(value)}. The library drops each record until processors is a list of functions or [].`,
  );
  return [REFUSE_RECORDS];
}

/**
 * Reads a string option.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current value.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value isn't a string.
 */
function resolveString(
  key: string,
  value: unknown,
  fallback: string,
  diagnostics: Diagnostics,
): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    return value;
  }

  reportInvalid(diagnostics, key, "a string", value, "the current value");
  return fallback;
}

/**
 * Reads a sampling rate from 0 to 1.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current rate.
 * @param diagnostics Diagnostics reporter.
 * @returns The rate, or the fallback when the value isn't accepted.
 */
function resolveRate(
  key: string,
  value: unknown,
  fallback: number,
  diagnostics: Diagnostics,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (isRate(value)) {
    return value;
  }

  diagnostics.report(
    "config.invalid",
    `${key} must be 0..1. The value is ${describeValue(value)}. The library keeps ${String(fallback)}.`,
  );
  return fallback;
}

/**
 * Reads sampling.rates. A new map replaces the current one, as minLevels does, so a later call
 * can remove a namespace.
 * @param value The value the consumer passed.
 * @param fallback The current rates.
 * @param diagnostics Diagnostics reporter.
 * @returns The rate for each namespace prefix.
 */
function resolveRates(
  value: unknown,
  fallback: Record<string, number>,
  diagnostics: Diagnostics,
): Record<string, number> {
  if (value === undefined) {
    return fallback;
  }

  if (!isObject(value)) {
    reportInvalid(diagnostics, "sampling.rates", "an object of rates", value, "the current value");
    return fallback;
  }

  // A bad entry is left out, so the namespace falls back to a shorter prefix or defaultRate.
  // An undefined entry is the same as no entry.
  const rates: [string, number][] = [];
  for (const [ns, rate] of Object.entries(value)) {
    if (isRate(rate)) {
      rates.push([ns, rate]);
    } else if (rate !== undefined) {
      diagnostics.report(
        "config.invalid",
        `sampling.rates["${ns}"] must be 0..1. The value is ${describeValue(rate)}. The library ignores this entry.`,
      );
    }
  }

  // fromEntries creates own properties, and it copies, so the app's object never changes.
  return Object.fromEntries(rates);
}

/**
 * Merges and checks a section of integer options. The keys come only from `ranges`.
 * @param section Section name, for example `batching`.
 * @param input The values the consumer passed.
 * @param base The current values.
 * @param ranges Accepted range for each key.
 * @param diagnostics Diagnostics reporter.
 * @returns The value for every key in `ranges`.
 */
function resolveRanges<K extends string>(
  section: string,
  input: Partial<Record<NoInfer<K>, unknown>> | undefined,
  base: Record<NoInfer<K>, number>,
  ranges: Record<K, Range>,
  diagnostics: Diagnostics,
): Record<K, number> {
  const given: Partial<Record<K, unknown>> = input ?? {};
  const keys = Object.keys(ranges) as K[];

  return Object.fromEntries(
    keys.map((key): [K, number] => [
      key,
      resolveInteger(`${section}.${key}`, given[key], ranges[key], base[key], diagnostics),
    ]),
  ) as Record<K, number>;
}

/**
 * Reads a level name, ignoring case.
 * @param value The value the consumer passed.
 * @returns The level, or undefined when the value isn't a level name.
 */
function toLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const upper = value.toUpperCase();
  return LEVEL_NAMES.find((level) => level === upper);
}

/**
 * Reads a level option. Without this check, an unknown level silently drops every record.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current level.
 * @param diagnostics Diagnostics reporter.
 * @returns The level, or the fallback when the value isn't a level name.
 */
function resolveLevel(
  key: string,
  value: unknown,
  fallback: LogLevel,
  diagnostics: Diagnostics,
): LogLevel {
  if (value === undefined) {
    return fallback;
  }

  const level = toLevel(value);
  if (level !== undefined) {
    return level;
  }

  reportInvalid(diagnostics, key, LEVEL_EXPECTED, value, `"${fallback}"`);
  return fallback;
}

/**
 * Reads the minLevels option. Keeps every valid prefix and reports the rest. A new map
 * replaces the current one.
 * @param value The value the consumer passed.
 * @param fallback The current levels.
 * @param diagnostics Diagnostics reporter.
 * @returns The level for each namespace prefix.
 */
function resolveMinLevels(
  value: unknown,
  fallback: Record<string, LogLevel>,
  diagnostics: Diagnostics,
): Record<string, LogLevel> {
  if (value === undefined) {
    return fallback;
  }

  if (!isObject(value)) {
    reportInvalid(diagnostics, "minLevels", "an object of level names", value, "the current value");
    return fallback;
  }

  const levels: [string, LogLevel][] = [];
  for (const [prefix, raw] of Object.entries(value)) {
    const level = toLevel(raw);
    if (prefix !== "" && level !== undefined) {
      levels.push([prefix, level]);
    } else {
      reportInvalid(diagnostics, `minLevels["${prefix}"]`, LEVEL_EXPECTED, raw, "minLevel for it");
    }
  }

  // fromEntries creates own properties, so a "__proto__" key can't change the prototype.
  return Object.fromEntries(levels);
}

/**
 * Reads a list option. Keeps every accepted entry and reports the rest.
 * @param key Config key.
 * @param value The value the consumer passed.
 * @param fallback The current list.
 * @param expected Describes the accepted list.
 * @param accept Converts an entry, or returns undefined to reject it.
 * @param diagnostics Diagnostics reporter.
 * @returns The accepted entries, or the fallback when the value isn't a list.
 */
function resolveList<T>(
  key: string,
  value: unknown,
  fallback: T[],
  expected: string,
  accept: (entry: unknown) => T | undefined,
  diagnostics: Diagnostics,
): T[] {
  if (value === undefined) {
    return fallback;
  }

  if (!Array.isArray(value)) {
    reportInvalid(diagnostics, key, expected, value, "the current list");
    return fallback;
  }

  const kept: T[] = [];
  const entries: unknown[] = value;

  for (const entry of entries) {
    const accepted = accept(entry);
    if (accepted === undefined) {
      diagnostics.report(
        "config.invalid",
        `The library ignores the ${key} entry ${describeValue(entry)}. ${key} must be ${expected}.`,
      );
      continue;
    }
    kept.push(accepted);
  }

  return kept;
}

/**
 * Accepts a capture plugin entry.
 * @param entry List entry.
 * @returns The entry, or undefined.
 */
function toPlugin(entry: unknown): CapturePlugin | undefined {
  const valid =
    isObject(entry) &&
    typeof entry.name === "string" &&
    entry.name !== "" &&
    typeof entry.install === "function" &&
    typeof entry.uninstall === "function";

  return valid ? (entry as unknown as CapturePlugin) : undefined;
}

/**
 * Reads diagnostics.records. A list keeps its string entries and reports the rest.
 * @param key Full config key.
 * @param value The value the consumer passed.
 * @param fallback The current value.
 * @param diagnostics Diagnostics reporter.
 * @returns True, false or the list of codes.
 */
function resolveDiagnosticRecords(
  key: string,
  value: unknown,
  fallback: unknown,
  diagnostics: Diagnostics,
): unknown {
  if (value === undefined || typeof value === "boolean") {
    return value ?? fallback;
  }

  if (Array.isArray(value)) {
    return resolveList(key, value, [], DIAGNOSTIC_RECORDS_EXPECTED, toStringEntry, diagnostics);
  }

  reportInvalid(diagnostics, key, DIAGNOSTIC_RECORDS_EXPECTED, value, "the current value");
  return fallback;
}

/**
 * Accepts a string entry.
 * @param entry List entry.
 * @returns The entry, or undefined.
 */
function toStringEntry(entry: unknown): string | undefined {
  return typeof entry === "string" ? entry : undefined;
}

/**
 * Accepts a log type entry. An unknown type would never match a record, so it's rejected.
 * @param entry List entry.
 * @returns The log type, or undefined.
 */
function toLogType(entry: unknown): LogType | undefined {
  return LOG_TYPE_VALUES.find((type) => type === entry);
}

/**
 * Accepts a string or a RegExp entry.
 * @param entry List entry.
 * @returns The entry, or undefined.
 */
function toPattern(entry: unknown): string | RegExp | undefined {
  return typeof entry === "string" || entry instanceof RegExp ? entry : undefined;
}

/**
 * Accepts a console method name.
 * @param entry List entry.
 * @returns The method, or undefined.
 */
function toConsoleMethod(entry: unknown): CapturedConsoleMethod | undefined {
  return CONSOLE_METHOD_VALUES.find((method) => method === entry);
}

/**
 * Reads an origin entry. A URL with a path is reduced to its origin.
 * @param entry List entry.
 * @returns The origin, or undefined. resolveList reports the rejected entry.
 */
function toOrigin(entry: unknown): string | undefined {
  if (typeof entry !== "string") {
    return undefined;
  }

  // Every sandboxed and data: document has the opaque origin "null", so a single entry
  // would trust all of them.
  try {
    const { origin } = new URL(entry);
    return origin === SANDBOX_ORIGIN ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * Reads a trace header target. A string is reduced to its origin, and a RegExp is kept as is.
 * @param entry List entry.
 * @returns The target, or undefined. resolveList reports the rejected entry.
 */
function toTarget(entry: unknown): string | RegExp | undefined {
  return entry instanceof RegExp ? entry : toOrigin(entry);
}

/**
 * Checks whether a value is an object of string values.
 * @param value Value to test.
 * @returns True for an object whose values are all strings.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isObject(value)) {
    return false;
  }

  const values: unknown[] = Object.values(value);
  return values.every((entry) => typeof entry === "string");
}

/**
 * Reads the headers option.
 * @param value The value the consumer passed.
 * @param fallback The current headers.
 * @param diagnostics Diagnostics reporter.
 * @returns The headers, undefined after null, or the fallback for undefined or a bad value.
 */
function resolveHeaders(
  value: unknown,
  fallback: HeadersOption,
  diagnostics: Diagnostics,
): HeadersOption {
  if (value === undefined) {
    return fallback;
  }

  // null clears the headers. undefined keeps them, so an unset variable can't drop a token the
  // app still needs. With isolation on, configure() refuses the change and a logout rotates.
  if (value === null) {
    return undefined;
  }

  if (typeof value === "function") {
    return value as HeadersFunction;
  }

  if (isStringRecord(value)) {
    return value;
  }

  // The value can hold a token, and this message can become a record.
  diagnostics.report(
    "config.invalid",
    "headers must be an object of strings or a function. The library keeps the current headers.",
  );
  return fallback;
}

/**
 * Checks if a value implements the LogSerializer interface.
 * @param value Value to check.
 * @returns True if value implements serialize.
 */
function isSerializer(value: unknown): value is LogSerializer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const serialize: unknown = Reflect.get(value, "serialize");
  return typeof serialize === "function";
}

/**
 * Validates the serializer option. A name stays a name here, because the transport picks
 * the implementation.
 * @param requested Serializer name or custom serializer implementation.
 * @param previous The current serializer option.
 * @param diagnostics Diagnostics reporter.
 * @returns Valid serializer option.
 */
function resolveSerializer(
  requested: unknown,
  previous: SerializerChoice | undefined,
  diagnostics: Diagnostics,
): SerializerChoice {
  if (requested === undefined) {
    return previous ?? SERIALIZER_NAME_OTLP;
  }
  if (requested === SERIALIZER_NAME_OTLP || requested === SERIALIZER_NAME_ECS) {
    return requested;
  }
  if (isSerializer(requested)) {
    return requested;
  }

  diagnostics.report(
    "config.invalid",
    `serializer must be "${SERIALIZER_NAME_OTLP}", "${SERIALIZER_NAME_ECS}" or an implementation. The library keeps the current serializer.`,
  );
  return previous ?? SERIALIZER_NAME_OTLP;
}

/** The style keys the console option accepts. */
const CONSOLE_STYLE_KEYS = new Set(Object.keys(CONSOLE_DEFAULT_STYLES));

/**
 * Keeps the valid entries of a console styles object and reports every entry it drops.
 * @param styles The styles the consumer passed.
 * @param diagnostics Diagnostics reporter.
 * @returns The valid styles.
 */
function validStyles(styles: unknown, diagnostics: Diagnostics): ConsoleStyles {
  const valid: Record<string, string> = {};
  if (styles !== undefined && !isObject(styles)) {
    reportInvalid(
      diagnostics,
      "consoleOutput.styles",
      "an object of CSS strings",
      styles,
      "the styles",
    );
    return valid;
  }

  const entries: [string, unknown][] = Object.entries(styles ?? {});

  for (const [key, value] of entries) {
    if (!CONSOLE_STYLE_KEYS.has(key)) {
      diagnostics.report(
        "config.invalid",
        `The library ignores the unknown consoleOutput.styles key "${key}". Check the spelling.`,
      );
      continue;
    }

    // undefined keeps the current style, as it does for every other key.
    if (value === undefined) {
      continue;
    }

    if (typeof value !== "string") {
      diagnostics.report(
        "config.invalid",
        `consoleOutput.styles.${key} must be a string. The library keeps the current style.`,
      );
      continue;
    }

    valid[key] = value;
  }

  return valid;
}

/**
 * Reads the level from the consoleOutput option's object form.
 * @param requested The level the consumer passed.
 * @param previous The current console level. Null means the console is off.
 * @param diagnostics Diagnostics reporter.
 * @returns The level. An omitted or unknown level keeps the current one, also when it's off.
 */
function resolveConsoleLevel(
  requested: unknown,
  previous: LogLevel | null,
  diagnostics: Diagnostics,
): LogLevel | null {
  // An omitted level keeps the current one, so setting only the styles can't turn a console on.
  if (requested === undefined) {
    return previous;
  }

  const level = toLevel(requested);
  if (level !== undefined) {
    return level;
  }

  reportInvalid(
    diagnostics,
    "consoleOutput.level",
    LEVEL_EXPECTED,
    requested,
    "the current console level",
  );
  return previous;
}

/**
 * Normalizes the consoleOutput option into a level and a set of styles.
 * @param requested Consumer consoleOutput option.
 * @param previous The current console settings.
 * @param diagnostics Diagnostics reporter.
 * @returns Console settings. The level is null when the console is off.
 */
function resolveConsole(
  requested: ObservabilityConfig["consoleOutput"],
  previous: ResolvedConsole,
  diagnostics: Diagnostics,
): ResolvedConsole {
  if (requested === undefined) {
    return previous;
  }
  if (requested === false) {
    return { level: null, styles: previous.styles };
  }
  if (requested === true) {
    return { level: CONSOLE_DEFAULT_LEVEL, styles: previous.styles };
  }
  if (typeof requested === "string") {
    const level = toLevel(requested);
    if (level === undefined) {
      reportInvalid(
        diagnostics,
        "consoleOutput",
        LEVEL_EXPECTED,
        requested,
        "the current console level",
      );
      return previous;
    }

    return { level, styles: previous.styles };
  }

  // Guard against null and other values the type doesn't allow.
  if (typeof requested !== "object" || (requested as unknown) === null) {
    diagnostics.report(
      "config.invalid",
      "consoleOutput must be a boolean, a level or an object. The current console settings stay.",
    );
    return previous;
  }

  return {
    level: resolveConsoleLevel(requested.level, previous.level, diagnostics),
    styles: { ...previous.styles, ...validStyles(requested.styles, diagnostics) },
  };
}

/**
 * Merges and checks the sampling section.
 * @param input The sampling options the consumer passed.
 * @param base The current sampling options.
 * @param diagnostics Diagnostics reporter.
 * @returns The sampling options.
 */
function resolveSampling(
  input: Partial<SamplingOptions> | undefined,
  base: SamplingOptions,
  diagnostics: Diagnostics,
): SamplingOptions {
  const given = input ?? {};

  return {
    defaultRate: resolveRate(
      "sampling.defaultRate",
      given.defaultRate,
      base.defaultRate,
      diagnostics,
    ),
    remoteMaxRate: resolveRate(
      "sampling.remoteMaxRate",
      given.remoteMaxRate,
      base.remoteMaxRate,
      diagnostics,
    ),
    rates: resolveRates(given.rates, base.rates, diagnostics),
    alwaysSampleTypes: resolveList(
      "sampling.alwaysSampleTypes",
      given.alwaysSampleTypes,
      base.alwaysSampleTypes,
      LOG_TYPE_LIST_EXPECTED,
      toLogType,
      diagnostics,
    ),
    alwaysSampleFrom: resolveLevel(
      "sampling.alwaysSampleFrom",
      given.alwaysSampleFrom,
      base.alwaysSampleFrom,
      diagnostics,
    ),
    errorCeiling: resolveLimit(
      "sampling.errorCeiling",
      given.errorCeiling,
      COUNT_RANGE,
      base.errorCeiling,
      diagnostics,
    ),
    // A window of 0 ms starts a new window for every record, so the ceiling would never apply.
    errorCeilingWindowMs: resolveInteger(
      "sampling.errorCeilingWindowMs",
      given.errorCeilingWindowMs,
      POSITIVE_DURATION_RANGE,
      base.errorCeilingWindowMs,
      diagnostics,
    ),
    remote: resolveBoolean("sampling.remote", given.remote, base.remote, diagnostics),
  };
}

/**
 * Merges and checks the bus section.
 * @param input The bus options the consumer passed.
 * @param base The current bus options.
 * @param diagnostics Diagnostics reporter.
 * @returns The bus options. Every trusted origin is a bare origin.
 */
function resolveBus(
  input: Partial<BusOptions> | undefined,
  base: BusOptions,
  diagnostics: Diagnostics,
): BusOptions {
  const given = input ?? {};

  // A limit of 0 would stop every message, so each limit starts at 1 and null lifts it.
  return {
    sourcePolicy: resolveChoice(
      "bus.sourcePolicy",
      given.sourcePolicy,
      ["registered", "trusted-origin"],
      base.sourcePolicy,
      diagnostics,
    ),
    maxMessageBytes: resolveLimit(
      "bus.maxMessageBytes",
      given.maxMessageBytes,
      POSITIVE_RANGE,
      base.maxMessageBytes,
      diagnostics,
    ),
    maxRecordsPerMessage: resolveLimit(
      "bus.maxRecordsPerMessage",
      given.maxRecordsPerMessage,
      POSITIVE_RANGE,
      base.maxRecordsPerMessage,
      diagnostics,
    ),
    maxMessagesPerSecond: resolveLimit(
      "bus.maxMessagesPerSecond",
      given.maxMessagesPerSecond,
      POSITIVE_RANGE,
      base.maxMessagesPerSecond,
      diagnostics,
    ),
    mode: resolveChoice("bus.mode", given.mode, BUS_MODE_VALUES, base.mode, diagnostics),
    // Compare origins, not URLs. Otherwise an entry with a path never matches event.origin.
    trustedOrigins: resolveList(
      "bus.trustedOrigins",
      given.trustedOrigins,
      base.trustedOrigins,
      ORIGIN_LIST_EXPECTED,
      toOrigin,
      diagnostics,
    ),
    openFinRole: resolveChoice(
      "bus.openFinRole",
      given.openFinRole,
      OPENFIN_ROLE_VALUES,
      base.openFinRole,
      diagnostics,
    ),
  };
}

/**
 * Merges and checks the journey section.
 * @param input The journey options the consumer passed.
 * @param base The current journey options.
 * @param diagnostics Diagnostics reporter.
 * @returns The journey options.
 */
function resolveJourney(
  input: Partial<JourneyOptions> | undefined,
  base: JourneyOptions,
  diagnostics: Diagnostics,
): JourneyOptions {
  const given = input ?? {};

  return {
    scope: resolveChoice(
      "journey.scope",
      given.scope,
      JOURNEY_SCOPE_VALUES,
      base.scope,
      diagnostics,
    ),
    maxAgeMs: resolveInteger(
      "journey.maxAgeMs",
      given.maxAgeMs,
      JOURNEY_AGE_RANGE,
      base.maxAgeMs,
      diagnostics,
    ),
  };
}

/**
 * Merges and checks the retention section.
 * @param input The retention options the consumer passed.
 * @param base The current retention options.
 * @param diagnostics Diagnostics reporter.
 * @returns The retention options.
 */
function resolveRetention(
  input: Partial<RetentionOptions> | undefined,
  base: RetentionOptions,
  diagnostics: Diagnostics,
): RetentionOptions {
  const given = input ?? {};

  return {
    maxBatches: resolveInteger(
      "retention.maxBatches",
      given.maxBatches,
      MAX_BATCHES_RANGE,
      base.maxBatches,
      diagnostics,
    ),
    maxAgeMs: resolveLimit(
      "retention.maxAgeMs",
      given.maxAgeMs,
      RETENTION_AGE_RANGE,
      base.maxAgeMs,
      diagnostics,
    ),
    maxAttempts: resolveLimit(
      "retention.maxAttempts",
      given.maxAttempts,
      RETENTION_ATTEMPTS_RANGE,
      base.maxAttempts,
      diagnostics,
    ),
  };
}

/**
 * Reads a capture key that takes a boolean or an options object, where true means the defaults.
 * @param key Capture key, for example `longFrames`.
 * @param value The value the consumer passed.
 * @param base The current value.
 * @param diagnostics Diagnostics reporter.
 * @param fields Checks each field of an object. It gets the current object, or {} after a
 * boolean, so an omitted field keeps its current value.
 * @returns The boolean, the checked object, or the current value for a bad value.
 */
function resolveCaptureOptions<T extends object>(
  key: string,
  value: unknown,
  base: boolean | T,
  diagnostics: Diagnostics,
  fields: (given: Record<string, unknown>, previous: Partial<T>) => T,
): boolean | T {
  if (value === undefined) {
    return base;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (!isObject(value)) {
    diagnostics.report("config.invalid", `capture.${key} must be a boolean or an options object.`);
    return base;
  }

  const resolved = fields(value, typeof base === "object" ? base : {});

  // The resolved object has each known option, so a typo such as `threshold` isn't silent.
  for (const name of Object.keys(value)) {
    if (!hasOwn(resolved, name)) {
      diagnostics.report(
        "config.invalid",
        `The library ignores the unknown config key "capture.${key}.${name}". Check the spelling.`,
      );
    }
  }

  return resolved;
}

/**
 * Merges and checks the capture section.
 * @param input The capture options the consumer passed.
 * @param base The current capture options.
 * @param diagnostics Diagnostics reporter.
 * @returns The capture options.
 */
function resolveCapture(
  input: Partial<CaptureOptions> | undefined,
  base: CaptureOptions,
  diagnostics: Diagnostics,
): CaptureOptions {
  const given = input ?? {};
  const capture: CaptureOptions = {
    ...base,
    urlTransform: resolveHook(
      "capture.urlTransform",
      given.urlTransform,
      base.urlTransform,
      diagnostics,
    ),
    remoteToggles: resolveList(
      "capture.remoteToggles",
      given.remoteToggles,
      base.remoteToggles,
      "a list of capture switch names without privacy controls",
      (value) => REMOTE_CAPTURE_FLAGS.find((key) => key === value),
      diagnostics,
    ),
    resourceTiming: resolveCaptureOptions(
      "resourceTiming",
      given.resourceTiming,
      base.resourceTiming,
      diagnostics,
      (value, previous) => ({
        slowMs: resolveNonNegative(
          "capture.resourceTiming.slowMs",
          value.slowMs,
          previous.slowMs ?? RESOURCE_SLOW_MS,
          diagnostics,
        ),
      }),
    ),
    interactions: resolveCaptureOptions(
      "interactions",
      given.interactions,
      base.interactions,
      diagnostics,
      (value, previous) => resolveInteractions(value, previous, diagnostics),
    ),
    console: resolveCaptureOptions(
      "console",
      given.console,
      base.console,
      diagnostics,
      (value, previous) => ({
        levels: resolveList(
          "capture.console.levels",
          value.levels,
          previous.levels ?? ["error", "warn"],
          CONSOLE_LEVELS_EXPECTED,
          toConsoleMethod,
          diagnostics,
        ),
      }),
    ),
    longFrames: resolveCaptureOptions(
      "longFrames",
      given.longFrames,
      base.longFrames,
      diagnostics,
      (value, previous) => ({
        thresholdMs: resolveNonNegative(
          "capture.longFrames.thresholdMs",
          value.thresholdMs,
          previous.thresholdMs ?? LONG_FRAME_THRESHOLD_MS,
          diagnostics,
        ),
      }),
    ),
    userTiming: resolveCaptureOptions(
      "userTiming",
      given.userTiming,
      base.userTiming,
      diagnostics,
      (value, previous) => ({
        include: resolveList(
          "capture.userTiming.include",
          value.include,
          previous.include ?? [],
          PATTERN_LIST_EXPECTED,
          toPattern,
          diagnostics,
        ),
      }),
    ),
    webVitals: resolveCaptureOptions(
      "webVitals",
      given.webVitals,
      base.webVitals,
      diagnostics,
      (value, previous) => ({
        loader: resolveHook("capture.webVitals.loader", value.loader, previous.loader, diagnostics),
      }),
    ),
    ignoreUrls: resolveList(
      "capture.ignoreUrls",
      given.ignoreUrls,
      base.ignoreUrls,
      PATTERN_LIST_EXPECTED,
      toPattern,
      diagnostics,
    ),
    // A string target is an origin, because a substring test would also match a query value
    // or a longer host.
    propagateTraceHeaderTo: resolveList(
      "capture.propagateTraceHeaderTo",
      given.propagateTraceHeaderTo,
      base.propagateTraceHeaderTo,
      TARGET_LIST_EXPECTED,
      toTarget,
      diagnostics,
    ),
    plugins: resolveList(
      "capture.plugins",
      given.plugins,
      base.plugins,
      "a list of objects with a name, install() and uninstall()",
      toPlugin,
      diagnostics,
    ),
  };

  for (const key of CAPTURE_FLAG_KEYS) {
    capture[key] = resolveBoolean(`capture.${key}`, given[key], base[key], diagnostics);
  }

  return capture;
}

/**
 * Checks whether the browser parses a CSS selector. Without a document there's nothing to parse
 * with, so any selector passes.
 * @param selector The selector. matches("") throws, so "" fails.
 * @returns True for a selector the browser parses, or for any selector without a document.
 */
function parsesSelector(selector: string): boolean {
  if (typeof document === "undefined") {
    return true;
  }

  try {
    document.createElement("div").matches(selector);
    return true;
  } catch {
    // A selector the browser can't parse throws, and that's the answer. The fallback is false.
    return false;
  }
}

/**
 * Checks the click settings. An invalid value never turns on text or selector capture.
 * @param value The settings the app supplied.
 * @param previous The current settings, or {} when the capture was a boolean.
 * @param diagnostics Diagnostics reporter.
 * @returns The valid settings, with invalid values replaced by the current ones.
 */
function resolveInteractions(
  value: Record<string, unknown>,
  previous: InteractionOptions,
  diagnostics: Diagnostics,
): InteractionOptions {
  const ignore = value.ignoreSelector;
  let ignoreSelector = ignore === undefined ? previous.ignoreSelector : ignore;
  if (ignoreSelector !== undefined && ignoreSelector !== null) {
    if (typeof ignoreSelector !== "string" || !parsesSelector(ignoreSelector)) {
      diagnostics.report(
        "config.invalid",
        "capture.interactions.ignoreSelector must be a valid CSS selector or null.",
      );
      ignoreSelector = previous.ignoreSelector;
    }
  }
  // The name goes into a CSS attribute selector. Letters, digits, hyphens and underscores need
  // no escaping, and any other name keeps the current attribute.
  let actionAttribute = previous.actionAttribute ?? ACTION_ATTRIBUTE_DEFAULT;
  if (value.actionAttribute !== undefined) {
    if (typeof value.actionAttribute === "string" && /^[a-z][\w-]*$/i.test(value.actionAttribute)) {
      actionAttribute = value.actionAttribute;
    } else {
      reportInvalid(
        diagnostics,
        "capture.interactions.actionAttribute",
        "an attribute name of letters, digits, hyphens and underscores",
        value.actionAttribute,
        `"${actionAttribute}"`,
      );
    }
  }
  // Use ?? here, because "" is a real setting that turns the filter off.
  let deadClickIgnoreSelector = previous.deadClickIgnoreSelector ?? DEAD_CLICK_IGNORE_SELECTOR;
  const live = value.deadClickIgnoreSelector;
  if (live !== undefined) {
    // "" is the off switch, and matches("") throws, so "" skips the parse check.
    if (typeof live === "string" && (live === "" || parsesSelector(live))) {
      deadClickIgnoreSelector = live;
    } else {
      reportInvalid(
        diagnostics,
        "capture.interactions.deadClickIgnoreSelector",
        'a valid CSS selector, or "" to count every change',
        live,
        `"${deadClickIgnoreSelector}"`,
      );
    }
  }
  return {
    actionAttribute,
    text: resolveBoolean(
      "capture.interactions.text",
      value.text,
      previous.text ?? false,
      diagnostics,
    ),
    selector: resolveBoolean(
      "capture.interactions.selector",
      value.selector,
      previous.selector ?? false,
      diagnostics,
    ),
    ignoreSelector:
      typeof ignoreSelector === "string" || ignoreSelector === null ? ignoreSelector : undefined,
    maxTextChars: resolveInteger(
      "capture.interactions.maxTextChars",
      value.maxTextChars,
      [0, Number.MAX_SAFE_INTEGER],
      previous.maxTextChars ?? 50,
      diagnostics,
    ),
    rageClicks: resolveBoolean(
      "capture.interactions.rageClicks",
      value.rageClicks,
      previous.rageClicks ?? false,
      diagnostics,
    ),
    rageClickCount: resolveInteger(
      "capture.interactions.rageClickCount",
      value.rageClickCount,
      [2, 20],
      previous.rageClickCount ?? RAGE_CLICK_COUNT,
      diagnostics,
    ),
    rageClickWindowMs: resolveInteger(
      "capture.interactions.rageClickWindowMs",
      value.rageClickWindowMs,
      CLICK_WAIT_RANGE,
      previous.rageClickWindowMs ?? RAGE_CLICK_WINDOW_MS,
      diagnostics,
    ),
    deadClicks: resolveBoolean(
      "capture.interactions.deadClicks",
      value.deadClicks,
      previous.deadClicks ?? false,
      diagnostics,
    ),
    deadClickMs: resolveInteger(
      "capture.interactions.deadClickMs",
      value.deadClickMs,
      CLICK_WAIT_RANGE,
      previous.deadClickMs ?? DEAD_CLICK_MS,
      diagnostics,
    ),
    deadClickIgnoreSelector,
  };
}

/** The rules in the form resolvePolicy() reads. POLICY_RULES holds the typed form. */
interface PolicyLookup {
  /** Accepted range for each number key. */
  ranges: Partial<Record<string, Range>>;
  /** Accepted range for each key that also takes null. */
  limits: Partial<Record<string, Range>>;
  /** Accepted values for each choice key. */
  choices?: Partial<Record<string, readonly string[]>>;
  /** Resolver for each key with any other value type. */
  custom?: Partial<Record<string, CustomResolver>>;
}

/**
 * Checks one policy section. An invalid value keeps the current value.
 * @param name Section name for diagnostic messages.
 * @param input The settings the app supplied.
 * @param base The current settings.
 * @param rules The section's ranges and choices.
 * @param diagnostics Diagnostics reporter.
 * @returns The valid section.
 */
function resolvePolicy<T extends object>(
  name: string,
  input: Partial<T> | undefined,
  base: T,
  rules: PolicyLookup,
  diagnostics: Diagnostics,
): T {
  const next = { ...base };
  for (const key of Object.keys(base) as (keyof T & string)[]) {
    const value: unknown = input?.[key];
    const fallback: unknown = base[key];
    const range = rules.ranges[key];
    const limit = rules.limits[key];
    const choice = rules.choices?.[key];
    const custom = rules.custom?.[key];
    let resolved: unknown = fallback;
    if (custom) {
      resolved = custom(`${name}.${key}`, value, fallback, diagnostics);
    } else if (limit) {
      resolved = resolveLimit(
        `${name}.${key}`,
        value,
        limit,
        fallback as number | null,
        diagnostics,
      );
    } else if (typeof fallback === "number" && range) {
      resolved = resolveInteger(`${name}.${key}`, value, range, fallback, diagnostics);
    } else if (typeof fallback === "boolean") {
      resolved = resolveBoolean(`${name}.${key}`, value, fallback, diagnostics);
    } else if (choice) {
      resolved = resolveChoice(`${name}.${key}`, value, choice, String(fallback), diagnostics);
    } else if (value === undefined || typeof value === "string") {
      resolved = value ?? fallback;
    } else {
      reportInvalid(diagnostics, `${name}.${key}`, "a string", value, String(fallback));
    }
    Object.assign(next, { [key]: resolved });
  }
  return next;
}

/**
 * Returns the input without a section that isn't an object, and reports each one. Otherwise
 * the library would ignore a section such as `capture: null` with no report.
 * @param input Partial consumer configuration options.
 * @param diagnostics Diagnostics reporter.
 * @returns The input, with every bad section left out so its current values stay.
 */
function checkSections(
  input: Partial<ObservabilityConfig>,
  diagnostics: Diagnostics,
): Partial<ObservabilityConfig> {
  let checked = input;

  for (const section of CONFIG_SECTIONS) {
    const value: unknown = input[section];
    if (value !== undefined && !isObject(value)) {
      reportInvalid(diagnostics, section, "an object", value, "the current values");
      checked = { ...checked, [section]: undefined };
    }
  }

  return checked;
}

/**
 * Reports each pair of settings where one of them does nothing, so the app learns why. The
 * values stay. Only a call that sets one of the pair reports it, so an unrelated later call
 * stays quiet.
 * @param input The options of this configure() call, after checkSections().
 * @param config The resolved config.
 * @param diagnostics Diagnostics reporter.
 */
function reportIneffective(
  input: Partial<ObservabilityConfig>,
  config: ResolvedConfig,
  diagnostics: Diagnostics,
): void {
  const { capture, sampling } = config;
  const noEffect = (key: string, condition: string): void => {
    diagnostics.report("config.invalid", `${key} has no effect ${condition}. The value stays.`);
  };

  const setsTransport = input.transport !== undefined || input.transportWorker !== undefined;
  if (setsTransport && config.transport && config.transportWorker) {
    noEffect("transportWorker", "with transport");
  }

  const setsExit = input.transport !== undefined || input.transportOnExit !== undefined;
  if (setsExit && config.transportOnExit && !config.transport) {
    noEffect("transportOnExit", "without transport");
  }

  const setsToggles =
    input.capture?.remoteToggles !== undefined || input.sampling?.remote !== undefined;
  if (setsToggles && capture.remoteToggles.length > 0 && !sampling.remote) {
    noEffect("capture.remoteToggles", "without sampling.remote");
  }

  // A remote rule can still turn on fetch or xhr, and then the targets apply.
  const requests =
    capture.fetch ||
    capture.xhr ||
    capture.remoteToggles.includes("fetch") ||
    capture.remoteToggles.includes("xhr");
  const setsTargets =
    input.capture?.propagateTraceHeaderTo !== undefined ||
    input.capture?.fetch !== undefined ||
    input.capture?.xhr !== undefined;
  if (setsTargets && capture.propagateTraceHeaderTo.length > 0 && !requests) {
    noEffect("capture.propagateTraceHeaderTo", "without capture.fetch or capture.xhr");
  }
}

/**
 * Resolves partial configuration input into a validated ResolvedConfig.
 * @param input Partial consumer configuration options.
 * @param diagnostics Diagnostics reporter.
 * @param previous The active configuration, for an incremental reconfigure.
 * @returns Complete, validated configuration object.
 */
export function resolveConfig(
  input: Partial<ObservabilityConfig>,
  diagnostics: Diagnostics,
  previous?: ResolvedConfig,
): ResolvedConfig {
  const base = previous ?? DEFAULT_CONFIG;
  const given = checkSections(input, diagnostics);

  // Check every policy section against its own rules. POLICY_RULES key order is the report order.
  const policies = Object.fromEntries(
    (Object.keys(POLICY_RULES) as PolicySection[]).map((key) => [
      key,
      resolvePolicy(key, given[key], base[key], POLICY_RULES[key], diagnostics),
    ]),
  ) as Pick<ResolvedConfig, PolicySection>;
  // Every key is read on its own. Spreading the input would let undefined remove a hook.
  const merged: ResolvedConfig = {
    ...base,
    ...policies,

    lockConfiguration: resolveBoolean(
      "lockConfiguration",
      given.lockConfiguration,
      base.lockConfiguration,
      diagnostics,
    ),
    loggerCache: {
      // 0 turns the cache off, and null lifts the limit.
      maxEntries: resolveLimit(
        "loggerCache.maxEntries",
        given.loggerCache?.maxEntries,
        COUNT_RANGE,
        base.loggerCache.maxEntries,
        diagnostics,
      ),
    },
    securityContext: {
      // An empty id keeps the current one, and the runtime creates one at startup.
      id:
        resolveString(
          "securityContext.id",
          given.securityContext?.id,
          base.securityContext.id,
          diagnostics,
        ) || base.securityContext.id,
      isolation: resolveBoolean(
        "securityContext.isolation",
        given.securityContext?.isolation,
        base.securityContext.isolation,
        diagnostics,
      ),
    },
    // An unset environment variable arrives as undefined, so keep the current endpoint.
    endpoint: resolveEndpoint(given.endpoint, base.endpoint, diagnostics) as string | null,
    serviceName: resolveString("serviceName", given.serviceName, base.serviceName, diagnostics),
    serviceVersion: resolveString(
      "serviceVersion",
      given.serviceVersion,
      base.serviceVersion,
      diagnostics,
    ),
    environment: resolveString("environment", given.environment, base.environment, diagnostics),
    // A bad value reports config.invalid and the current value stays. Without this check, a bad
    // minLevel silently drops every record.
    enabled: resolveBoolean("enabled", given.enabled, base.enabled, diagnostics),
    payloadMode: resolveChoice(
      "payloadMode",
      given.payloadMode,
      ["copy", "defer"] as const,
      base.payloadMode,
      diagnostics,
    ),
    minLevel: resolveLevel("minLevel", given.minLevel, base.minLevel, diagnostics),
    minLevels: resolveMinLevels(given.minLevels, base.minLevels, diagnostics),
    processors: resolveProcessors(given.processors, base.processors, diagnostics),
    compression: resolveChoice(
      "compression",
      given.compression,
      COMPRESSION_VALUES,
      base.compression,
      diagnostics,
    ),
    credentials: resolveChoice(
      "credentials",
      given.credentials,
      CREDENTIALS_VALUES,
      base.credentials,
      diagnostics,
    ),
    headers: resolveHeaders(given.headers, base.headers, diagnostics),
    identity: resolveChoice(
      "identity",
      given.identity,
      IDENTITY_VALUES,
      base.identity,
      diagnostics,
    ),
    // A name stays a name, because the transport picks the implementation.
    serializer: resolveSerializer(given.serializer, previous?.serializer, diagnostics),
    consoleOutput: resolveConsole(given.consoleOutput, base.consoleOutput, diagnostics),
    sampling: resolveSampling(given.sampling, base.sampling, diagnostics),
    bus: resolveBus(given.bus, base.bus, diagnostics),
    batching: resolveRanges(
      "batching",
      given.batching,
      base.batching,
      BATCHING_RANGES,
      diagnostics,
    ),
    retention: resolveRetention(given.retention, base.retention, diagnostics),
    limits: resolveRanges("limits", given.limits, base.limits, LIMIT_RANGES, diagnostics),
    journey: resolveJourney(given.journey, base.journey, diagnostics),
    capture: resolveCapture(given.capture, base.capture, diagnostics),
    // Without a transport function, the pipeline drops every batch, so a bad value keeps the
    // current one.
    transport: resolveHook("transport", given.transport, base.transport, diagnostics),
    transportOnExit: resolveHook(
      "transportOnExit",
      given.transportOnExit,
      base.transportOnExit,
      diagnostics,
    ),
    transportWorker: resolveHook(
      "transportWorker",
      given.transportWorker,
      base.transportWorker,
      diagnostics,
    ),
    otelLoader: resolveHook("otelLoader", given.otelLoader, base.otelLoader, diagnostics),
    contextProvider: resolveHook(
      "contextProvider",
      given.contextProvider,
      base.contextProvider,
      diagnostics,
    ),
    redact: resolveRedact(given.redact, base.redact, diagnostics),
    onDiagnostic: resolveHook("onDiagnostic", given.onDiagnostic, base.onDiagnostic, diagnostics),
    onDrop: resolveHook("onDrop", given.onDrop, base.onDrop, diagnostics),
  };

  // Metric and span batches always go out as OTLP, whatever the log serializer is, so a
  // custom or ECS log format doesn't turn these endpoints off.
  for (const key of ["metricsEndpoint", "tracesEndpoint"] as const) {
    merged[key] = resolveDestination(key, given[key], base[key], diagnostics) as string | null;
  }

  // null selects console-only mode. "" is the default when no call has set an endpoint.
  // A custom transport needs no endpoint.
  if (merged.endpoint === "") {
    if (merged.transport === undefined) {
      diagnostics.report(
        "config.invalid",
        "endpoint is missing. The library drops each record. Set endpoint: null for console-only mode.",
      );
    }
  }

  // Only the delivery stack sends, and it loads only with an endpoint or a custom transport.
  for (const key of ["metricsEndpoint", "tracesEndpoint"] as const) {
    if (merged[key] !== null && merged.endpoint === null && !merged.transport) {
      diagnostics.report(
        "config.invalid",
        `${key} needs endpoint or transport. The library sends nothing to ${key}.`,
      );
    }
  }

  if (!merged.serviceName) {
    diagnostics.report(
      "config.invalid",
      `serviceName is missing. Every record reports service.name as '${UNKNOWN_SERVICE_NAME}'.`,
    );
    merged.serviceName = UNKNOWN_SERVICE_NAME;
  }

  // Swap the previous endpoints in the ignore list for the new ones to prevent a self-logging
  // loop. Otherwise one failed POST logs another failed POST without end.
  merged.capture.ignoreUrls = merged.capture.ignoreUrls.filter(
    (url) =>
      url !== previous?.endpoint &&
      url !== previous?.metricsEndpoint &&
      url !== previous?.tracesEndpoint &&
      url !== previous?.replay.endpoint,
  );
  for (const url of [
    merged.endpoint,
    merged.metricsEndpoint,
    merged.tracesEndpoint,
    merged.replay.endpoint,
  ]) {
    if (url && !merged.capture.ignoreUrls.includes(url)) {
      merged.capture.ignoreUrls = [...merged.capture.ignoreUrls, url];
    }
  }

  if (merged.delivery.retryMaxDelayMs < merged.delivery.retryBaseDelayMs) {
    diagnostics.report(
      "config.invalid",
      "delivery.retryMaxDelayMs must be at least retryBaseDelayMs.",
    );
    merged.delivery.retryBaseDelayMs = base.delivery.retryBaseDelayMs;
    merged.delivery.retryMaxDelayMs = base.delivery.retryMaxDelayMs;
  }
  reportIneffective(given, merged, diagnostics);
  reportUnknownKeys(input, diagnostics);

  return merged;
}

/**
 * Reports every config key the schema doesn't know, at the top level and one level inside
 * each section. A typo passes the `Partial` type check and has no effect, for example
 * `remoteUrl` for `endpoint` or `capture.webVital` for `capture.webVitals`. Namespace keys
 * under `sampling.rates` are free-form and one level deeper, so the check skips them.
 * @param input Partial consumer configuration options.
 * @param diagnostics Diagnostics reporter.
 */
function reportUnknownKeys(input: Partial<ObservabilityConfig>, diagnostics: Diagnostics): void {
  const known = new Set<string>([...Object.keys(DEFAULT_CONFIG), ...UNDEFAULTED_CONFIG_KEYS]);

  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      diagnostics.report(
        "config.invalid",
        `The library ignores the unknown config key "${key}". Check the spelling.`,
      );
    }
  }

  for (const section of CONFIG_SECTIONS) {
    const values: unknown = input[section];

    if (typeof values !== "object" || values === null) {
      continue;
    }

    const sectionKeys = new Set<string>([
      ...Object.keys(DEFAULT_CONFIG[section]),
      ...UNDEFAULTED_SECTION_KEYS[section],
    ]);

    for (const key of Object.keys(values)) {
      if (!sectionKeys.has(key)) {
        diagnostics.report(
          "config.invalid",
          `The library ignores the unknown config key "${section}.${key}". Check the spelling.`,
        );
      }
    }
  }
}

/**
 * Changes the active configuration object in place, so subsystems holding a section
 * reference see the update.
 * @param target Active configuration object to change.
 * @param next Configuration object with the new values.
 */
export function applyResolvedConfig(target: ResolvedConfig, next: ResolvedConfig): void {
  for (const key of Object.keys(next) as (keyof ResolvedConfig)[]) {
    // The cast widens the tuple so includes accepts any string key. With satisfies, the tuple
    // stays narrow and every non-section key fails to compile.
    if ((CONFIG_SECTIONS as readonly string[]).includes(key)) {
      continue;
    }
    Object.assign(target, { [key]: next[key] });
  }

  // Merge every section object in place to keep its reference. A new object would leave
  // subsystems on the old section they got at construction.
  for (const section of CONFIG_SECTIONS) {
    Object.assign(target[section] as object, next[section] as object);
  }
}

// src/core/config.ts
//
// This module resolves partial consumer options into a validated config.
// It also updates the live config. Obey the two rules below. A broken rule fails silently.
//   1. Merge a reconfigure onto the config in force, not onto the defaults.
//   2. Change the resolved object in place. Do not replace it. Subsystems keep the
//      reference from construction.
// No function in this file throws to the caller.

import {
  BEACON_LIMIT_BYTES,
  CONFIG_SECTIONS,
  CONSOLE_DEFAULT_LEVEL,
  CONSOLE_DEFAULT_STYLES,
  DEFAULT_CONFIG,
  LEVEL_ORDER,
  SAMPLING_RATE_FALLBACK,
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
  ConsoleOption,
  ConsoleStyles,
  JourneyOptions,
  LimitOptions,
  ObservabilityConfig,
  ResolvedConfig,
  ResolvedConsole,
  RetentionOptions,
  SamplingOptions,
  SerializerChoice,
} from "../models/config";
import type { LogLevel } from "../models/log-record";
import type { LogSerializer } from "../models/serializer";
import type { Diagnostics } from "./diagnostics";

/** Level names in severity order. */
const LEVEL_NAMES = Object.keys(LEVEL_ORDER) as readonly LogLevel[];

/** Accepted values of each choice option. */
const COMPRESSION_VALUES = ["gzip", "none"] as const;
const CREDENTIALS_VALUES = ["omit", "same-origin", "include"] as const;
const STORAGE_VALUES = ["auto", "indexeddb", "localstorage", "memory", "none"] as const;
const IDENTITY_VALUES = ["storage", "memory"] as const;
const BUS_MODE_VALUES = ["auto", "sender", "forwarder", "off"] as const;
const OPENFIN_ROLE_VALUES = ["auto", "provider", "client"] as const;
const JOURNEY_SCOPE_VALUES = ["auto", "context", "tab", "origin"] as const;
const CONSOLE_METHOD_VALUES = ["error", "warn", "info", "log"] as const;
const RETENTION_MODE_VALUES = ["limited", "until-delivered"] as const;

/** Lowest and highest accepted value of an integer option. */
type Range = readonly [min: number, max: number];

/** Accepted range of each batching key. */
const BATCHING_RANGES: Record<keyof BatchingOptions, Range> = {
  logFlushIntervalMs: [100, 60_000],
  logBatchSize: [1, 1000],
  metricFlushIntervalMs: [100, 60_000],
  metricBatchSize: [1, 1000],
};

/** Accepted range of each numeric retention key. */
const RETENTION_RANGES: Record<Exclude<keyof RetentionOptions, "mode">, Range> = {
  maxBatches: [1, 5000],
  maxAgeMs: [60_000, 7 * 24 * 60 * 60 * 1000],
  maxAttempts: [1, 20],
};

/**
 * Accepted range of each record limit. The maximum of maxRecordBytes is one beacon. The body and
 * the error fields are outside maxRecordBytes. An exit batch larger than one beacon goes to the
 * emergency queue.
 */
const LIMIT_RANGES: Record<keyof LimitOptions, Range> = {
  maxBodyChars: [256, 65_536],
  maxAttributeChars: [256, 65_536],
  maxAttributeCount: [1, 1024],
  maxStackChars: [256, 65_536],
  maxDepth: [1, 16],
  maxArrayLength: [1, 10_000],
  maxNodes: [100, 100_000],
  maxRecordBytes: [1024, BEACON_LIMIT_BYTES],
};

/** Accepted range of journey.maxAgeMs. */
const JOURNEY_AGE_RANGE: Range = [60_000, 24 * 60 * 60 * 1000];

/** Boolean keys of the capture section. */
const CAPTURE_FLAG_KEYS = [
  "errors",
  "rejections",
  "resourceErrors",
  "fetch",
  "xhr",
  "interactions",
  "navigation",
  "webVitals",
  "longFrames",
  "fullUrls",
] as const;

/** Origin of a sandboxed frame without allow-same-origin. */
const SANDBOX_ORIGIN = "null";

/** Text of each expected value in a config.invalid message. */
const LEVEL_EXPECTED = `a level name: ${listOf(LEVEL_NAMES)}`;
const CONSOLE_CAPTURE_EXPECTED = `true, false or a list of ${listOf(CONSOLE_METHOD_VALUES)}`;
const PATTERN_LIST_EXPECTED = "a list of strings and RegExp patterns";
const TARGET_LIST_EXPECTED =
  'a list of origin URLs such as "https://api.example" and RegExp patterns';
const ORIGIN_LIST_EXPECTED =
  'a list of origin URLs such as "https://app.example". For a sandboxed frame, set bus.mode: "sender" in the frame';
const STRING_LIST_EXPECTED = "a list of strings";

/** Function form of the headers option. */
type HeadersFunction = () => Record<string, string> | Promise<Record<string, string>>;

/** The headers option. */
type HeadersOption = ObservabilityConfig["headers"];

/**
 * Writes a list of values as text, for example `"a", "b" or "c"`.
 * @param values Values to list.
 * @returns The text.
 */
function listOf(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/**
 * Describes a config value for a message. It does not print an object or a function.
 * @param value Value that the consumer passed.
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
 * Reports a value that the option does not accept.
 * @param diagnostics Diagnostics reporter.
 * @param key Config key, for example `bus.mode`.
 * @param expected Text of the accepted values.
 * @param value Value that the consumer passed.
 * @param kept Text of the value that stays in force.
 */
function reportInvalid(
  diagnostics: Diagnostics,
  key: string,
  expected: string,
  value: unknown,
  kept: string,
): void {
  diagnostics.report(
    "config.invalid",
    `${key} must be ${expected}. The value is ${describeValue(value)}. The library keeps ${kept}.`,
  );
}

/**
 * Reads an option that accepts one value from a fixed list.
 * @param key Config key.
 * @param value Value that the consumer passed.
 * @param accepted Accepted values.
 * @param fallback Value in force.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value is not accepted.
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

  reportInvalid(diagnostics, key, listOf(accepted), value, `"${fallback}"`);
  return fallback;
}

/**
 * Reads a boolean option.
 * @param key Config key.
 * @param value Value that the consumer passed.
 * @param fallback Value in force.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value is not a boolean.
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
 * Reads an option that accepts a finite number of 0 or more.
 * @param key Config key.
 * @param value Value that the consumer passed.
 * @param fallback Value in force.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value is not accepted.
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
 * Reads an option that accepts an integer in a range.
 * @param key Config key.
 * @param value Value that the consumer passed.
 * @param range Lowest and highest accepted value.
 * @param fallback Value in force.
 * @param diagnostics Diagnostics reporter.
 * @returns The value, or the fallback when the value is not accepted.
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
 * Merges and checks a section of integer options. The keys come from `ranges` only.
 * @param section Section name, for example `batching`.
 * @param input Values that the consumer passed.
 * @param base Values in force.
 * @param ranges Accepted range of each key.
 * @param diagnostics Diagnostics reporter.
 * @returns The value of each key in `ranges`.
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
 * Reads a level name in any case.
 * @param value Value that the consumer passed.
 * @returns The level, or undefined when the value is not a level name.
 */
function toLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const upper = value.toUpperCase();
  return LEVEL_NAMES.find((level) => level === upper);
}

/**
 * Reads a level option. Without this check, an unknown level drops each record with no message.
 * @param key Config key.
 * @param value Value that the consumer passed.
 * @param fallback Level in force.
 * @param diagnostics Diagnostics reporter.
 * @returns The level, or the fallback when the value is not a level name.
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
 * Reads a list option. It keeps each accepted entry and reports each other entry.
 * @param key Config key.
 * @param value Value that the consumer passed.
 * @param fallback List in force.
 * @param expected Text of the accepted list.
 * @param accept Converts an entry, or returns undefined to reject it.
 * @param diagnostics Diagnostics reporter.
 * @returns The accepted entries, or the fallback when the value is not a list.
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
    reportInvalid(diagnostics, key, expected, value, "the list in force");
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
 * Accepts a string entry.
 * @param entry List entry.
 * @returns The entry, or undefined.
 */
function toStringEntry(entry: unknown): string | undefined {
  return typeof entry === "string" ? entry : undefined;
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
 * Reads an origin entry. A URL with a path gives its origin.
 * @param entry List entry.
 * @returns The origin, or undefined. resolveList reports the rejected entry.
 */
function toOrigin(entry: unknown): string | undefined {
  if (typeof entry !== "string") {
    return undefined;
  }

  // Each sandboxed and data: document has the opaque origin "null". One entry trusts all of them.
  try {
    const { origin } = new URL(entry);
    return origin === SANDBOX_ORIGIN ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * Reads a trace header target. A string gives its origin. A RegExp stays as it is.
 * @param entry List entry.
 * @returns The target, or undefined. resolveList reports the rejected entry.
 */
function toTarget(entry: unknown): string | RegExp | undefined {
  return entry instanceof RegExp ? entry : toOrigin(entry);
}

/**
 * Tests if a value is an object of string values.
 * @param value Value to test.
 * @returns True for an object whose values are all strings.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const values: unknown[] = Object.values(value);
  return values.every((entry) => typeof entry === "string");
}

/**
 * Reads the headers option.
 * @param value Value that the consumer passed.
 * @param fallback Headers in force.
 * @param diagnostics Diagnostics reporter.
 * @returns The headers, undefined for an explicit undefined, or the fallback for a bad value.
 */
function resolveHeaders(
  value: unknown,
  fallback: HeadersOption,
  diagnostics: Diagnostics,
): HeadersOption {
  // An explicit undefined clears the headers. After logout, the old token must not go on a send.
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "function") {
    return value as HeadersFunction;
  }

  if (isStringRecord(value)) {
    return value;
  }

  reportInvalid(
    diagnostics,
    "headers",
    "an object of strings or a function",
    value,
    "the headers in force",
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
 * Validates the serializer option. It does not change a name into an implementation.
 * The transport selects the implementation.
 * @param requested Serializer name or custom serializer implementation.
 * @param previous Serializer option in force.
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
    `serializer must be "${SERIALIZER_NAME_OTLP}", "${SERIALIZER_NAME_ECS}" or an implementation. The library uses "${SERIALIZER_NAME_OTLP}".`,
  );
  return SERIALIZER_NAME_OTLP;
}

/** Style keys that the console option accepts. */
const CONSOLE_STYLE_KEYS = new Set(Object.keys(CONSOLE_DEFAULT_STYLES));

/**
 * Keeps the valid entries of a console styles object. It reports each entry that it drops.
 * @param styles Styles that the consumer passed.
 * @param diagnostics Diagnostics reporter.
 * @returns The valid styles.
 */
function validStyles(styles: ConsoleStyles | undefined, diagnostics: Diagnostics): ConsoleStyles {
  const valid: Record<string, string> = {};
  const entries: [string, unknown][] = Object.entries(styles ?? {});

  for (const [key, value] of entries) {
    if (!CONSOLE_STYLE_KEYS.has(key)) {
      diagnostics.report(
        "config.invalid",
        `The library ignores the unknown console.styles key "${key}". Check the spelling.`,
      );
      continue;
    }

    if (typeof value !== "string") {
      diagnostics.report(
        "config.invalid",
        `console.styles.${key} must be a string. The library keeps the style in force.`,
      );
      continue;
    }

    valid[key] = value;
  }

  return valid;
}

/**
 * Reads the level of the console object form.
 * @param requested Level that the consumer passed.
 * @param previous Console level in force. Null means the console is off.
 * @param diagnostics Diagnostics reporter.
 * @returns The level. An unknown level keeps the level in force.
 */
function resolveConsoleLevel(
  requested: unknown,
  previous: LogLevel | null,
  diagnostics: Diagnostics,
): LogLevel | null {
  if (requested === undefined) {
    return previous ?? CONSOLE_DEFAULT_LEVEL;
  }

  const level = toLevel(requested);
  if (level !== undefined) {
    return level;
  }

  reportInvalid(
    diagnostics,
    "console.level",
    LEVEL_EXPECTED,
    requested,
    "the console level in force",
  );
  return previous;
}

/**
 * Normalizes the console option into a level and a set of styles.
 * @param requested Consumer console option.
 * @param previous Console settings in force.
 * @param diagnostics Diagnostics reporter.
 * @returns Console settings. The level is null when the console is off.
 */
function resolveConsole(
  requested: ConsoleOption | undefined,
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
        "console",
        LEVEL_EXPECTED,
        requested,
        "the console level in force",
      );
      return previous;
    }

    return { level, styles: previous.styles };
  }

  // Guard against null and other values that the type does not accept.
  if (typeof requested !== "object" || (requested as unknown) === null) {
    diagnostics.report(
      "config.invalid",
      "console must be a boolean, a level or an object. The console settings in force stay.",
    );
    return previous;
  }

  return {
    level: resolveConsoleLevel(requested.level, previous.level, diagnostics),
    styles: { ...previous.styles, ...validStyles(requested.styles, diagnostics) },
  };
}

/**
 * Merges and checks the sampling section. resolveConfig checks the rates after the merge.
 * @param input Sampling options that the consumer passed.
 * @param base Sampling options in force.
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
    ...base,
    ...given,
    rates: { ...base.rates, ...given.rates },
    alwaysSampleTypes: resolveList(
      "sampling.alwaysSampleTypes",
      given.alwaysSampleTypes,
      base.alwaysSampleTypes,
      STRING_LIST_EXPECTED,
      toStringEntry,
      diagnostics,
    ),
    remote: resolveBoolean("sampling.remote", given.remote, base.remote, diagnostics),
  };
}

/**
 * Merges and checks the bus section.
 * @param input Bus options that the consumer passed.
 * @param base Bus options in force.
 * @param diagnostics Diagnostics reporter.
 * @returns The bus options. Each trusted origin is a bare origin.
 */
function resolveBus(
  input: Partial<BusOptions> | undefined,
  base: BusOptions,
  diagnostics: Diagnostics,
): BusOptions {
  const given = input ?? {};

  return {
    mode: resolveChoice("bus.mode", given.mode, BUS_MODE_VALUES, base.mode, diagnostics),
    // Compare origins, not URLs. If not, an entry with a path never matches event.origin.
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
 * @param input Journey options that the consumer passed.
 * @param base Journey options in force.
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
 * @param input Retention options that the consumer passed.
 * @param base Retention options in force.
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
    mode: resolveChoice(
      "retention.mode",
      given.mode,
      RETENTION_MODE_VALUES,
      base.mode,
      diagnostics,
    ),
    ...resolveRanges("retention", given, base, RETENTION_RANGES, diagnostics),
  };
}

/**
 * Reads capture.console.
 * @param value Value that the consumer passed.
 * @param fallback Value in force.
 * @param diagnostics Diagnostics reporter.
 * @returns A boolean, or the accepted method names.
 */
function resolveCaptureConsole(
  value: unknown,
  fallback: boolean | CapturedConsoleMethod[],
  diagnostics: Diagnostics,
): boolean | CapturedConsoleMethod[] {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (!Array.isArray(value)) {
    reportInvalid(
      diagnostics,
      "capture.console",
      CONSOLE_CAPTURE_EXPECTED,
      value,
      "the value in force",
    );
    return fallback;
  }

  return resolveList(
    "capture.console",
    value,
    [],
    CONSOLE_CAPTURE_EXPECTED,
    toConsoleMethod,
    diagnostics,
  );
}

/**
 * Merges and checks the capture section.
 * @param input Capture options that the consumer passed.
 * @param base Capture options in force.
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
    ...given,
    console: resolveCaptureConsole(given.console, base.console, diagnostics),
    longFrameThresholdMs: resolveNonNegative(
      "capture.longFrameThresholdMs",
      given.longFrameThresholdMs,
      base.longFrameThresholdMs,
      diagnostics,
    ),
    ignoreUrls: resolveList(
      "capture.ignoreUrls",
      given.ignoreUrls,
      base.ignoreUrls,
      PATTERN_LIST_EXPECTED,
      toPattern,
      diagnostics,
    ),
    // A string target is an origin. A substring test also matches a query value or a longer host.
    propagateTraceHeaderTo: resolveList(
      "capture.propagateTraceHeaderTo",
      given.propagateTraceHeaderTo,
      base.propagateTraceHeaderTo,
      TARGET_LIST_EXPECTED,
      toTarget,
      diagnostics,
    ),
  };

  for (const key of CAPTURE_FLAG_KEYS) {
    capture[key] = resolveBoolean(`capture.${key}`, given[key], base[key], diagnostics);
  }

  return capture;
}

/**
 * Resolves partial configuration inputs into a validated ResolvedConfig object.
 * @param input Partial consumer configuration options.
 * @param diagnostics Diagnostics reporter.
 * @param previous Active configuration instance for incremental reconfigurations.
 * @returns Complete, validated configuration object.
 */
export function resolveConfig(
  input: Partial<ObservabilityConfig>,
  diagnostics: Diagnostics,
  previous?: ResolvedConfig,
): ResolvedConfig {
  const base = previous ?? DEFAULT_CONFIG;

  const merged: ResolvedConfig = {
    ...base,
    ...input,
    // An unset environment variable gives undefined. Keep the current endpoint.
    endpoint: input.endpoint === undefined ? base.endpoint : input.endpoint,
    // A bad value reports config.invalid. The value in force stays. Without this check, a bad
    // minLevel drops each record with no message.
    enabled: resolveBoolean("enabled", input.enabled, base.enabled, diagnostics),
    minLevel: resolveLevel("minLevel", input.minLevel, base.minLevel, diagnostics),
    compression: resolveChoice(
      "compression",
      input.compression,
      COMPRESSION_VALUES,
      base.compression,
      diagnostics,
    ),
    credentials: resolveChoice(
      "credentials",
      input.credentials,
      CREDENTIALS_VALUES,
      base.credentials,
      diagnostics,
    ),
    headers:
      "headers" in input ? resolveHeaders(input.headers, base.headers, diagnostics) : base.headers,
    storage: resolveChoice("storage", input.storage, STORAGE_VALUES, base.storage, diagnostics),
    identity: resolveChoice(
      "identity",
      input.identity,
      IDENTITY_VALUES,
      base.identity,
      diagnostics,
    ),
    // A serializer instance replaces the string name after the object merge.
    serializer: resolveSerializer(input.serializer, previous?.serializer, diagnostics),
    console: resolveConsole(input.console, base.console, diagnostics),
    sampling: resolveSampling(input.sampling, base.sampling, diagnostics),
    bus: resolveBus(input.bus, base.bus, diagnostics),
    batching: resolveRanges(
      "batching",
      input.batching,
      base.batching,
      BATCHING_RANGES,
      diagnostics,
    ),
    retention: resolveRetention(input.retention, base.retention, diagnostics),
    limits: resolveRanges("limits", input.limits, base.limits, LIMIT_RANGES, diagnostics),
    journey: resolveJourney(input.journey, base.journey, diagnostics),
    capture: resolveCapture(input.capture, base.capture, diagnostics),
  };

  // Guard against a value that cannot send. Keep the function in force.
  // Without a transport, the pipeline drops each batch.
  if (merged.transport !== undefined && typeof merged.transport !== "function") {
    diagnostics.report(
      "config.invalid",
      "transport must be a function. The library ignores the value.",
    );
    merged.transport = base.transport;
  }

  if (merged.onDrop !== undefined && typeof merged.onDrop !== "function") {
    diagnostics.report(
      "config.invalid",
      "onDrop must be a function. The library ignores the value.",
    );
    merged.onDrop = base.onDrop;
  }

  if (merged.transportOnExit !== undefined && typeof merged.transportOnExit !== "function") {
    diagnostics.report(
      "config.invalid",
      "transportOnExit must be a function. The library ignores the value.",
    );
    merged.transportOnExit = base.transportOnExit;
  }

  // null selects console-only mode. That value is valid. Report only an empty string.
  // A custom transport needs no endpoint.
  if (merged.endpoint === "") {
    if (merged.transport === undefined) {
      diagnostics.report(
        "config.invalid",
        "endpoint is missing. The library drops each record. Set endpoint: null for console-only mode.",
      );
    }
  } else if (merged.endpoint !== null) {
    try {
      new URL(merged.endpoint);
    } catch (error) {
      diagnostics.report(
        "config.invalid",
        `endpoint is not a valid absolute URL: ${merged.endpoint}.`,
        undefined,
        error,
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

  const rate: unknown = merged.sampling.defaultRate;
  if (typeof rate !== "number" || rate < SAMPLING_RATE_MIN || rate > SAMPLING_RATE_MAX) {
    diagnostics.report(
      "config.invalid",
      `sampling.defaultRate must be 0..1. The value is ${String(rate)}. The library uses ${String(SAMPLING_RATE_FALLBACK)}.`,
    );
    merged.sampling.defaultRate = SAMPLING_RATE_FALLBACK;
  }

  const maxRate: unknown = merged.sampling.remoteMaxRate;
  // The negated range test also rejects NaN.
  if (
    typeof maxRate !== "number" ||
    !(maxRate >= SAMPLING_RATE_MIN && maxRate <= SAMPLING_RATE_MAX)
  ) {
    diagnostics.report(
      "config.invalid",
      `sampling.remoteMaxRate must be 0..1. The value is ${String(maxRate)}. The library uses ${String(SAMPLING_RATE_FALLBACK)}.`,
    );
    merged.sampling.remoteMaxRate = SAMPLING_RATE_FALLBACK;
  }

  const rates: [string, unknown][] = Object.entries(merged.sampling.rates);
  for (const [ns, r] of rates) {
    if (typeof r !== "number" || r < SAMPLING_RATE_MIN || r > SAMPLING_RATE_MAX) {
      diagnostics.report(
        "config.invalid",
        `sampling.rates["${ns}"] must be 0..1. The value is ${String(r)}. The library uses ${String(SAMPLING_RATE_FALLBACK)}.`,
      );
      merged.sampling.rates[ns] = SAMPLING_RATE_FALLBACK;
    }
  }

  // Replace the previous endpoint in the ignore list. This prevents a self-logging loop.
  // Without it, one failed POST logs another failed POST with no end.
  merged.capture.ignoreUrls = merged.capture.ignoreUrls.filter((url) => url !== previous?.endpoint);
  if (merged.endpoint && !merged.capture.ignoreUrls.includes(merged.endpoint)) {
    merged.capture.ignoreUrls = [...merged.capture.ignoreUrls, merged.endpoint];
  }

  reportUnknownKeys(input, diagnostics);

  return merged;
}

/**
 * Reports each config key that the schema does not know. It checks the top level and
 * one level inside each section. A typo passes the `Partial` type check and has no effect.
 * Examples are `remoteUrl` for `endpoint` and `capture.webVital` for `capture.webVitals`.
 * Namespace keys under `sampling.rates` are free-form and one level deeper. The check
 * skips them.
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
 * Changes the active configuration object in place. Subsystems that hold a section
 * reference see the update.
 * @param target Active configuration object to change.
 * @param next Configuration object with the new values.
 */
export function applyResolvedConfig(target: ResolvedConfig, next: ResolvedConfig): void {
  for (const key of Object.keys(next) as (keyof ResolvedConfig)[]) {
    // The cast widens the tuple. Then includes accepts any string key. With satisfies,
    // the tuple stays narrow and each non-section key fails to compile.
    if ((CONFIG_SECTIONS as readonly string[]).includes(key)) {
      continue;
    }
    Object.assign(target, { [key]: next[key] });
  }

  // Merge each section object in place to keep its reference. A new object leaves
  // subsystems on the old section from construction.
  for (const section of CONFIG_SECTIONS) {
    Object.assign(target[section] as object, next[section] as object);
  }
}

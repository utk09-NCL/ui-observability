// src/core/config.ts
//
// This module resolves partial consumer options into a validated config.
// It also updates the live config. Obey the two rules below. A broken rule fails silently.
//   1. Merge a reconfigure onto the config in force, not onto the defaults.
//   2. Change the resolved object in place. Do not replace it. Subsystems keep the
//      reference from construction.
// No function in this file throws to the caller.

import {
  CONFIG_SECTIONS,
  CONSOLE_DEFAULT_LEVEL,
  DEFAULT_CONFIG,
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
  ConsoleOption,
  ObservabilityConfig,
  ResolvedConfig,
  SerializerChoice,
} from "../models/config";
import type { LogLevel } from "../models/log-record";
import type { LogSerializer } from "../models/serializer";
import type { Diagnostics } from "./diagnostics";

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

/**
 * Normalizes the console option into a minimum mirror level.
 * @param requested Consumer console option.
 * @param previous Console level in force.
 * @returns Minimum level to mirror, or null when mirroring is off.
 */
function resolveConsole(
  requested: ConsoleOption | undefined,
  previous: LogLevel | null,
): LogLevel | null {
  if (requested === undefined) {
    return previous;
  }
  if (requested === false) {
    return null;
  }
  if (requested === true) {
    return CONSOLE_DEFAULT_LEVEL;
  }
  return requested;
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
    // A serializer instance replaces the string name after the object merge.
    serializer: resolveSerializer(input.serializer, previous?.serializer, diagnostics),
    console: resolveConsole(input.console, base.console),
    sampling: {
      ...base.sampling,
      ...input.sampling,
      rates: { ...base.sampling.rates, ...input.sampling?.rates },
    },
    bus: { ...base.bus, ...input.bus },
    capture: { ...base.capture, ...input.capture },
  };

  // null selects console-only mode. That value is valid. Report only an empty string.
  if (merged.endpoint === "") {
    diagnostics.report(
      "config.invalid",
      "endpoint is missing. The library drops each record. Set endpoint: null for console-only mode.",
    );
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

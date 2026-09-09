// src/core/config.ts
//
// Resolves partial consumer options into validated configuration objects and updates live instances.
// Two rules, both failing silently when broken:
//   1. A reconfigure merges onto the config in force, not onto the defaults.
//   2. The resolved object is mutated, never replaced. Subsystems hold the
//      reference from construction.
// Nothing here throws into the caller.

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
import type { ConsoleOption, ObservabilityConfig, ResolvedConfig } from "../models/config";
import type { LogLevel } from "../models/log-record";
import type { LogSerializer } from "../models/serializer";
import { ecsSerializer } from "../transport/serializers/ecs";
import { otlpSerializer } from "../transport/serializers/otlp";
import type { Diagnostics } from "./diagnostics";

/**
 * Type guard verifying if an object implements the LogSerializer interface.
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
 * Resolves serializer selection to a valid LogSerializer instance.
 * @param requested Serializer name or custom serializer implementation.
 * @param previous Previously resolved serializer instance.
 * @param diagnostics Diagnostics reporter.
 * @returns Resolved LogSerializer instance.
 */
function resolveSerializer(
  requested: unknown,
  previous: LogSerializer | undefined,
  diagnostics: Diagnostics,
): LogSerializer {
  if (requested === undefined) {
    return previous ?? otlpSerializer;
  }
  if (requested === SERIALIZER_NAME_OTLP) {
    return otlpSerializer;
  }
  if (requested === SERIALIZER_NAME_ECS) {
    return ecsSerializer;
  }
  if (isSerializer(requested)) {
    return requested;
  }

  diagnostics.report(
    "config.invalid",
    `serializer must be "${SERIALIZER_NAME_OTLP}", "${SERIALIZER_NAME_ECS}" or an implementation`,
  );
  return otlpSerializer;
}

/**
 * Normalizes the console option into a minimum mirror level.
 * @param requested Consumer console option.
 * @param previous Console level in force.
 * @returns Min level to mirror, or null when mirroring is off.
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
 * @returns Fully populated and validated configuration object.
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
    // Serializer instance overrides string identifier after object merge.
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

  if (!merged.endpoint) {
    diagnostics.report(
      "config.invalid",
      "endpoint is missing. Records will be built and dropped, never sent.",
    );
  } else {
    try {
      new URL(merged.endpoint);
    } catch (error) {
      diagnostics.report(
        "config.invalid",
        `endpoint is not a valid absolute URL: ${merged.endpoint}`,
        undefined,
        error,
      );
    }
  }

  if (!merged.serviceName) {
    diagnostics.report(
      "config.invalid",
      `serviceName is missing. Every record will report service.name as '${UNKNOWN_SERVICE_NAME}'.`,
    );
    merged.serviceName = UNKNOWN_SERVICE_NAME;
  }

  const rate: unknown = merged.sampling.defaultRate;
  if (typeof rate !== "number" || rate < SAMPLING_RATE_MIN || rate > SAMPLING_RATE_MAX) {
    diagnostics.report("config.invalid", `sampling.defaultRate must be 0..1, got ${String(rate)}`);
    merged.sampling.defaultRate = SAMPLING_RATE_FALLBACK;
  }

  const rates: [string, unknown][] = Object.entries(merged.sampling.rates);
  for (const [ns, r] of rates) {
    if (typeof r !== "number" || r < SAMPLING_RATE_MIN || r > SAMPLING_RATE_MAX) {
      diagnostics.report(
        "config.invalid",
        `sampling.rates["${ns}"] must be 0..1, got ${String(r)}`,
      );
      merged.sampling.rates[ns] = SAMPLING_RATE_FALLBACK;
    }
  }

  // Replaces previous endpoint in ignore list to prevent self-logging loops. One
  // failed POST would otherwise log another, forever.
  merged.capture.ignoreUrls = merged.capture.ignoreUrls.filter((url) => url !== previous?.endpoint);
  if (merged.endpoint && !merged.capture.ignoreUrls.includes(merged.endpoint)) {
    merged.capture.ignoreUrls = [...merged.capture.ignoreUrls, merged.endpoint];
  }

  reportUnknownKeys(input, diagnostics);

  return merged;
}

/**
 * Reports a config key that matches nothing in the schema, at the top level and one
 * level inside each section. A typo type-checks through `Partial` and then does
 * nothing: `remoteUrl` for `endpoint`, `capture.webVital` for `capture.webVitals`.
 * Namespace keys under `sampling.rates` are free-form and sit a level deeper.
 * @param input Partial consumer configuration options.
 * @param diagnostics Diagnostics reporter.
 */
function reportUnknownKeys(input: Partial<ObservabilityConfig>, diagnostics: Diagnostics): void {
  const known = new Set<string>([...Object.keys(DEFAULT_CONFIG), ...UNDEFAULTED_CONFIG_KEYS]);

  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      diagnostics.report("config.invalid", `unknown config key "${key}", ignored. Typo?`);
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
          `unknown config key "${section}.${key}", ignored. Typo?`,
        );
      }
    }
  }
}

/**
 * Mutates an existing configuration object in place to propagate updates to referenced sections.
 * @param target Active configuration object to mutate.
 * @param next Source configuration object containing updated values.
 */
export function applyResolvedConfig(target: ResolvedConfig, next: ResolvedConfig): void {
  for (const key of Object.keys(next) as (keyof ResolvedConfig)[]) {
    // Cast widens tuple so includes accepts arbitrary string keys. satisfies leaves
    // it narrow and every non-section key fails to compile.
    if ((CONFIG_SECTIONS as readonly string[]).includes(key)) {
      continue;
    }
    Object.assign(target, { [key]: next[key] });
  }

  // Merges section objects in place to preserve object references. A new object
  // leaves subsystems on the section captured at construction.
  for (const section of CONFIG_SECTIONS) {
    Object.assign(target[section] as object, next[section] as object);
  }
}

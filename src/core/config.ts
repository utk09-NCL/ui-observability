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
  DEFAULT_CONFIG,
  SAMPLING_RATE_FALLBACK,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
  SERIALIZER_NAME_ECS,
  SERIALIZER_NAME_OTLP,
  UNDEFAULTED_CONFIG_KEYS,
  UNKNOWN_SERVICE_NAME,
} from "../constants";
import type { ObservabilityConfig, ResolvedConfig } from "../models/config";
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
    streams: {
      logs: { ...base.streams.logs, ...input.streams?.logs },
      metrics: { ...base.streams.metrics, ...input.streams?.metrics },
    },
    storage: { ...base.storage, ...input.storage },
    retry: { ...base.retry, ...input.retry },
    sampling: {
      ...base.sampling,
      ...input.sampling,
      rates: { ...base.sampling.rates, ...input.sampling?.rates },
    },
    journey: { ...base.journey, ...input.journey },
    bus: { ...base.bus, ...input.bus },
    capture: { ...base.capture, ...input.capture },
    limits: { ...base.limits, ...input.limits },
    console: { ...base.console, ...input.console },
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

  // Validates top-level keys against known schema to detect configuration typos.
  // remoteUrl instead of endpoint is otherwise accepted in silence.
  const known = new Set<string>([...Object.keys(DEFAULT_CONFIG), ...UNDEFAULTED_CONFIG_KEYS]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      diagnostics.report("config.invalid", `unknown config key "${key}", ignored. Typo?`);
    }
  }

  return merged;
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

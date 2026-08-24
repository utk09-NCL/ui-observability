// src/core/config.ts
//
// Turns whatever a consumer passed into something the rest of the library can
// read without checking. Two rules, each of which fails silently when broken:
//
//   1. A reconfigure merges onto the config in force, never onto the defaults.
//      Anything else turns a one-key change into a full reset.
//   2. The resolved config object is mutated, never replaced. That is what
//      `applyResolvedConfig` is for.
//
// Nothing here throws into the caller. Consumers write plain JavaScript too, so
// a field typed as a number can hold anything at runtime. Bad values report to
// diagnostics and fall back to a default.

import {
  CONFIG_SECTIONS,
  DEFAULT_CONFIG,
  SAMPLING_RATE_FALLBACK,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
  UNDEFAULTED_CONFIG_KEYS,
  UNKNOWN_SERVICE_NAME,
} from "../constants";
import type { ObservabilityConfig, ResolvedConfig } from "../models/config";
import type { Diagnostics } from "./diagnostics";

/**
 * Resolve a partial config into a fully populated one, reporting anything
 * suspicious.
 *
 * `previous` is the config in force. Merging onto it is what makes
 * `configure({ enabled: false })` a kill switch rather than a reset that drops
 * the endpoint, the service name and every capture setting.
 *
 * Resolves only, and announces nothing: whether the result is adopted is known
 * to the caller that swaps the live config in, which reports it there.
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
    streams: {
      logs: { ...base.streams.logs, ...input.streams?.logs },
      metrics: { ...base.streams.metrics, ...input.streams?.metrics },
    },
    storage: { ...base.storage, ...input.storage },
    retry: { ...base.retry, ...input.retry },
    // `rates` gets a fresh object of its own because the clamping below mutates
    // it, and mutating the caller's object is a side effect nobody asked for.
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

  // Read as `unknown` on purpose. The declared type says number, but a
  // JavaScript consumer can pass a string, and this is the only place that
  // notices. Without the widening the guard below is dead code.
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

  // The serializer is chosen here once the transport reads it. The two
  // implementations exist; nothing consumes a resolved one yet.
  // Final form:
  //   if (typeof input.serializer === "object") { merged.serializer = input.serializer; }
  //   else if (input.serializer === "ecs") { merged.serializer = ecsSerializer; }
  //   else if (input.serializer === "otlp") { merged.serializer = otlpSerializer; }

  // The endpoint must never be logged by the network capture, or one failed
  // POST produces a log, which produces a POST, which produces a log. On a
  // reconfigure the OLD endpoint has to come back out as well, or changing the
  // endpoint leaves a stale entry behind and the live one is not covered.
  merged.capture.ignoreUrls = merged.capture.ignoreUrls.filter((url) => url !== previous?.endpoint);
  if (merged.endpoint && !merged.capture.ignoreUrls.includes(merged.endpoint)) {
    merged.capture.ignoreUrls = [...merged.capture.ignoreUrls, merged.endpoint];
  }

  // Catches a typo that is otherwise undebuggable: `remoteUrl` instead of
  // `endpoint` type-checks, because the argument is a `Partial`, and nothing
  // is ever sent.
  const known = new Set<string>([...Object.keys(DEFAULT_CONFIG), ...UNDEFAULTED_CONFIG_KEYS]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      diagnostics.report("config.invalid", `unknown config key "${key}", ignored. Typo?`);
    }
  }

  return merged;
}

/**
 * Copy `next` into the live config object in place, preserving the identity of
 * that object and of every section inside it.
 *
 * Half the library captures `config`, or `config.capture`, once at construction
 * and never looks it up again. Assigning a new object would leave those
 * components reading settings the consumer believes they changed, and a
 * debugger shows the runtime holding the new values while a component beside it
 * uses the old ones.
 *
 * Scalars are copied with `Object.assign` and a computed key: `ResolvedConfig`
 * is an interface, so it has no implicit index signature and neither direction
 * of a `target as Record<string, unknown>` assertion is legal under `strict`.
 */
export function applyResolvedConfig(target: ResolvedConfig, next: ResolvedConfig): void {
  for (const key of Object.keys(next) as (keyof ResolvedConfig)[]) {
    // `as`, not `satisfies`: the tuple has to widen so `includes` accepts any
    // key. `satisfies` leaves it narrow and every non-section key fails to compile.
    if ((CONFIG_SECTIONS as readonly string[]).includes(key)) {
      continue;
    }
    Object.assign(target, { [key]: next[key] });
  }
  // Sections are merged into the objects that are already there, so anything
  // holding a reference to one of them sees the new values.
  for (const section of CONFIG_SECTIONS) {
    Object.assign(target[section] as object, next[section] as object);
  }
}

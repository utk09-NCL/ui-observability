// src/core/config.ts
//
// Turns whatever a consumer passed into something the rest of the library can
// read without checking. Two rules govern this file, and breaking either one
// produces silence rather than an error:
//
//   1. A reconfigure merges onto the config already in force, never onto the
//      defaults. Anything else turns a one-key change into a full reset.
//   2. The resolved config object is mutated, never replaced. That is what
//      `applyResolvedConfig` is for.
//
// Configuration never throws into the caller. This library is consumed from
// plain JavaScript as well as TypeScript, so a value the type system says is a
// number can be anything at all at runtime. Every bad value reports to
// diagnostics and falls back to a default, because a logger that throws while
// being set up takes the application down with it.

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
 * `previous` is the config already in force. A second `configure()` call merges
 * onto it rather than onto the defaults, which is what makes
 * `configure({ enabled: false })` usable as a kill switch. Resolving that
 * against the defaults would throw away the endpoint, the service name and
 * every capture setting, and the only symptom would be silence.
 *
 * This function only resolves. It announces nothing, because it cannot know
 * whether its result is ever adopted: the caller that swaps the live config in
 * is the one that knows a reconfigure really happened, and reports it there.
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

  // Read as `unknown` on purpose. The declared type says these are numbers, and
  // from TypeScript they always are, but a JavaScript consumer can pass a string
  // or a null and this is the only place that will ever notice. Widening the
  // read is what keeps the guard a real check instead of dead code.
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

  // Which serializer turns records into a wire payload is chosen here, once
  // concrete serializer implementations exist. Nothing reads this field yet.
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

  // The failure this catches is otherwise impossible to debug: you write
  // `remoteUrl` instead of `endpoint`, every type checks out because the
  // argument is a `Partial`, and nothing is ever sent.
  const known = new Set<string>([...Object.keys(DEFAULT_CONFIG), ...UNDEFAULTED_CONFIG_KEYS]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      diagnostics.report("config.invalid", `unknown config key "${key}", ignored. Typo?`);
    }
  }

  return merged;
}

/**
 * Copy `next` into the live config object, in place, preserving the identity of
 * that object and of every section inside it.
 *
 * This is the counterpart to the note on `ResolvedConfig`. Half the library
 * captures `config`, or `config.capture`, or `config.journey`, once at
 * construction and never looks it up again. Assigning a new object to the
 * runtime's config updates only the components that are explicitly handed the
 * new one, and leaves every other one reading settings the consumer believes
 * they changed. That failure is silent and it is very hard to see in a debugger,
 * because the runtime's config shows the new values while the component next to
 * it is using the old ones.
 *
 * The scalar copy goes through `Object.assign` with a computed key rather than
 * an indexed write. `ResolvedConfig` is an interface, so TypeScript gives it no
 * implicit index signature and neither direction of a
 * `target as Record<string, unknown>` assertion is legal under `strict`.
 */
export function applyResolvedConfig(target: ResolvedConfig, next: ResolvedConfig): void {
  for (const key of Object.keys(next) as (keyof ResolvedConfig)[]) {
    // `as`, not `satisfies`. This has to widen the tuple so `includes` accepts
    // any key; `satisfies` only checks the type and leaves it narrow, and then
    // every non-section key is a type error at the call.
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

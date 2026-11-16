// src/core/remote-rules.ts
//
// Validates the sampling rules from the ingest server and puts them into effect.
// Imported by the sender and the bus. The main bundle doesn't include it.

import {
  LEVEL_ORDER,
  REMOTE_CAPTURE_FLAGS,
  REMOTE_SAMPLING_MAX_CHARS,
  REMOTE_SAMPLING_MAX_RATES,
  REMOTE_SAMPLING_MAX_TTL_MS,
  REMOTE_SAMPLING_VERSION,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogLevel } from "../models/log-record";
import { isObject } from "../utils/guards";
import type { Diagnostics } from "./diagnostics";
import {
  type RemoteRules,
  RemoteSampling,
  type RemoteSlot,
  type RemoteUpdate,
} from "./remote-sampling";

/** One validation step failed. The message states the rule. */
class RuleError extends Error {}

/**
 * Checks whether a value is a rate.
 * @param value Value to check.
 * @returns True for a number from 0 to 1. NaN fails.
 */
function isRate(value: unknown): value is number {
  return typeof value === "number" && value >= SAMPLING_RATE_MIN && value <= SAMPLING_RATE_MAX;
}

/**
 * Parses the header text as JSON.
 * @param text Header text.
 * @returns The parsed value.
 * @throws RuleError when the text is too long or isn't JSON.
 */
function parseText(text: string): unknown {
  if (text.length > REMOTE_SAMPLING_MAX_CHARS) {
    throw new RuleError(
      `The header is longer than ${String(REMOTE_SAMPLING_MAX_CHARS)} characters.`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    // The caller reports the RuleError.
    throw new RuleError("The header is not valid JSON.");
  }
}

/**
 * Reads the namespace rates.
 * @param value Value of `rates`.
 * @returns The rates.
 * @throws RuleError when a rate is invalid.
 */
function readRates(value: unknown): Record<string, number> {
  if (value === undefined) {
    return {};
  }

  const rule = `rates must be an object with at most ${String(REMOTE_SAMPLING_MAX_RATES)} rates from 0 to 1.`;

  if (!isObject(value)) {
    throw new RuleError(rule);
  }

  const entries = Object.entries(value);

  if (entries.length > REMOTE_SAMPLING_MAX_RATES || !entries.every(([, rate]) => isRate(rate))) {
    throw new RuleError(rule);
  }

  // fromEntries creates own properties, so a "__proto__" key can't change the prototype.
  return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * Reads the level for every namespace prefix.
 * @param value Value of `minLevels`.
 * @returns The levels.
 * @throws RuleError when a level is invalid.
 */
function readMinLevels(value: unknown): Record<string, LogLevel> {
  const rule = `minLevels must be an object with at most ${String(REMOTE_SAMPLING_MAX_RATES)} level names.`;

  if (!isObject(value)) {
    throw new RuleError(rule);
  }

  const entries = Object.entries(value);
  const valid = entries.every(
    ([, level]) => typeof level === "string" && Object.hasOwn(LEVEL_ORDER, level),
  );

  if (entries.length > REMOTE_SAMPLING_MAX_RATES || !valid) {
    throw new RuleError(rule);
  }

  // fromEntries creates own properties, so a "__proto__" key can't change the prototype.
  return Object.fromEntries(entries) as Record<string, LogLevel>;
}

/**
 * Validates the rules. Sampling applies `remoteMaxRate` when it reads them.
 * @param value Parsed header value.
 * @returns The rules and their TTL.
 * @throws RuleError when a field is invalid.
 */
function readRules(value: unknown): RemoteUpdate {
  if (!isObject(value)) {
    throw new RuleError("The rules must be an object.");
  }

  if (value.v !== REMOTE_SAMPLING_VERSION) {
    throw new RuleError(`The version must be ${String(REMOTE_SAMPLING_VERSION)}.`);
  }

  const { ttlMs, defaultRate, minLevel } = value;

  if (typeof ttlMs !== "number" || !(ttlMs > 0 && ttlMs <= REMOTE_SAMPLING_MAX_TTL_MS)) {
    throw new RuleError(
      `ttlMs must be a number more than 0 and at most ${String(REMOTE_SAMPLING_MAX_TTL_MS)}.`,
    );
  }

  if (defaultRate !== undefined && !isRate(defaultRate)) {
    throw new RuleError("defaultRate must be a number from 0 to 1.");
  }

  if (
    minLevel !== undefined &&
    !(typeof minLevel === "string" && Object.hasOwn(LEVEL_ORDER, minLevel))
  ) {
    throw new RuleError("minLevel must be a level name, for example DEBUG.");
  }

  const rules: RemoteRules = { rates: readRates(value.rates) };

  if (defaultRate !== undefined) {
    rules.defaultRate = defaultRate;
  }

  if (minLevel !== undefined) {
    rules.minLevel = minLevel as LogLevel;
  }

  if (value.minLevels !== undefined) {
    rules.minLevels = readMinLevels(value.minLevels);
  }

  if (value.capture !== undefined) {
    const capture = value.capture;
    if (!isObject(capture)) {
      throw new RuleError("capture must be an object of capture switches.");
    }

    const entries = Object.entries(capture);
    if (
      !entries.every(
        ([key, flag]) =>
          REMOTE_CAPTURE_FLAGS.some((name) => name === key) && typeof flag === "boolean",
      )
    ) {
      throw new RuleError(
        "capture must contain boolean capture switches without privacy controls.",
      );
    }

    rules.capture = Object.fromEntries(entries);
  }

  return { rules, ttlMs };
}

/**
 * Validates sampling rules from the server. One invalid rule rejects all of them.
 * @param raw Header text, or a parsed object from a custom transport or the bus.
 * @param diagnostics Diagnostics reporter.
 * @returns The rules and their TTL, or null if they are invalid.
 */
export function parseRemoteRules(raw: unknown, diagnostics: Diagnostics): RemoteUpdate | null {
  try {
    return readRules(typeof raw === "string" ? parseText(raw) : raw);
  } catch (error) {
    const reason = error instanceof RuleError ? ` ${error.message}` : "";

    diagnostics.report(
      "config.invalid",
      `The library ignores the sampling rules from the server.${reason}`,
      undefined,
      error,
    );
    return null;
  }
}

/**
 * Puts rules into effect in the runtime's slot. Creates the overlay for the first rules.
 * @param slot The runtime's slot.
 * @param config Active configuration instance.
 * @param update Validated rules, or null when the upstream has no rules.
 */
export function applyRemote(
  slot: RemoteSlot,
  config: ResolvedConfig,
  update: RemoteUpdate | null,
): void {
  if (update) {
    slot.sampling ??= new RemoteSampling(config);
  }

  slot.sampling?.apply(update);
  slot.changed?.();
}

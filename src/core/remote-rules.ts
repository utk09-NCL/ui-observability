// src/core/remote-rules.ts
//
// Validates the sampling rules from the ingest server and puts them in force.
// The sender and the bus import this module.
// The main bundle does not include it.

import {
  LEVEL_ORDER,
  REMOTE_SAMPLING_MAX_CHARS,
  REMOTE_SAMPLING_MAX_RATES,
  REMOTE_SAMPLING_MAX_TTL_MS,
  REMOTE_SAMPLING_VERSION,
  SAMPLING_RATE_MAX,
  SAMPLING_RATE_MIN,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogLevel } from "../models/log-record";
import type { Diagnostics } from "./diagnostics";
import {
  type RemoteRules,
  RemoteSampling,
  type RemoteSlot,
  type RemoteUpdate,
} from "./remote-sampling";

/** Failure of one validation step. The message states the rule. */
class RuleError extends Error {}

/**
 * Tests whether a value is a rate.
 * @param value Value to test.
 * @returns True for a number from 0 to 1. NaN fails.
 */
function isRate(value: unknown): value is number {
  return typeof value === "number" && value >= SAMPLING_RATE_MIN && value <= SAMPLING_RATE_MAX;
}

/**
 * Tests whether a value is a plain object.
 * @param value Value to test.
 * @returns True for an object that is not null and not an array.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the header text as JSON.
 * @param text Header text.
 * @returns The parsed value.
 * @throws RuleError when the text is too long or is not JSON.
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
 * @throws RuleError when a rate is not valid.
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

  // fromEntries makes own properties. A "__proto__" key then cannot change the prototype.
  return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * Validates the rules. Sampling applies `remoteMaxRate` when it reads them.
 * @param value Parsed header value.
 * @param maxRate Highest rate that a remote rule can set.
 * @returns The rules and their TTL.
 * @throws RuleError when a field is not valid.
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

  return { rules, ttlMs };
}

/**
 * Validates sampling rules from the server. A rule that is not valid rejects all the rules.
 * @param raw Header text, or a parsed object from a custom transport or the bus.
 * @param diagnostics Diagnostics reporter.
 * @returns The rules and their TTL, or null if they are not valid.
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
 * Puts rules in force in the slot of the runtime. It makes the overlay for the first rules.
 * @param slot Slot of the runtime.
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
}

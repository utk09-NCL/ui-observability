// src/core/rotation.ts
//
// Changes the security context. The runtime loads this module on the first
// rotateSecurityContext(), because an app rotates rarely and the main graph shouldn't carry it.

import { FLUSH_TIMEOUT_MAX_MS, FLUSH_TIMEOUT_MS, ROUTING_KEYS, ROUTING_RESET } from "../constants";
import type { LogBatch } from "../models/batch";
import type {
  ObservabilityConfig,
  ResolvedConfig,
  RoutingOptions,
  SecurityContextRotationOptions,
  SecurityContextUpdate,
} from "../models/config";
import type { LogRecord } from "../models/log-record";
import { isObject } from "../utils/guards";
import { newId } from "../utils/identity";
import { applyResolvedConfig, resolveConfig, resolveDestination, resolveEndpoint } from "./config";
import type { Diagnostics } from "./diagnostics";
import type { ObservabilityRuntime } from "./runtime";
import type { Sender } from "./sender";
import { clearStored, keepStored, type StoreAccess } from "../storage/stored-context";

/** What to do with the old context's records. */
type PendingRule = NonNullable<SecurityContextRotationOptions["pending"]>;

/** The rules a rotation accepts. */
const PENDING_RULES: readonly string[] = ["discard", "flush", "retain", "carry"];

/** Stands in for the current value when a check resolves a URL, so a refused URL returns it. */
const REFUSED = Symbol("refused");

/**
 * The runtime's private state that a rotation changes. The runtime's fields stay private, and
 * the rotation can only make these changes.
 */
export interface RotationHost {
  /** The runtime, for its config, diagnostics and the state that other calls change too. */
  runtime: ObservabilityRuntime;
  /** A reporter that nobody reads, for a check that repeats a resolve the app already saw. */
  quiet: Diagnostics;
  /** Waits for a delivery stack load in progress. */
  senderLoaded(): Promise<void>;
  /**
   * Removes the routing settings in a console-only runtime.
   * @param input The settings of the next context.
   * @returns The settings the runtime accepts.
   */
  allowed(input: Partial<ObservabilityConfig>): Partial<ObservabilityConfig>;
  /** Stops delivery after a rejected rotation. */
  closeDelivery(): Promise<void>;
  /** Sends the old context's open points, and ends its trace and journey. */
  closeContext(): void;
  /**
   * Takes the old context's held records and its sender, so nothing new goes to them.
   * @returns The records, the sender, and true if a failed rotation had closed the context.
   */
  /** Returns what opening the store needs, for a rotation with no old sender. */
  storeAccess(): StoreAccess;
  takeOld(): {
    held: LogRecord[];
    sender: Sender | undefined;
    closed: boolean;
    carried: LogBatch[];
  };
  /**
   * Reports records that belong to neither context.
   * @param records The records.
   */
  drop(records: LogRecord[]): void;
  /** Starts a new identity epoch, without the old identity's remote rules. */
  advanceIdentity(): void;
  /** Opens delivery again and loads the new context's sender. */
  openDelivery(): Promise<void>;
  /**
   * Lets records through again, unless a later rotation waits.
   * @param seq Number of this rotation call.
   */
  endRotation(seq: number): void;
  /**
   * Routes one carried record.
   * @param record The record.
   */
  route(record: LogRecord): void;
  /**
   * Stores the carried batches again under the new context.
   * @param stored The old context's stored batches.
   */
  adopt(stored: LogBatch[]): Promise<void>;
}

/** A checked rotation, ready to apply. */
interface RotationPlan {
  /** The config of the next context. */
  next: ResolvedConfig;
  /** The next context's ambient attributes, or undefined to clear them. */
  context: Record<string, unknown> | undefined;
  /** What to do with the old context's records. */
  pending: PendingRule;
  /** Maximum wait for an old-context flush, in milliseconds. */
  timeoutMs: number;
  /** The old context's id. */
  previous: string;
}

/**
 * Returns the routing keys that the next config doesn't hold as the rotation gave them. A URL
 * goes through the same check as in configure(), so the endpoint rules live in config.ts only.
 * A warning, for example a pair of settings that does nothing, isn't such a key.
 * @param input The rotation's routing settings.
 * @param next The resolved config of the next context.
 * @param quiet A reporter that nobody reads, because the real resolve reported every fault.
 * @returns The keys whose value couldn't be applied.
 */
function unapplied(
  input: Partial<ObservabilityConfig>,
  next: ResolvedConfig,
  quiet: Diagnostics,
): string[] {
  return ROUTING_KEYS.filter((key) => {
    const given: unknown = input[key];
    const applied: unknown = next[key];

    // An undefined key resets to its default.
    if (given === undefined) {
      return false;
    }

    // A refused URL gives back the marker, and an accepted one its stored form.
    if (key === "endpoint") {
      return resolveEndpoint(given, REFUSED, quiet) !== applied;
    }

    if (key === "metricsEndpoint" || key === "tracesEndpoint") {
      return resolveDestination(key, given, REFUSED, quiet) !== applied;
    }

    // null removes a hook or the headers.
    return given === null ? applied !== undefined : applied !== given;
  });
}

/**
 * Copies the routing settings of a rotation update. Each other key is reported and left out,
 * so a rotation can't remove redact or change a capture setting.
 * @param routing The update's routing settings.
 * @param runtime The runtime that reports a key it ignores.
 * @returns The reset routing settings with the update's values on top.
 */
function routingOf(
  routing: RoutingOptions,
  runtime: ObservabilityRuntime,
): Partial<ObservabilityConfig> {
  const copy: Partial<ObservabilityConfig> = { ...ROUTING_RESET };

  for (const key of Object.keys(routing)) {
    if ((ROUTING_KEYS as readonly string[]).includes(key)) {
      const value: unknown = Reflect.get(routing, key);
      Object.assign(copy, { [key]: value });
    } else {
      runtime.diagnostics.report(
        "config.invalid",
        `rotateSecurityContext() ignores routing.${key}. A rotation changes only the routing settings.`,
      );
    }
  }

  return copy;
}

/**
 * Checks whether the rotation options are usable.
 * @param update New identity, routing settings and attributes.
 * @param pending What to do with the old records.
 * @param timeoutMs Maximum wait for the old records to flush.
 * @returns True if the call can go ahead.
 */
function validOptions(update: SecurityContextUpdate, pending: string, timeoutMs: number): boolean {
  return (
    isObject(update) &&
    isObject(update.routing) &&
    // A string would give one attribute for each character.
    isObject(update.context ?? {}) &&
    PENDING_RULES.includes(pending) &&
    Number.isFinite(timeoutMs) &&
    timeoutMs >= 0 &&
    timeoutMs <= FLUSH_TIMEOUT_MAX_MS &&
    (update.id === undefined || (typeof update.id === "string" && update.id.length > 0))
  );
}

/**
 * Checks a rotation's arguments and builds the next config. Nothing changes before it returns.
 * @param host The runtime's rotation operations.
 * @param update New identity, routing settings and attributes.
 * @param options What to do with the old records, and the flush deadline.
 * @returns The checked rotation. It rejects for a setting it can't apply.
 */
async function planRotation(
  host: RotationHost,
  update: SecurityContextUpdate,
  options: SecurityContextRotationOptions,
): Promise<RotationPlan> {
  const { runtime } = host;
  // Wait for a delivery stack load first. A rejection then closes the sender that the load
  // built, and no late sender can drain the old batches afterwards.
  await host.senderLoaded();
  const pending = options.pending ?? "discard";
  const timeoutMs = options.timeoutMs ?? FLUSH_TIMEOUT_MS;

  if (!validOptions(update, pending, timeoutMs)) {
    throw new Error("Invalid security-context rotation options.");
  }

  const previous = runtime.config.securityContext.id;
  const nextId = update.id ?? newId(runtime.diagnostics);

  if (nextId === previous) {
    throw new Error("A rotation requires a different security-context id.");
  }

  const input = host.allowed({
    ...routingOf(update.routing, runtime),
    securityContext: { id: nextId },
  });
  // The base has no old routing values, so an invalid new value can't fall back to an old one.
  const next = resolveConfig(input, runtime.diagnostics, { ...runtime.config, ...ROUTING_RESET });

  if (unapplied(input, next, host.quiet).length > 0) {
    throw new Error("Invalid routing settings for the next security context.");
  }

  // Copy the context now, so a throwing getter rejects before the old sender stops.
  const context = update.context ? Object.fromEntries(Object.entries(update.context)) : undefined;

  return { next, context, pending, timeoutMs, previous };
}

/**
 * Lists the records that a rotation loses when shutdown() stops it right after the retire.
 * @param rule The rotation's rule for the old records.
 * @param held The records that waited in the runtime.
 * @param live The held records and the old sender's records from memory.
 * @param stored The batches that the retire took from storage.
 * @returns The records that nothing keeps now.
 */
function stoppedLoss(
  rule: PendingRule,
  held: LogRecord[],
  live: LogRecord[],
  stored: readonly LogBatch[],
): LogRecord[] {
  // retain stored the sender's records, but the held ones wait for keepStored().
  if (rule === "retain") {
    return held;
  }

  // carry leaves the stored batches in storage, and routes the live records only later.
  if (rule === "carry") {
    return live;
  }

  // discard and flush removed the stored batches with the retire.
  return [...live, ...stored.flatMap((batch) => batch.records)];
}

/**
 * Checks the new settings, stops the old delivery and starts the new context. A rejection
 * closes the old context's delivery, because the app asked to leave it.
 * @param host The runtime's rotation operations.
 * @param update New identity, routing settings and attributes.
 * @param options What to do with the old records, and the flush deadline.
 * @param seq Number of this call.
 * @returns Promise that resolves when the context change completes.
 */
export async function rotateContext(
  host: RotationHost,
  update: SecurityContextUpdate,
  options: SecurityContextRotationOptions,
  seq: number,
): Promise<void> {
  const { runtime } = host;
  const { config } = runtime;
  let plan: RotationPlan;

  try {
    plan = await planRotation(host, update, options);
  } catch (error) {
    await host.closeDelivery();
    throw error;
  }

  // shutdown() ran while the plan waited for the sender load. A discard already stopped that
  // sender, so a retire now would drain and remove the old context's stored batches.
  if (runtime.isDestroyed()) {
    throw new Error("The runtime has stopped.");
  }

  const { next, context, pending, timeoutMs, previous } = plan;

  // The plan's base has no endpoints, so remove the old endpoints from the ignore list here.
  // If they stayed, network capture would ignore calls to the old destination.
  const oldUrls = new Set<unknown>([
    config.endpoint,
    config.metricsEndpoint,
    config.tracesEndpoint,
  ]);
  const newUrls = new Set<unknown>([next.endpoint, next.metricsEndpoint, next.tracesEndpoint]);
  next.capture.ignoreUrls = next.capture.ignoreUrls.filter(
    (url) => !oldUrls.has(url) || newUrls.has(url),
  );

  host.closeContext();
  const { held, sender: old, closed, carried } = host.takeOld();
  // After a failed rotation, the parked sender holds the closed context's records. They must
  // never go out with the old settings, so "flush" removes them as "discard" does.
  const rule = closed && pending === "flush" ? "discard" : pending;
  const retired = (await old?.retire(rule, timeoutMs, previous)) ?? { buffered: [], stored: [] };
  const live = [...held, ...retired.buffered];
  // A carry during a pause left stored batches that no sender adopted. This rule covers them too.
  const stored = [...carried, ...retired.stored];

  // shutdown() ran during the retire, so the rotation didn't happen and mustn't resolve. What the
  // retire took out of memory or storage has no owner now. The carried batches go back, so the
  // shutdown's clearStorage can still find them.
  if (runtime.isDestroyed()) {
    host.drop(stoppedLoss(rule, held, live, retired.stored));
    await host.adopt(carried);
    throw new Error("The runtime has stopped.");
  }

  if (rule !== "retain" && rule !== "carry") {
    host.drop([...live, ...stored.flatMap((batch) => batch.records)]);
  }

  // With no old sender, nothing else removes the old context's stored batches, and a logout
  // must. Deleting is the one storage access that a pause or a consent flow allows.
  const { diagnostics } = runtime;
  if (!old && (rule === "discard" || rule === "flush")) {
    const ids = carried.map((batch) => batch.id);
    await diagnostics.guardAsync(
      "storage.degraded",
      "The library could not remove the stored batches of the old context.",
      () => clearStored(host.storeAccess(), "context", ids),
    );
  }

  // Retain keeps what waited in memory under the old context, as a sender does with its own.
  if (rule === "retain" && (held.length > 0 || carried.length > 0)) {
    await diagnostics.guardAsync(
      "storage.degraded",
      "The library could not store the records of the old context.",
      () => keepStored(host.storeAccess(), held, carried),
    );
  }

  // shutdown() ran during the storage step. Applying the new context now would make its
  // clearStorage remove the wrong context's batches. Nothing is lost here: discard and flush
  // reported their records above, and retain stored its records under the old context.
  if (runtime.isDestroyed()) {
    throw new Error("The runtime has stopped.");
  }

  // Keep a lock change the app made during the rotation.
  next.lockConfiguration = config.lockConfiguration;
  // Replace all routing settings together. Don't keep old credentials or signal endpoints.
  applyResolvedConfig(config, next);
  host.advanceIdentity();
  runtime.context.clear();

  if (context) {
    runtime.context.merge(context);
  }

  runtime.breadcrumbs.clear();
  runtime.newSession();
  runtime.builder.invalidateResource();
  await host.openDelivery();

  // shutdown() ran during the new sender's load, and that load stopped itself. Carry's live
  // records aren't routed yet, so they're lost. The other rules reported or stored theirs above.
  if (runtime.isDestroyed()) {
    if (rule === "carry") {
      host.drop(live);
      // The id is already the new one, so only these ids let a clearStorage find the old batches.
      await host.adopt(stored);
    }
    throw new Error("The runtime has stopped.");
  }

  // New calls go to the new sender from here, so a long carry drops no logger call and the
  // report below can produce a record.
  host.endRotation(seq);

  if (pending === "carry") {
    for (const record of live) {
      host.route(record);
    }

    // The live buffer doesn't take the stored backlog, which would exceed the buffer budget.
    await host.adopt(stored);
  }

  runtime.diagnostics.report("security.rotated", "The runtime rotated its security context.", {
    pending,
  });
}

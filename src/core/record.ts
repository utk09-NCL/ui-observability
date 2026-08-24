// src/core/record.ts
//
// Where the context store, the journey, the ambient trace, the sequence and the
// platform facts become one record.
//
// The hottest path in the library, so the order of operations is the design:
//
//   1. The level gate runs before anything is allocated. A `debug()` under a
//      minimum of INFO costs one lookup and one compare.
//   2. The resource block is built once and cached. It cannot change between
//      two records from one context, and it is the largest part of a record.
//   3. Attributes are measured by the same walk that sanitizes them. Any other
//      way serializes every record twice, once to size and once to send.
//
// Building a record must never throw into the caller: `logger.info()` often
// sits in a consumer's own catch block, where an exception out of it turns a
// logging fault into an application fault.

import {
  ATTR_APP_NAMESPACE,
  ATTR_ATTRIBUTES_BYTES,
  ATTR_ATTRIBUTES_DROPPED,
  ATTR_JOURNEY_ID,
  ATTR_JOURNEY_NAME,
  ATTR_JOURNEY_PARENT_ID,
  ATTR_LOG_SEQ,
  ATTR_LOG_TYPE,
  ATTR_PAGE_URL,
  ATTR_SANITIZE_FAILED,
  LEVEL_ORDER,
  RESOURCE_BROWSER_USER_AGENT,
  RESOURCE_CONTEXT_ID,
  RESOURCE_DEPLOYMENT_ENVIRONMENT,
  RESOURCE_HOST_PLATFORM,
  RESOURCE_OPENFIN_NAME,
  RESOURCE_OPENFIN_UUID,
  RESOURCE_SERVICE_NAME,
  RESOURCE_SERVICE_VERSION,
  RESOURCE_SESSION_ID,
  RESOURCE_TAB_ID,
  RESOURCE_TELEMETRY_SDK_LANGUAGE,
  RESOURCE_TELEMETRY_SDK_NAME,
  RESOURCE_TELEMETRY_SDK_VERSION,
  SEVERITY_NUMBER,
  TELEMETRY_SDK_LANGUAGE,
  TELEMETRY_SDK_NAME,
  TELEMETRY_SDK_VERSION,
} from "../constants";
import type { ResolvedConfig } from "../models/config";
import {
  isLogRecord,
  type LogLevel,
  type LogRecord,
  type LogType,
  nowUnixNano,
} from "../models/log-record";
import type { Identity } from "../utils/identity";
import { currentUrl, type PlatformMetadata } from "../utils/platform";
import { sanitizeWithSize, truncate } from "../utils/sanitize";
import type { Sequence } from "../utils/sequence";
import type { TraceEngine } from "../utils/tracing";
import type { ContextStore } from "./context";
import type { Diagnostics } from "./diagnostics";
import type { JourneyEngine } from "./journey";

/**
 * Everything the builder needs, injected rather than reached for. All of it is
 * instance-owned, so two runtimes in one document share no sequence, journey or
 * context.
 */
export interface RecordBuilderDeps {
  /**
   * The live config object, not a copy. A reconfigure mutates it in place, so a
   * copy would keep serving the settings in force at construction.
   */
  config: ResolvedConfig;
  /** Where every fault on this path is reported. */
  diagnostics: Diagnostics;
  /** The pairs that belong to every record from this runtime. */
  context: ContextStore;
  /** Consulted per record, because a journey can start or end between two of them. */
  journey: JourneyEngine;
  /** Supplies the trace and span this record joins. */
  tracing: TraceEngine;
  /** Numbers records within this context, which is the only reliable ordering there is. */
  sequence: Sequence;
  /** The session, tab and context ids, fixed for the life of this realm. */
  identity: Identity;
  /** What kind of host this is, detected once at startup. */
  platform: PlatformMetadata;
}

/** One call into the public logger, after the logger has merged its own scoped context. */
export interface BuildInput {
  /** The level this was logged at, which the level gate compares against the configured minimum. */
  level: LogLevel;
  /** What kind of thing this describes. Sampling rates are keyed by it. */
  type: LogType;
  /** The message. Truncated to the configured body limit, never dropped. */
  body: string;
  /** Which logger emitted this, and therefore which part of a composed application. */
  namespace: string;
  /** already-merged scoped context from the logger instance */
  scoped?: Record<string, unknown>;
  /** The per-call payload, the only part of a record a single call site controls. */
  payload?: Record<string, unknown>;
}

/**
 * Restate a sanitized value as an attribute bag. `sanitizeWithSize` returns
 * `unknown`, but maps a plain object to a plain object and every call here
 * passes one. The cast sits in one place rather than at four call sites.
 *
 * A configured `maxDepth` of zero breaks the assumption: the object comes back
 * as a marker string and spreading a string yields its characters. That is a
 * nonsensical configuration, and it costs one strange record, not a throw.
 */
function asAttributes(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Turns one logger call into one record, or into nothing at all. */
export class RecordBuilder {
  /**
   * The resource block, built on first use. Null means "not built yet", so
   * invalidation is one assignment and the next record pays the rebuild.
   */
  private resourceCache: Record<string, unknown> | null = null;

  /** @param deps Everything this builder reads. See {@link RecordBuilderDeps}. */
  constructor(private readonly deps: RecordBuilderDeps) {}

  /**
   * Drop the cached resource block. Called when identity or config changes, the
   * only two things it is built from.
   */
  invalidateResource(): void {
    this.resourceCache = null;
  }

  /**
   * Whether a record at this level would be kept. Public so the logger can skip
   * building an input object at all. Levels are numbered, so the test is a
   * lookup and a compare.
   *
   * @param level The level of the call being considered.
   */
  isEnabled(level: LogLevel): boolean {
    const { config } = this.deps;
    if (!config.enabled) {
      return false;
    }
    return LEVEL_ORDER[level] >= LEVEL_ORDER[config.minLevel];
  }

  /**
   * Build one record, or return null when it should not exist.
   *
   * @param input One logger call.
   * @returns The record, or null when the level gate or the redact hook
   * rejected it. Every path returning null counts a diagnostic, so the drop is
   * visible in a snapshot.
   */
  build(input: BuildInput): LogRecord | null {
    const { config, diagnostics, tracing, journey, sequence } = this.deps;

    if (!this.isEnabled(input.level)) {
      diagnostics.count("record.dropped_by_level");
      return null;
    }

    const limits = config.limits;
    const traceCtx = tracing.resolve();
    const activeJourney = journey.current();
    // Read once: the size-budget path below rebuilds a minimal attribute bag,
    // and must not draw a second sequence number or re-read the URL after a
    // route change.
    const seq = sequence.next();
    const pageUrl = currentUrl();

    let attributes: Record<string, unknown>;
    let bytes = 0;
    try {
      const fromContext = sanitizeWithSize(this.deps.context.getAll(), limits);
      const fromScope = sanitizeWithSize(input.scoped ?? {}, limits);
      const fromPayload = sanitizeWithSize(input.payload ?? {}, limits);
      bytes = fromContext.bytes + fromScope.bytes + fromPayload.bytes;
      // Widest scope first, so a per-call payload wins over scoped context and
      // scoped context wins over the runtime-wide store.
      attributes = {
        ...asAttributes(fromContext.value),
        ...asAttributes(fromScope.value),
        ...asAttributes(fromPayload.value),
      };
    } catch (error) {
      // Sanitizing cannot throw; reading the attributes out of an injected
      // dependency, before sanitizing sees them, can. That costs this record's
      // attributes and nothing more.
      diagnostics.report(
        "record.sanitize_failed",
        "attributes could not be sanitized",
        undefined,
        error,
      );
      attributes = { [ATTR_SANITIZE_FAILED]: true };
    }

    // Reserved keys are written after the spread, so a payload carrying its own
    // `journey.id` cannot silently rewrite the id everything correlates on.
    attributes[ATTR_LOG_TYPE] = input.type;
    attributes[ATTR_LOG_SEQ] = seq;
    attributes[ATTR_APP_NAMESPACE] = input.namespace;
    // The document URL, not `url.full`. That name belongs to the request a
    // record is about and the network capture fills it in; stamping the page
    // URL over it rewrites every captured request to the page that made it.
    attributes[ATTR_PAGE_URL] = pageUrl;
    if (activeJourney) {
      attributes[ATTR_JOURNEY_ID] = activeJourney.id;
      attributes[ATTR_JOURNEY_NAME] = activeJourney.name;
      if (activeJourney.parentId !== undefined) {
        attributes[ATTR_JOURNEY_PARENT_ID] = activeJourney.parentId;
      }
    }

    const body = truncate(input.body, limits.maxBodyChars);
    if (body !== input.body) {
      diagnostics.count("record.truncated");
    }

    let record: LogRecord = {
      timeUnixNano: nowUnixNano(),
      traceId: traceCtx.traceId,
      spanId: traceCtx.spanId,
      traceFlags: traceCtx.traceFlags,
      severityNumber: SEVERITY_NUMBER[input.level],
      severityText: input.level,
      body,
      attributes,
      resource: this.resource(),
    };

    const redact = config.redact;
    if (redact) {
      const redacted = diagnostics.guard("record.sanitize_failed", "redact hook threw", () =>
        redact(record),
      );
      if (redacted === null) {
        diagnostics.count("record.dropped_by_redact");
        return null;
      }
      // Undefined covers both a hook that threw and one that forgot to return,
      // and the same object back means the hook edited in place. Neither needs
      // anything done to it.
      if (redacted !== undefined && redacted !== record) {
        if (isLogRecord(redacted)) {
          // The hook's output has not been sanitized and the byte total no
          // longer describes it. An unserializable value here reaches the
          // transport, which then discards the whole batch. Only consumers
          // whose hook returns a new record pay for the second walk.
          const remeasured = sanitizeWithSize(redacted.attributes, limits);
          record = { ...redacted, attributes: asAttributes(remeasured.value) };
          bytes = remeasured.bytes;
        } else {
          // A hook written in plain JavaScript can return a string or a
          // half-built object. Keeping the original loses the redaction, hence
          // a report rather than a count; shipping it loses the whole batch.
          diagnostics.report(
            "record.sanitize_failed",
            "redact hook returned something that is not a record, keeping the original",
          );
        }
      }
    }

    // Last defence against one record pushing a batch past the server's size
    // limit. The reserved keys above are outside this total on purpose: a
    // fixed small cost, and counting them would mean measuring twice.
    if (bytes > limits.maxRecordBytes) {
      diagnostics.report(
        "record.truncated",
        "attributes exceeded the size budget and were dropped",
        { bytes, body: record.body },
      );
      // Keep what makes the record findable. Dropping the journey would leave
      // the record most worth looking up with nothing to look it up by. Trace
      // and span ids are fields on the record, so they survive anyway.
      const kept: Record<string, unknown> = {
        [ATTR_LOG_TYPE]: input.type,
        [ATTR_LOG_SEQ]: seq,
        [ATTR_APP_NAMESPACE]: input.namespace,
        [ATTR_PAGE_URL]: pageUrl,
        [ATTR_ATTRIBUTES_DROPPED]: true,
        [ATTR_ATTRIBUTES_BYTES]: bytes,
      };
      if (activeJourney) {
        kept[ATTR_JOURNEY_ID] = activeJourney.id;
        kept[ATTR_JOURNEY_NAME] = activeJourney.name;
      }
      record.attributes = kept;
    }

    return record;
  }

  /**
   * The fields identical for every record from this context, built once. A
   * serializer hoists this out and sends one copy per batch.
   *
   * @returns The cached block, rebuilt on the first call after an
   * invalidation. The same object goes onto every record, which holds only
   * because nothing downstream mutates a resource block.
   */
  private resource(): Record<string, unknown> {
    if (this.resourceCache) {
      return this.resourceCache;
    }
    const { config, identity, platform } = this.deps;

    this.resourceCache = {
      [RESOURCE_SERVICE_NAME]: config.serviceName,
      [RESOURCE_SERVICE_VERSION]: config.serviceVersion,
      [RESOURCE_DEPLOYMENT_ENVIRONMENT]: config.environment,
      [RESOURCE_TELEMETRY_SDK_NAME]: TELEMETRY_SDK_NAME,
      [RESOURCE_TELEMETRY_SDK_VERSION]: TELEMETRY_SDK_VERSION,
      [RESOURCE_TELEMETRY_SDK_LANGUAGE]: TELEMETRY_SDK_LANGUAGE,
      [RESOURCE_HOST_PLATFORM]: platform.platform,
      [RESOURCE_SESSION_ID]: identity.sessionId,
      [RESOURCE_TAB_ID]: identity.tabId,
      [RESOURCE_CONTEXT_ID]: identity.contextId,
      [RESOURCE_BROWSER_USER_AGENT]: platform.userAgent,
      // Spread rather than assigned, so a browser's resource block does not
      // carry two keys holding undefined into every batch it sends.
      ...(platform.openfinUuid === undefined
        ? {}
        : { [RESOURCE_OPENFIN_UUID]: platform.openfinUuid }),
      ...(platform.openfinName === undefined
        ? {}
        : { [RESOURCE_OPENFIN_NAME]: platform.openfinName }),
    };
    return this.resourceCache;
  }
}

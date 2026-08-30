// src/core/record.ts
//
// Assembles structured log records from ambient context, journey metadata, trace context, and resource attributes.
// Never throws into the caller. The resource block is cached, so anything that
// changes it must call invalidateResource.

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

/** Injected dependencies required by RecordBuilder. */
export interface RecordBuilderDeps {
  /** Active configuration object reference. */
  config: ResolvedConfig;
  /** Diagnostics reporter instance. */
  diagnostics: Diagnostics;
  /** Ambient context store. */
  context: ContextStore;
  /** Active journey engine. */
  journey: JourneyEngine;
  /** Distributed tracing engine. */
  tracing: TraceEngine;
  /** Monotonic sequence counter. */
  sequence: Sequence;
  /** Context, session, and tab identity context. */
  identity: Identity;
  /** Detected host platform metadata. */
  platform: PlatformMetadata;
}

/** Input parameters for constructing a single log record. */
export interface BuildInput {
  /** Severity level of the log entry. */
  level: LogLevel;
  /** Telemetry type classification. */
  type: LogType;
  /** Primary log message body. */
  body: string;
  /** Originating application namespace. */
  namespace: string;
  /** Pre-merged scoped context from logger instance. */
  scoped?: Record<string, unknown>;
  /** Call-site payload attributes. */
  payload?: Record<string, unknown>;
}

/**
 * Casts a sanitized plain object value to an attribute record.
 * @param value Sanitized object value.
 * @returns Attribute record.
 */
function asAttributes(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Builds validated and sanitized LogRecord instances from logger inputs. */
export class RecordBuilder {
  /** Cached resource attributes block. */
  private resourceCache: Record<string, unknown> | null = null;

  /**
   * @param deps Injected builder dependencies.
   */
  constructor(private readonly deps: RecordBuilderDeps) {}

  /** Invalidates cached resource attributes to force recomputation on next build. */
  invalidateResource(): void {
    this.resourceCache = null;
  }

  /**
   * Evaluates whether a log level clears minimum severity thresholds.
   * @param level Target log severity level.
   * @returns True if the level is enabled.
   */
  isEnabled(level: LogLevel): boolean {
    const { config } = this.deps;
    if (!config.enabled) {
      return false;
    }
    return LEVEL_ORDER[level] >= LEVEL_ORDER[config.minLevel];
  }

  /**
   * Builds a structured LogRecord from input attributes, applying sanitization and size budgeting.
   * @param input Logger call input parameters.
   * @returns Completed LogRecord or null if dropped by severity or redaction.
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
    const seq = sequence.next();
    const pageUrl = currentUrl();

    let attributes: Record<string, unknown>;
    let bytes = 0;
    try {
      const fromContext = sanitizeWithSize(this.deps.context.getAll(), limits);
      const fromScope = sanitizeWithSize(input.scoped ?? {}, limits);
      const fromPayload = sanitizeWithSize(input.payload ?? {}, limits);
      bytes = fromContext.bytes + fromScope.bytes + fromPayload.bytes;

      // Merges attributes in increasing order of precedence: context, scope, payload.
      attributes = {
        ...asAttributes(fromContext.value),
        ...asAttributes(fromScope.value),
        ...asAttributes(fromPayload.value),
      };
    } catch (error) {
      diagnostics.report(
        "record.sanitize_failed",
        "attributes could not be sanitized",
        undefined,
        error,
      );
      attributes = { [ATTR_SANITIZE_FAILED]: true };
    }

    // Injects reserved telemetry attributes after payload merge to prevent
    // overwrites. Merged earlier, a payload key named journey.id rewrites the id
    // records correlate on.
    attributes[ATTR_LOG_TYPE] = input.type;
    attributes[ATTR_LOG_SEQ] = seq;
    attributes[ATTR_APP_NAMESPACE] = input.namespace;
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

      if (redacted !== undefined && redacted !== record) {
        if (isLogRecord(redacted)) {
          // Re-sanitizes mutated record from redact hook. Hook output is consumer
          // code: a cycle, a hostile getter or a BigInt throws at serialization
          // and loses the batch.
          const remeasured = sanitizeWithSize(redacted.attributes, limits);
          record = { ...redacted, attributes: asAttributes(remeasured.value) };
          bytes = remeasured.bytes;
        } else {
          diagnostics.report(
            "record.sanitize_failed",
            "redact hook returned something that is not a record, keeping the original",
          );
        }
      }
    }

    // Truncates attributes when size exceeds maxRecordBytes while retaining indexing
    // keys. Without journey.id and trace_id the record cannot be looked up.
    if (bytes > limits.maxRecordBytes) {
      diagnostics.report(
        "record.truncated",
        "attributes exceeded the size budget and were dropped",
        { bytes, body: record.body },
      );

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
   * Computes or returns cached resource metadata for this runtime context.
   * @returns Resource attributes record.
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
      // Omits undefined OpenFin properties from resource attributes.
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

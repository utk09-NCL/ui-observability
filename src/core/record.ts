// src/core/record.ts
//
// This module builds structured log records from ambient context, journey data, trace
// context and resource attributes. It never throws to the caller.
// The builder caches the resource block. Call invalidateResource after a change to its inputs.

import {
  ATTR_APP_NAMESPACE,
  ATTR_ATTRIBUTES_BYTES,
  ATTR_ATTRIBUTES_DROPPED,
  ATTR_BREADCRUMBS,
  ATTR_ERROR_DATA,
  ATTR_JOURNEY_ID,
  ATTR_JOURNEY_NAME,
  ATTR_JOURNEY_PARENT_ID,
  ATTR_LOG_SEQ,
  ATTR_LOG_TYPE,
  ATTR_PAGE_URL,
  ATTR_SANITIZE_FAILED,
  LEVEL_BYPASS_TYPES,
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
  isLogLevel,
  isLogRecord,
  type LogLevel,
  type LogRecord,
  type LogType,
  nowUnixNano,
} from "../models/log-record";
import type { Identity } from "../utils/identity";
import { currentUrl, type PlatformMetadata, stripUrlQuery } from "../utils/platform";
import { type SanitizeLimits, sanitizeWithSize, truncate } from "../utils/sanitize";
import type { Sequence } from "../utils/sequence";
import type { TraceEngine } from "../utils/tracing";
import type { ContextStore } from "./context";
import type { Diagnostics } from "./diagnostics";
import type { JourneyEngine } from "./journey";
import type { RemoteSlot } from "./remote-sampling";
import { shouldSampleInput } from "./sampling";

/** Prefix of the error fields. An oversized error record keeps them. */
const ERROR_ATTR_PREFIX = "error.";

/** Index keys that an oversized record keeps in the form that redact gave them. */
const REDACTABLE_INDEX_KEYS = [ATTR_PAGE_URL, ATTR_JOURNEY_ID, ATTR_JOURNEY_NAME] as const;

/** Injected dependencies required by RecordBuilder. */
export interface RecordBuilderDeps {
  /** Active configuration object reference. */
  config: ResolvedConfig;
  /** Per-record size caps. */
  limits: RecordLimits;
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
  /** Context, session and tab identity. */
  identity: Identity;
  /** Detected host platform metadata. */
  platform: PlatformMetadata;
  /** Slot of the sampling rules from the ingest server. */
  remote: RemoteSlot;
}

/** Size limits for each record. The builder applies them after sanitize and after redact. */
export interface RecordLimits extends SanitizeLimits {
  /** Max record body length, in characters. */
  maxBodyChars: number;
  /** Max total attribute bytes per record. */
  maxRecordBytes: number;
}

/**
 * Reason a record was not built. "malformed" means the redact hook broke the record shape
 * or set an unknown severityText.
 */
export type DropReason = "level" | "sampling" | "redact" | "malformed";

/** Outcome of one build call. */
export interface BuildResult {
  /** Completed record, or null when the builder drops it. */
  record: LogRecord | null;
  /** Reason for the drop. It is absent when the builder built a record. */
  dropped?: DropReason;
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

  /** Clears the cached resource attributes. The next build computes them again. */
  invalidateResource(): void {
    this.resourceCache = null;
  }

  /**
   * Checks if logging is on and the level is at or above minLevel.
   * minLevel does not apply to an action or a metric.
   * @param level Target log severity level.
   * @param type Record type. Without it, the check applies minLevel.
   * @returns True if the library builds a record of this level and type.
   */
  isEnabled(level: LogLevel, type?: LogType): boolean {
    const { config } = this.deps;
    if (!config.enabled) {
      return false;
    }

    if (type !== undefined && LEVEL_BYPASS_TYPES.includes(type)) {
      return true;
    }

    // A remote rule can lower minLevel during an incident.
    const minLevel = this.deps.remote.sampling?.minLevel() ?? config.minLevel;

    return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
  }

  /**
   * Builds a structured LogRecord from the input. It sanitizes attributes and applies size limits.
   * @param input Logger call input parameters.
   * @returns The record, or null with the reason of the drop.
   */
  build(input: BuildInput): BuildResult {
    const { config, diagnostics, tracing, journey, sequence, limits, remote } = this.deps;

    if (!this.isEnabled(input.level, input.type)) {
      diagnostics.count("record.dropped_by_level");
      return { record: null, dropped: "level" };
    }

    const traceCtx = tracing.resolve();
    const activeJourney = journey.current();

    // Sample before the attribute walk below. Do not sanitize, redact or build the
    // resource block for a record that the runtime does not send.
    const sampled = shouldSampleInput(
      {
        level: input.level,
        type: input.type,
        namespace: input.namespace,
        journeyId: activeJourney?.id ?? "",
        traceId: traceCtx.traceId,
      },
      config,
      remote.sampling?.current() ?? null,
    );
    if (!sampled) {
      diagnostics.count("record.dropped_by_sampling");
      return { record: null, dropped: "sampling" };
    }

    const seq = sequence.next();
    // The query and fragment can contain tokens and user input. The path groups records.
    const url = currentUrl(diagnostics);
    const pageUrl = config.capture.fullUrls ? url : stripUrlQuery(url);

    let attributes: Record<string, unknown>;
    let bytes = 0;
    try {
      const fromContext = sanitizeWithSize(this.deps.context.getAll(), limits, diagnostics);
      const fromScope = sanitizeWithSize(input.scoped ?? {}, limits, diagnostics);
      const fromPayload = sanitizeWithSize(input.payload ?? {}, limits, diagnostics);
      bytes = fromContext.bytes + fromScope.bytes + fromPayload.bytes;

      // Merge in increasing precedence. Scope overrides context. Payload overrides scope.
      attributes = {
        ...asAttributes(fromContext.value),
        ...asAttributes(fromScope.value),
        ...asAttributes(fromPayload.value),
      };
    } catch (error) {
      diagnostics.report(
        "record.sanitize_failed",
        "The library could not sanitize the attributes.",
        undefined,
        error,
      );
      attributes = { [ATTR_SANITIZE_FAILED]: true };
    }

    // Set reserved attributes after the payload merge. If they merge first, a payload key
    // named journey.id replaces the ID that correlates the records.
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
      // A plain JavaScript hook can edit the record in place without a return value.
      let redacted: unknown;
      try {
        redacted = redact(record);
      } catch (error) {
        // Drop the record. A record that redact did not clean must not leave the page.
        diagnostics.report(
          "record.dropped_by_redact",
          "The redact hook threw an error. The library dropped the record.",
          undefined,
          error,
        );
        return { record: null, dropped: "redact" };
      }

      if (redacted === null) {
        diagnostics.count("record.dropped_by_redact");
        return { record: null, dropped: "redact" };
      }

      const candidate: unknown = redacted ?? record;

      if (!isLogRecord(candidate)) {
        // The hook changed the record in place. The library has no intact copy.
        if (candidate === record) {
          diagnostics.report(
            "record.dropped_malformed",
            "The redact hook changed the record to a shape that is not a record. The library dropped it.",
          );
          return { record: null, dropped: "malformed" };
        }

        // A plain JavaScript hook can return a string or a Promise. The record did not pass redact.
        diagnostics.report(
          "record.dropped_by_redact",
          "The redact hook returned a value that is not a record. The library dropped the record.",
        );
        return { record: null, dropped: "redact" };
      } else if (!isLogLevel(candidate.severityText)) {
        // An unknown level has no severity number. The serializer cannot map it.
        diagnostics.report(
          "record.dropped_malformed",
          "The redact hook set a severityText that is not a log level. The library dropped the record.",
        );
        return { record: null, dropped: "malformed" };
      } else {
        if (candidate !== record) {
          // Sanitize the record from the redact hook again. The hook is consumer code.
          // A cycle, a hostile getter or a BigInt throws at serialization. The transport
          // then loses the batch.
          const remeasured = sanitizeWithSize(candidate.attributes, limits, diagnostics);
          record = { ...candidate, attributes: asAttributes(remeasured.value) };
          bytes = remeasured.bytes;
        }

        // The hook can change severityText. Keep the number in step with the text.
        record.severityNumber = SEVERITY_NUMBER[record.severityText];
      }
    }

    // Drop the caller attributes when their size exceeds maxRecordBytes. Keep the index keys.
    // A search cannot find a record without journey.id and trace_id. Keep the error fields,
    // then the breadcrumbs if they fit. They tell why the record exists.
    if (bytes > limits.maxRecordBytes) {
      diagnostics.report(
        "record.truncated",
        "The attributes are larger than the size limit. The library dropped the caller attributes.",
        { bytes, body: record.body },
      );

      const kept: Record<string, unknown> = {
        [ATTR_LOG_TYPE]: input.type,
        [ATTR_LOG_SEQ]: seq,
        [ATTR_APP_NAMESPACE]: input.namespace,
        [ATTR_ATTRIBUTES_DROPPED]: true,
        [ATTR_ATTRIBUTES_BYTES]: bytes,
      };

      // Read these keys after redact. The hook can remove a token from page.url.
      for (const key of REDACTABLE_INDEX_KEYS) {
        if (key in record.attributes) {
          kept[key] = record.attributes[key];
        }
      }

      for (const [key, value] of Object.entries(record.attributes)) {
        if (key.startsWith(ERROR_ATTR_PREFIX)) {
          kept[key] = value;
        }
      }

      // error.data can be large. Drop it first, before the other error fields.
      let keptBytes = sanitizeWithSize(kept, limits, diagnostics).bytes;
      if (keptBytes > limits.maxRecordBytes && ATTR_ERROR_DATA in kept) {
        Reflect.deleteProperty(kept, ATTR_ERROR_DATA);
        keptBytes = sanitizeWithSize(kept, limits, diagnostics).bytes;
      }

      const breadcrumbs = record.attributes[ATTR_BREADCRUMBS];
      if (breadcrumbs !== undefined) {
        const crumbBytes = sanitizeWithSize(breadcrumbs, limits, diagnostics).bytes;
        if (keptBytes + crumbBytes <= limits.maxRecordBytes) {
          kept[ATTR_BREADCRUMBS] = breadcrumbs;
        }
      }

      record.attributes = kept;
    }

    return { record };
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

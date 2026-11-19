// src/models/health.ts
//
// Runtime state and delivery counts that getHealth() returns to the app.

import type { DeliveryStats } from "./stats";
import type { BusOptions, LoggerCacheOptions, SecurityContextOptions } from "./config";
import type { LogRecord } from "./log-record";
import type { StoragePersistence } from "./storage";

/** State of this SDK copy. A configured console-only runtime can report the status "ready". */
export interface ObservabilityHealth extends DeliveryStats {
  /** Version of this SDK copy. */
  sdkVersion: string;
  /** Version of a different SDK copy that owns the page runtime, or null. */
  owningSdkVersion: string | null;
  /**
   * Current runtime state.
   * - "unconfigured": no `configure()` call has worked yet. The runtime holds records in memory
   *   and sends nothing. A failed first call also leaves this state, with the issue
   *   "records.refused".
   * - "disabled": `enabled` is false. Captures and delivery are paused.
   * - "starting": the bus role and the delivery stack are loading.
   * - "ready": the runtime runs. A configured console-only runtime can be ready.
   * - "rotating": a security-context rotation is in progress.
   * - "degraded": an entry in `issues` names a fault.
   * - "stopped": `shutdown()` stopped the runtime.
   */
  status: "unconfigured" | "disabled" | "starting" | "ready" | "rotating" | "degraded" | "stopped";
  /** Delivery role of this context. */
  mode: "sender" | "forwarder" | "console-only";
  /** True if the local sender is ready, `enabled` is true and the runtime has not stopped. */
  senderReady: boolean;
  /** True if configure() cannot change the current settings. */
  configurationLocked: boolean;
  /** Codes for the current runtime or context failures. */
  issues: (
    | "runtime.version_mismatch"
    | "sender.unavailable"
    | "security.context_mismatch"
    | "security.rotation_failed"
    | "records.refused"
  )[];
  /** Logger cache capacity and the number of cached loggers. */
  loggerCache: LoggerCacheOptions & { size: number };
  /** Active delivery context id and isolation rule. */
  securityContext: SecurityContextOptions;
  /** State of the `storage.requestPersistent` request. */
  storagePersistence: StoragePersistence;
  /** The bus's source and capacity rules. */
  bus: Pick<
    BusOptions,
    "sourcePolicy" | "maxMessageBytes" | "maxRecordsPerMessage" | "maxMessagesPerSecond"
  >;
}

/** Library state for a support ticket. Every field is JSON-safe. */
export interface DebugBundle {
  /** When the bundle was created, as an ISO 8601 string. */
  createdAt: string;
  /** Version of this SDK copy. */
  sdkVersion: string;
  /** Health snapshot, as returned by getHealth(). */
  health: ObservabilityHealth;
  /** How many times each diagnostic code was reported since startup. */
  diagnostics: Record<string, number>;
  /** This context's resource attributes, for example service.name and session.id. */
  resource: Record<string, unknown>;
  /** Page URL, under the same rules as the page.url attribute. */
  pageUrl: string;
  /** Recent breadcrumbs, after the processors and redact have run on them. */
  breadcrumbs: unknown[];
  /** Records currently in the debug buffer. */
  debugBuffer: LogRecord[];
  /** Resolved config without headers. Endpoints lose their query. Functions show only a name. */
  config: Record<string, unknown>;
}

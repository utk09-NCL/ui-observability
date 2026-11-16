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
  /** Current runtime state. A configured console-only runtime can be ready. */
  status: "starting" | "ready" | "rotating" | "degraded" | "stopped";
  /** Delivery role of this context. */
  mode: "sender" | "forwarder" | "console-only";
  /** True if the local sender is ready and the runtime has not stopped. */
  senderReady: boolean;
  /** True if configure() cannot change the current settings. */
  configurationLocked: boolean;
  /** Codes for the current runtime or context failures. */
  issues: ("runtime.version_mismatch" | "sender.unavailable" | "security.context_mismatch")[];
  /** Logger cache capacity and the number of cached loggers. */
  loggerCache: LoggerCacheOptions & { size: number };
  /** Active delivery context id and isolation rule. */
  securityContext: SecurityContextOptions;
  /** State of the `persistence.requestPersistent` request. */
  storagePersistence: StoragePersistence;
  /** The bus's source, validation and capacity rules. */
  bus: Pick<
    BusOptions,
    | "sourcePolicy"
    | "validation"
    | "maxMessageBytes"
    | "maxRecordsPerMessage"
    | "maxMessagesPerSecond"
    | "maxTrackedSources"
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

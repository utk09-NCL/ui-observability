// src/models/health.ts
//
// Defines the runtime state and delivery counts that getHealth() gives to the app.

import type { DeliveryStats } from "./stats";
import type { BusOptions, LoggerCacheOptions, SecurityContextOptions } from "./config";
import type { StoragePersistence } from "./storage";

/** State of this SDK copy. A configured console-only runtime can have the status "ready". */
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
  /** Codes of the current runtime or context failures. */
  issues: ("runtime.version_mismatch" | "sender.unavailable" | "security.context_mismatch")[];
  /** Logger cache capacity and the number of cached loggers. */
  loggerCache: LoggerCacheOptions & { size: number };
  /** Active delivery context id and isolation rule. */
  securityContext: SecurityContextOptions;
  /** State of the request of `persistence.requestPersistent`. */
  storagePersistence: StoragePersistence;
  /** Source, validation and capacity rules of the bus. */
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

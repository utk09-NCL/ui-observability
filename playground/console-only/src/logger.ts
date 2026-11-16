// playground/console-only/src/logger.ts
//
// Configures the library at module load. Import this module before any other module that logs.

import { configure, getLogger } from "@utk09/ui-observability";

configure({
  // Console-only mode. Nothing gets sent.
  endpoint: null,
  serviceName: "console-only",
  // Keep the session, tab and journey ids in memory, so the library writes no storage key.
  identity: "memory",
  // Don't keep undelivered records.
  storage: "none",
  // Don't start the bus.
  bus: { mode: "off" },
  // Mirror DEBUG and up in development, WARN and up in a production build.
  console: import.meta.env.DEV ? "DEBUG" : "WARN",
});

export { getLogger };

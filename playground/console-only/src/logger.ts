// playground/console-only/src/logger.ts
//
// Configures the library at module load. Import this module before any other module that logs.

import { configure, getLogger } from "@utk09/ui-observability";

configure({
  // Console-only mode. The library sends nothing.
  endpoint: null,
  serviceName: "console-only",
  // Keep session, tab and journey ids in memory. The library writes no storage key.
  identity: "memory",
  // Keep no undelivered records.
  storage: "none",
  // Do not start the bus.
  bus: { mode: "off" },
  // Mirror from DEBUG up in development. Mirror from WARN up in a production build.
  console: import.meta.env.DEV ? "DEBUG" : "WARN",
});

export { getLogger };

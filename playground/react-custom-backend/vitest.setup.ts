import { afterEach, beforeEach } from "vitest";
import { configure, shutdown } from "@utk09/ui-observability";
import { memory } from "./test/observability";

// One setup for all specs. A spec reads memory.records() and needs no mock of the library.
beforeEach(() => {
  configure({
    serviceName: "react-custom-backend",
    transport: memory.transport,
    storage: { backend: "none" },
    bus: { mode: "off" },
    identity: "memory",
  });
});

// Call memory.clear() after shutdown(). The shutdown sends the pending records to the transport.
afterEach(async () => {
  await shutdown();
  memory.clear();
  memory.respondWith(200);
});

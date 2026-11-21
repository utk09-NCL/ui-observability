import { createMemoryTransport } from "@utk09/ui-observability";

// The setup file and each spec import this module, so they share one memory transport.
export const memory = createMemoryTransport();

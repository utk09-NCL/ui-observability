// src/observability-settings/transport.worker.ts
//
// The transport worker. With a custom serializer it sends the metric and span batches. The log
// batches stay on the main thread, because a function can't cross the worker channel.

import { serveTransportWorker } from "@utk09/ui-observability";

serveTransportWorker();

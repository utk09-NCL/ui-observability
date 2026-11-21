// src/observability-settings/app-routes.ts
//
// The two values in this folder that name your app. Replace them when you copy the folder.

/** Requests that match get a traceparent header. Start each pattern with ^, as the docs say. */
export const TRACE_TARGETS: RegExp[] = [/^\/api\//];

/** Where span batches go. A relative URL, like the other endpoints of this app. */
export const TRACES_ENDPOINT = "/telemetry/v1/traces";

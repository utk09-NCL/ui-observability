// src/observability-settings/app-routes.ts
//
// The values in this folder that name your app. Replace them when you copy the folder.

/** Requests that match get a traceparent header. Start each pattern with ^, as the docs say. */
export const TRACE_TARGETS: RegExp[] = [/^\/api\//];

/**
 * Builds an absolute URL on the origin of this page. The library reports config.invalid for a
 * relative endpoint, so the app resolves the path itself. The Vite proxy still sends the call
 * to the log backend.
 * @param path The path of the endpoint, for example "/telemetry/v1/logs".
 * @returns The absolute URL.
 */
export function onOrigin(path: string): string {
  return new URL(path, location.origin).href;
}

/** Where span batches go. A path on the origin of the page, behind the Vite proxy. */
export const TRACES_PATH = "/telemetry/v1/traces";

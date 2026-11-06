import type { Diagnostics } from "../core/diagnostics";
import type { ResolvedConfig } from "../models/config";

/** Header cache of one HTTP transport. The worker path shares its fallback transport's cache. */
interface CachedHeaders {
  source: unknown;
  endpoint: string | null;
  metricsEndpoint: string;
  tracesEndpoint: string;
  headers: Record<string, string>;
}

const caches = new WeakMap<object, CachedHeaders>();

/** Reads the last headers only while their source and all destinations stay in force. */
export function lastHeaders(
  owner: object,
  config: ResolvedConfig,
): Record<string, string> | undefined {
  const { headers } = config;
  if (!headers) {
    return undefined;
  }
  if (typeof headers !== "function") {
    return headers;
  }

  const cached = caches.get(owner);
  const current =
    cached?.source === headers &&
    cached.endpoint === config.endpoint &&
    cached.metricsEndpoint === config.metricsEndpoint &&
    cached.tracesEndpoint === config.tracesEndpoint;
  return current ? cached.headers : undefined;
}

/** Resolves a headers function on the main thread and keeps its result for the exit flush. */
export async function resolveHeaders(
  owner: object,
  config: ResolvedConfig,
  diagnostics: Diagnostics,
): Promise<Record<string, string>> {
  const { headers } = config;
  if (!headers) {
    return {};
  }
  if (typeof headers !== "function") {
    return headers;
  }

  const { endpoint, metricsEndpoint, tracesEndpoint } = config;
  const resolved = await diagnostics.guardAsync(
    "transport.http_error",
    "The headers() function threw an error.",
    () => Promise.resolve(headers()),
  );
  if (resolved) {
    caches.set(owner, {
      source: headers,
      endpoint,
      metricsEndpoint,
      tracesEndpoint,
      headers: resolved,
    });
  }

  return resolved ?? {};
}

/** Removes rejected credentials before the next call of the headers function. */
export function resetHeaders(owner: object): void {
  caches.delete(owner);
}

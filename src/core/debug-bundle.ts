// src/core/debug-bundle.ts
//
// Makes the config summary of a debug bundle. The runtime loads this module only when the app
// asks for a bundle.

import type { ResolvedConfig } from "../models/config";
import { isObject } from "../utils/guards";
import { recordedUrl } from "../utils/platform";
import { sanitize, type SanitizeLimits } from "../utils/sanitize";
import type { Diagnostics } from "./diagnostics";

/**
 * Removes the user info, query and fragment of each absolute URL in a JSON-safe value. The
 * library also puts the endpoints into `capture.ignoreUrls`.
 * @param value JSON-safe value.
 * @returns The value with each URL cut.
 */
function stripUrls(value: unknown): unknown {
  if (typeof value === "string") {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? recordedUrl(value, false) : value;
  }

  if (Array.isArray(value)) {
    return value.map(stripUrls);
  }

  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stripUrls(entry)]));
  }

  return value;
}

/**
 * Copies the config for a support ticket. It leaves out the headers and cuts each URL. A function
 * becomes its name, and a RegExp its text.
 * @param config Active configuration.
 * @param limits Limits of the copy, as for record attributes.
 * @param diagnostics Diagnostics reporter.
 * @returns JSON-safe copy of the config.
 */
export function configSummary(
  config: ResolvedConfig,
  limits: SanitizeLimits,
  diagnostics: Diagnostics,
): Record<string, unknown> {
  // A relative endpoint has no scheme. stripUrls() does not see it as a URL.
  const cut = (value: unknown): unknown =>
    typeof value === "string" ? recordedUrl(value, false) : value;
  const { capture, serializer } = config;
  const copy: Record<string, unknown> = {
    ...config,
    endpoint: cut(config.endpoint),
    metricsEndpoint: cut(config.metricsEndpoint),
    tracesEndpoint: cut(config.tracesEndpoint),
    // An object of the app can hold a key in any field. Only its name goes out.
    serializer: typeof serializer === "string" ? serializer : serializer.name,
    capture: {
      ...capture,
      ignoreUrls: capture.ignoreUrls.map(cut),
      plugins: capture.plugins.map((plugin) => plugin.name),
    },
  };
  // Static headers can hold a token.
  Reflect.deleteProperty(copy, "headers");

  return stripUrls(sanitize(copy, limits, diagnostics)) as Record<string, unknown>;
}

// src/observability/config.ts
//
// The config of the app, built from the settings of the panel. The first configure() call, a
// restart and a login rotation all use it, so the three can't drift apart.

import type { LogRecord, ObservabilityConfig, RoutingOptions } from "@utk09/ui-observability";
import { configFor, SPANS_HINT, TRANSPORT_WORKER_HINT } from "../observability-settings/hints";
import type { Settings } from "../observability-settings/settings";
import { tapDiagnostic, tapProcessor } from "../observability-settings/tap";
import { authHeaders } from "./auth-headers";
import { uilogsSerializer } from "./uilogs-serializer";

export const SERVICE_NAME = "react-custom-backend";

// Relative URLs, as an app behind a reverse proxy writes them. The library resolves each one
// against the page and reports it as config.invalid, see the README. The Vite proxy sends
// /uilogs to the log backend, and it strips /telemetry before it calls the OTLP paths.
const LOGS_ENDPOINT = "/uilogs";
const METRICS_ENDPOINT = "/telemetry/v1/metrics";

/**
 * Drops the arguments of captured console calls. A call such as console.error("failed", response)
 * can carry request headers, so set redact before you turn on capture.console.
 * @param record The record the library built.
 * @returns The record without console.args.
 */
function redact(record: LogRecord): LogRecord {
  const { "console.args": _args, ...attributes } = record.attributes;

  return { ...record, attributes };
}

/** Who the library sends for. The anonymous context has no token, so its routing has no headers. */
export type ContextKind = "anonymous" | "user";

/**
 * Returns the routing settings. A login or a logout rotation replaces each routing setting, and
 * a setting that it leaves out goes back to its default, so each rotation gives the whole set.
 * The headers function belongs to the user routing only. An anonymous batch then can't carry a
 * token, also in the moment between the logout rotation and the revoke call.
 * @param settings The settings in force.
 * @param kind The context that the routing is for.
 * @returns The routing settings.
 */
export function routing(settings: Settings, kind: ContextKind): RoutingOptions {
  return {
    endpoint: LOGS_ENDPOINT,
    metricsEndpoint: METRICS_ENDPOINT,
    tracesEndpoint: SPANS_HINT.toConfig(settings).tracesEndpoint,
    headers: kind === "user" ? authHeaders : undefined,
    transportWorker: TRANSPORT_WORKER_HINT.toConfig(settings).transportWorker,
  };
}

/**
 * Builds the whole config. The panel contributes each setting that it owns, and the rest is
 * fixed for this app.
 * @param settings The settings to use.
 * @param kind The context to start in. The first call of the page is anonymous.
 * @returns A config for configure().
 */
export function buildConfig(settings: Settings, kind: ContextKind): Partial<ObservabilityConfig> {
  const fromSettings = configFor(settings);

  return {
    ...fromSettings,
    ...routing(settings, kind),
    serviceName: SERVICE_NAME,
    serviceVersion: "0.0.0",
    environment: "local",
    serializer: uilogsSerializer,
    capture: { ...fromSettings.capture, errors: true, rejections: true },
    processors: [tapProcessor],
    redact,
    onDiagnostic: tapDiagnostic,
  };
}

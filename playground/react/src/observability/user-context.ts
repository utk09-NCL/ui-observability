// src/observability/user-context.ts
//
// What the library does at login, tenant switch, logout, shared-device logout, consent change
// and restart. It follows the "Login", "Tenant rotation", "Logout", "Logout on a shared device"
// and "Consent withdrawal" recipes of docs/production-recipes.md. Isolation is on by default,
// so configure() refuses a change of the routing settings, and the rotation is the way to
// change them.
//
// The caller runs each function through runExclusive(), see observability-settings/
// operation-queue.ts. A restart in the middle of a rotation makes the rotation reject.

import {
  configure,
  getHealth,
  rotateSecurityContext,
  setContext,
  shutdown,
  startReplay,
  stopReplay,
} from "@utk09/ui-observability";
import type { Settings } from "../observability-settings/settings";
import { buildConfig, routing } from "./config";
import { loadConsent, resetConsent, saveConsent } from "./consent";
import { bumpRuntimeGeneration } from "./runtime-generation";

const FLUSH_TIMEOUT_MS = 3000;

/** The tenant of the user who is logged in. A restart needs it, because it loses the context. */
let activeTenant: string | undefined;

/**
 * Rotates to the user routing with a new opaque context id. The id holds no secret and no
 * personal data.
 * @param tenant The tenant of the user.
 * @param settings The settings in force.
 * @param pending What happens to the records of the old context.
 */
async function rotateToUser(
  tenant: string,
  settings: Settings,
  pending: "flush" | "discard",
): Promise<void> {
  try {
    await rotateSecurityContext(
      { id: `ctx-${crypto.randomUUID()}`, routing: routing(settings, "user"), context: { tenant } },
      { pending, timeoutMs: FLUSH_TIMEOUT_MS },
    );
  } catch (error) {
    // A rejected rotation closes the delivery of the old context, so no tenant is active. A
    // restart after it must start the anonymous config.
    activeTenant = undefined;
    throw error;
  }

  activeTenant = tenant;
}

/**
 * Starts the context of a user. The rotation sends the records of the anonymous context first
 * with the anonymous routing, which has no headers, then starts a new session and a new trace
 * with the tenant on each record.
 * @param tenant The tenant of the user.
 * @param settings The settings in force.
 */
export function beginUserContext(tenant: string, settings: Settings): Promise<void> {
  return rotateToUser(tenant, settings, "flush");
}

/**
 * Moves the library to another tenant of the same user. It discards the unsent records of the
 * old tenant. A flush would send them with the headers function, and that function already reads
 * the token of the new tenant. A second context id keeps the stored batches of the two tenants
 * apart.
 * @param tenant The new tenant.
 * @param settings The settings in force.
 */
export function switchTenantContext(tenant: string, settings: Settings): Promise<void> {
  return rotateToUser(tenant, settings, "discard");
}

/**
 * Returns the library to the anonymous context. Call it before the app revokes the token,
 * because the flush of the user's records needs the headers of the user routing. The anonymous
 * routing has none. Omitting the id makes the runtime pick a new one.
 * @param settings The settings in force.
 */
export async function endUserContext(settings: Settings): Promise<void> {
  // Cleared first. A rotation that rejects must not leave a tenant for a later restart.
  activeTenant = undefined;
  await rotateSecurityContext(
    { routing: routing(settings, "anonymous") },
    { pending: "flush", timeoutMs: FLUSH_TIMEOUT_MS },
  );
}

/**
 * Starts the session replay when the user agreed to it. The recorder stays off until this call,
 * because replay.requireConsent is on, and a new runtime starts with the recorder off. So the
 * page start, a restart and a start after a shared-device logout call it.
 */
export function resumeReplay(): void {
  const consent = loadConsent();
  if (consent.telemetry && consent.replay) {
    startReplay();
  }
}

/**
 * Stops the library for the next user of a shared device. The discard sends nothing, and
 * clearStorage removes the stored batches, the session id, the tab id and the journey of each
 * context in the storage namespace. The privacy choices go too, because the next user decides for himself. The
 * caller then revokes the token and calls startAnonymous().
 */
export async function stopForSharedDevice(): Promise<void> {
  activeTenant = undefined;
  resetConsent();
  // "namespace" and not "context", which the recipe uses. Each page load starts a new security
  // context, so a scope of one context would leave the parked batches of earlier loads and of
  // panel windows on the device for up to 24 hours.
  await shutdown({ pending: "discard", clearStorage: "namespace" });
}

/**
 * Starts a new runtime in the anonymous context, with new ids. It also marks the new runtime, so
 * the panels with a frame or a worker register again.
 * @param settings The settings in force.
 */
export function startAnonymous(settings: Settings): void {
  configure(buildConfig(settings, "anonymous"));
  resumeReplay();
  bumpRuntimeGeneration();
}

/**
 * Stops the library and starts it again, which is the way to change a setting that is fixed
 * after startup. The new runtime knows only the new config, so this gives it the security
 * context id of the old one and the tenant of the user. Loggers and metric handles that the
 * app made before the restart keep working, because they look up the runtime on each call.
 * @param settings The settings to start with.
 */
export async function restartObservability(settings: Settings): Promise<void> {
  await shutdown();
  // getHealth() still reads the stopped runtime, so the id is the one of the old context.
  const { securityContext } = await getHealth();
  const kind = activeTenant === undefined ? "anonymous" : "user";
  configure({ ...buildConfig(settings, kind), securityContext: { id: securityContext.id } });
  if (activeTenant !== undefined) {
    setContext({ tenant: activeTenant });
  }
  resumeReplay();
  // shutdown() cleared the registrations of the frames and the workers. A panel that lists the
  // generation in its effect registers again.
  bumpRuntimeGeneration();
}

/**
 * Stores the telemetry choice and applies it. A withdrawal pauses the library, drops what is
 * not sent and leaves the runtime with no endpoint. A grant resumes it with the routing of
 * the current context, and starts the replay for a user who agreed to it. The stored choice also
 * decides the next page load, see buildConfig().
 * @param allowed True when the user agrees to telemetry.
 * @param settings The settings in force.
 */
export async function setTelemetryConsent(allowed: boolean, settings: Settings): Promise<void> {
  saveConsent({ ...loadConsent(), telemetry: allowed });

  if (!allowed) {
    configure({ enabled: false });
    stopReplay();
    // An empty routing makes the runtime console-only, so nothing can go out.
    await rotateSecurityContext({ routing: {} }, { pending: "discard" });

    return;
  }

  configure({ enabled: true });
  const kind = activeTenant === undefined ? "anonymous" : "user";
  await rotateSecurityContext(
    {
      routing: routing(settings, kind),
      ...(activeTenant === undefined ? {} : { context: { tenant: activeTenant } }),
    },
    { pending: "discard" },
  );
  resumeReplay();
}

/**
 * Stores the replay choice and applies it. The recorder starts only for a user who also allows
 * telemetry. stopReplay() drops each event that was not sent.
 * @param allowed True when the user agrees to the session replay.
 */
export function setReplayConsent(allowed: boolean): void {
  saveConsent({ ...loadConsent(), replay: allowed });

  if (allowed) {
    resumeReplay();
  } else {
    stopReplay();
  }
}

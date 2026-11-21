// src/observability/user-context.ts
//
// What the library does at login, at logout and at a restart. It follows the "Login" and
// "Logout" recipes of docs/production-recipes.md. Isolation is on by default, so configure()
// refuses a change of the routing settings, and the rotation is the way to change them.
//
// The caller runs each function through runExclusive(), see observability-settings/
// operation-queue.ts. A restart in the middle of a rotation makes the rotation reject.

import {
  configure,
  getHealth,
  rotateSecurityContext,
  setContext,
  shutdown,
} from "@utk09/ui-observability";
import type { Settings } from "../observability-settings/settings";
import { buildConfig, routing } from "./config";

const FLUSH_TIMEOUT_MS = 3000;

/** The tenant of the user who is logged in. A restart needs it, because it loses the context. */
let activeTenant: string | undefined;

/**
 * Starts the context of a user. The rotation sends the records of the anonymous context first
 * with the anonymous routing, which has no headers, then starts a new session and a new trace
 * with the tenant on each record.
 * @param tenant The tenant of the user.
 * @param settings The settings in force.
 */
export async function beginUserContext(tenant: string, settings: Settings): Promise<void> {
  await rotateSecurityContext(
    // An opaque id. It holds no secret and no personal data.
    { id: `ctx-${crypto.randomUUID()}`, routing: routing(settings, "user"), context: { tenant } },
    { pending: "flush", timeoutMs: FLUSH_TIMEOUT_MS },
  );
  activeTenant = tenant;
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
}

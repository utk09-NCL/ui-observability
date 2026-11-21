// src/session/session.ts
//
// Login, tenant switch, logout and logout on a shared device. The order of the steps matters,
// see the comments. Each function runs in the queue of observability-settings, so a login, a
// logout, a restart and a change of setting never overlap.

import { getLogger } from "@utk09/ui-observability";
import type { Api } from "../api/client";
import {
  beginUserContext,
  endUserContext,
  restartObservability,
  startAnonymous,
  stopForSharedDevice,
  switchTenantContext,
} from "../observability/user-context";
import { runExclusive } from "../observability-settings/operation-queue";
import { getSettingsState } from "../observability-settings/settings-store";
import { getToken, setToken } from "./token";

export interface Session {
  user: string;
  tenant: string;
  /** The token of this session. The stream reads it here, and not from the module variable. */
  token: string;
}

/**
 * Logs a user in. The token is there before the rotation, so the first request of the user
 * context has it. The flush of the anonymous records can't carry it, because the anonymous
 * routing has no headers function. If the rotation fails, the login fails with its error, and
 * the library starts again with the anonymous config.
 * @param api The client of the app API.
 * @param user The user name.
 * @param tenant The tenant id.
 * @returns The session.
 */
export function login(api: Api, user: string, tenant: string): Promise<Session> {
  return runExclusive(async () => {
    const result = await api.login(user, tenant);
    setToken(result.token);
    try {
      await beginUserContext(result.tenant, getSettingsState().applied);
    } catch (error) {
      await abandonLogin(api);
      throw error;
    }

    return { user: result.user, tenant: result.tenant, token: result.token };
  });
}

/**
 * Undoes a login whose rotation failed. The page stays on the login screen.
 * - The server session that api.login() made is still valid, so it is revoked first.
 * - After a failed rotation the library drops each new record, and a failed load of the rotation
 *   code fails each later rotation until a reload. A restart opens delivery again. It runs here
 *   and not through the queue, because the login holds the queue and would wait for itself.
 *   activeTenant is still unset, so the restart starts the anonymous config.
 * The caller throws the error of the rotation. Nothing here replaces it.
 * @param api The client of the app API.
 */
async function abandonLogin(api: Api): Promise<void> {
  let revokeFailed = false;
  try {
    await api.logout();
  } catch {
    // Reported below, after the restart, because the library drops records until then.
    revokeFailed = true;
  }
  setToken(undefined);

  try {
    await restartObservability(getSettingsState().applied);
  } catch {
    // The error of the rotation is the one to report. A failed restart adds nothing to it.
  }

  if (revokeFailed) {
    getLogger("session").warn("The revoke call after a failed login failed.");
  }
}

/**
 * Logs the user out. The library goes back to the anonymous context while the token is still
 * there, because the flush of the user's records needs it. Then the app revokes the token and
 * clears it. A failed rotation or a failed revoke call doesn't keep the token, because the
 * "Logout" recipe says to revoke it anyway. A second call finds no token and does nothing, so
 * a double click starts one logout.
 * @param api The client of the app API.
 */
export function logout(api: Api): Promise<void> {
  return runExclusive(async () => {
    if (getToken() === undefined) {
      return;
    }

    try {
      await endUserContext(getSettingsState().applied);
    } finally {
      try {
        await api.logout();
      } finally {
        setToken(undefined);
      }
    }
  });
}

/**
 * Moves the logged-in user to another tenant. The server has no switch call, so the app logs in
 * again for the new tenant, then revokes the old token. The library rotates after the new token
 * is in place, because the first request of the new context needs it. If the rotation fails,
 * the login fails too, and the caller shows the login screen. The error of the rotation is
 * the one that the caller gets.
 * @param api The client of the app API.
 * @param user The user name.
 * @param tenant The new tenant id.
 * @returns The session of the new tenant.
 */
export function switchTenant(api: Api, user: string, tenant: string): Promise<Session> {
  return runExclusive(async () => {
    const result = await api.login(user, tenant);
    const oldToken = getToken();
    setToken(result.token);
    try {
      await switchTenantContext(result.tenant, getSettingsState().applied);
    } catch (error) {
      await abandonLogin(api);
      if (oldToken !== undefined) {
        await revokeOld(api, oldToken);
      }
      throw error;
    }

    // The old session is revoked last. A failed revoke leaves a token that expires on its own, so
    // it must not undo a switch that worked.
    if (oldToken !== undefined) {
      await revokeOld(api, oldToken);
    }

    return { user: result.user, tenant: result.tenant, token: result.token };
  });
}

/**
 * Revokes a token that the app no longer uses. The api client sends the current token, so the
 * call goes through fetch with the old one.
 * @param api The client of the app API.
 * @param oldToken The token of the previous tenant.
 */
async function revokeOld(api: Api, oldToken: string): Promise<void> {
  try {
    await api.logoutToken(oldToken);
  } catch {
    getLogger("session").warn("The revoke call for the old tenant failed.");
  }
}

/**
 * Logs the user out of a shared device. The order is the one of the "Logout on a shared
 * device" recipe. The library stops first and removes its stored data. The app then revokes the
 * token and clears it, and a new anonymous runtime starts for the next user. The new runtime
 * starts even when the revoke call fails.
 * @param api The client of the app API.
 */
export function logoutSharedDevice(api: Api): Promise<void> {
  return runExclusive(async () => {
    if (getToken() === undefined) {
      return;
    }

    await stopForSharedDevice();
    try {
      await api.logout();
    } finally {
      setToken(undefined);
      startAnonymous(getSettingsState().applied);
    }
  });
}

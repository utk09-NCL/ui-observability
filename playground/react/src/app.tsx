// src/app.tsx
//
// The login screen, or the workspace of the logged-in user.

import { type ReactElement, useState } from "react";
import { getLogger } from "@utk09/ui-observability";
import { createApi } from "./api/client";
import { ObservabilityErrorBoundary } from "./observability/react";
import { login, logout, logoutSharedDevice, type Session, switchTenant } from "./session/session";
import { getToken } from "./session/token";
import { LoginScreen } from "./workspace/login-screen";
import { removeUserLayouts } from "./workspace/layout-store";
import { Workspace } from "./workspace/workspace";

// One client for the page. It reads the token on each call, so it needs no new instance at login.
const api = createApi(getToken);

const log = getLogger("session");

/**
 * The application.
 * @returns The root element.
 */
export function App(): ReactElement {
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState("");

  const leave = async (): Promise<void> => {
    try {
      await logout(api);
    } catch (error) {
      log.error("logout failed", error);
    } finally {
      setNotice("");
      setSession(null);
    }
  };

  const leaveSharedDevice = async (current: Session): Promise<void> => {
    try {
      await logoutSharedDevice(api);
    } catch (error) {
      log.error("shared-device logout failed", error);
    } finally {
      // The next user of this device must not get a layout of this user, in any tenant.
      removeUserLayouts(current.user);
      setNotice("");
      setSession(null);
    }
  };

  const moveToTenant = async (current: Session, tenant: string): Promise<void> => {
    try {
      setSession(await switchTenant(api, current.user, tenant));
    } catch (error) {
      log.error("tenant switch failed", error);
      setNotice("The tenant switch failed. Log in again.");
      setSession(null);
    }
  };

  return (
    <ObservabilityErrorBoundary fallback={<p role="alert">Something broke, and it was logged.</p>}>
      {session ? (
        <Workspace
          // A new key remounts the workspace, so each user and tenant opens its own layout.
          key={`${session.user}|${session.tenant}`}
          session={session}
          api={api}
          onSwitchTenant={(tenant) => {
            void moveToTenant(session, tenant);
          }}
          onLogout={() => {
            void leave();
          }}
          onLogoutShared={() => {
            void leaveSharedDevice(session);
          }}
        />
      ) : (
        <LoginScreen
          api={api}
          notice={notice}
          onLogin={async (user, tenant) => {
            setNotice("");
            setSession(await login(api, user, tenant));
          }}
        />
      )}
    </ObservabilityErrorBoundary>
  );
}

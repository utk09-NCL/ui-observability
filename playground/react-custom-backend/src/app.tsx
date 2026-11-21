// src/app.tsx
//
// The login screen, or the workspace of the logged-in user.

import { type ReactElement, useState } from "react";
import { getLogger } from "@utk09/ui-observability";
import { createApi } from "./api/client";
import { ObservabilityErrorBoundary } from "./observability/react";
import { login, logout, type Session } from "./session/session";
import { getToken } from "./session/token";
import { LoginScreen } from "./trading/login-screen";
import { Workspace } from "./trading/workspace";

// One client for the page. It reads the token on each call, so it needs no new instance at login.
const api = createApi(getToken);

/**
 * The application.
 * @returns The root element.
 */
export function App(): ReactElement {
  const [session, setSession] = useState<Session | null>(null);

  const leave = async (): Promise<void> => {
    try {
      await logout(api);
    } catch (error) {
      getLogger("session").error("logout failed", error);
    } finally {
      setSession(null);
    }
  };

  return (
    <ObservabilityErrorBoundary fallback={<p role="alert">Something broke, and it was logged.</p>}>
      {session ? (
        <Workspace
          session={session}
          api={api}
          onLogout={() => {
            void leave();
          }}
        />
      ) : (
        <LoginScreen
          api={api}
          onLogin={async (user, tenant) => {
            setSession(await login(api, user, tenant));
          }}
        />
      )}
    </ObservabilityErrorBoundary>
  );
}

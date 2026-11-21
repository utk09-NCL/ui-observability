// src/panel-window/main.tsx
//
// The window of one panel ("Open in new window"). It is its own document, so it starts its own
// runtime, sends its own records and logs in for itself. It gets no token from the opener.
// The opener passes the user and the tenant with one postMessage, and the address holds the
// journey token in its fragment. After the login, this window adopts that journey, so its records
// have the same journey id as the opener's. At pagehide, the window revokes its own session.
//
// The handshake, the login and the adoption run at module scope and not in an effect. They send
// a message, create a server session and rotate the runtime, and StrictMode would run an effect
// of that kind two times.

import { type ReactElement, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { adoptJourney, configure, currentJourney, getLogger } from "@utk09/ui-observability";
import { createApi } from "../api/client";
import { buildConfig } from "../observability/config";
import { watchConsent } from "../observability/consent-sync";
import { resumeReplay } from "../observability/user-context";
import { runExclusive } from "../observability-settings/operation-queue";
import { getSettingsState } from "../observability-settings/settings-store";
import { PANEL_COMPONENTS } from "../panels/registry";
import { login, type Session } from "../session/session";
import { getToken } from "../session/token";
import { WorkspaceContext } from "../workspace/context";
import { PANELS } from "../workspace/default-layout";
import { useTokenRefresh, useWorkspaceData } from "../workspace/use-workspace-data";
import { watchPageRestore } from "./page-lifecycle";
import {
  comesFrom,
  isSessionMessage,
  type PanelRequest,
  type PanelSession,
  parsePanelRequest,
  READY_TYPE,
} from "./protocol";
import { startWindow } from "./start";

const ANSWER_TIMEOUT_MS = 10_000;

const api = createApi(getToken);
const log = getLogger("panel.window");

// One configure() call for the page, as in main.tsx. It starts the anonymous context, and the
// login below rotates to the user context. A page that nobody opened from the workspace never logs
// in, so it sends nothing.
configure(buildConfig(getSettingsState().applied, "anonymous"));
resumeReplay();
// The workspace stores a change of the privacy choices, and the browser sends a storage event to
// this window. Without the listener, this window would keep sending after the user withdrew the
// consent, because it read the choice one time, at its start.
watchConsent({ settings: () => getSettingsState().applied, run: runExclusive });

/**
 * Asks the opener for the user and the tenant. The window accepts one answer, from the opener
 * window and from its own origin. The question goes to this origin, never to "*".
 * @param opener The window that opened this one.
 * @returns The user and the tenant.
 */
function askOpener(opener: Window): Promise<PanelSession> {
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent): void => {
      if (comesFrom(event, location.origin, opener) && isSessionMessage(event.data)) {
        stop();
        resolve({ user: event.data.user, tenant: event.data.tenant });
      }
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error("The workspace did not answer."));
    }, ANSWER_TIMEOUT_MS);

    addEventListener("message", onMessage);
    opener.postMessage({ type: READY_TYPE }, location.origin);
  });
}

const request = parsePanelRequest(location.search, location.hash);
const opener = window.opener as Window | null;
const started: Promise<Session> | null =
  request && opener
    ? startWindow(request.journeyToken, {
        ask: () => askOpener(opener),
        dropOpener: () => {
          window.opener = null;
        },
        login: (who) => login(api, who.user, who.tenant),
        revoke: () => {
          api.logoutOnExit();
        },
        adopt: adoptJourney,
        warn: (message) => {
          log.warn(message);
        },
      })
    : null;

/** The panel, with the data hooks that every page with panels needs. */
function Shown({
  session,
  panel,
}: {
  session: Session;
  panel: PanelRequest["panel"];
}): ReactElement {
  useWorkspaceData(session, api);
  useTokenRefresh(session, api);
  const Panel = PANEL_COMPONENTS[panel];
  const title = PANELS.find((item) => item.id === panel)?.title ?? panel;
  const [journeyId] = useState(() => currentJourney()?.id ?? "none");

  return (
    <WorkspaceContext.Provider value={{ api, session }}>
      <header className="bar">
        <h1>{title}</h1>
        <p className="muted">
          {session.user}, {session.tenant}. Journey{" "}
          <code data-testid="journey-id">{journeyId}</code>
        </p>
      </header>
      <div className="dockview-host dockview-theme-dark">
        <Panel />
      </div>
    </WorkspaceContext.Provider>
  );
}

/**
 * The page. It shows the panel when the login is done.
 * @returns The root element.
 */
function PanelWindow(): ReactElement {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");

  // Reading the promise has no side effect, so StrictMode can run it twice.
  useEffect(() => {
    let active = true;
    started
      ?.then((next) => {
        if (active) {
          setSession(next);
        }
      })
      .catch((reason: unknown) => {
        // StrictMode runs this effect twice. Only the run that is still active reports, so the
        // log gets one ERROR record.
        if (active) {
          log.error("The panel window could not start.", reason);
          setError("The panel window could not start. Open it again from the workspace.");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  // A page that comes back from the back/forward cache holds a token that pagehide revoked. The
  // error state unmounts the panel, which stops its refresh timer and its requests.
  useEffect(
    () =>
      watchPageRestore(() => {
        setError(
          "This window came back from the browser cache, and its session has ended. " +
            "Open it again from the workspace.",
        );
      }),
    [],
  );

  if (!request || !opener) {
    // A reload lands here too. The window dropped its link to the workspace after the handshake.
    return (
      <p role="alert">
        Open this window with the button of a panel in the workspace. A reload ends the link to the
        workspace, so open the window again from there.
      </p>
    );
  }
  if (error) {
    return <p role="alert">{error}</p>;
  }

  return session ? (
    <Shown session={session} panel={request.panel} />
  ) : (
    <p>Waiting for the workspace.</p>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("panel.html is missing #root");
}

createRoot(container).render(
  <StrictMode>
    <PanelWindow />
  </StrictMode>,
);

// src/panel-window/start.ts
//
// The start of a panel window, in order: ask the opener, log in, adopt the journey. The steps
// come in as functions, so a spec can check their order without a browser.

import type { Session } from "../session/session";
import { revokeAtPageHide } from "./page-lifecycle";
import type { PanelSession } from "./protocol";

export interface StartSteps {
  /** Asks the opener for the user and the tenant. */
  ask: () => Promise<PanelSession>;
  /** Drops the link to the opener, so a page that the window loads later can't reach it. */
  dropOpener: () => void;
  /** Logs in for this window, and rotates the security context. */
  login: (who: PanelSession) => Promise<Session>;
  /** Revokes the token of this window. It must do nothing while no token is set. */
  revoke: () => void;
  /** Adopts the journey of the opener. Returns false when the library refuses the token. */
  adopt: (journeyToken: string) => boolean;
  /** Reports a journey that the window could not adopt. */
  warn: (message: string) => void;
}

/**
 * Starts the window. The login rotates the security context, and a rotation ends the active
 * journey, so the adoption comes after the login.
 * @param journeyToken The token of the journey of the opener, or null when the address has none.
 * @param steps The steps of the start.
 * @returns The session of this window.
 */
export async function startWindow(
  journeyToken: string | null,
  steps: StartSteps,
): Promise<Session> {
  // The listener comes first. The login sets the token and then rotates the security context,
  // which takes up to 3 seconds. A window that closes in that time would keep a valid token on
  // the server otherwise. revoke() does nothing while no token is set.
  revokeAtPageHide(steps.revoke);
  const who = await steps.ask();
  // The window has what it needs from the opener, so the link can go.
  steps.dropOpener();
  const session = await steps.login(who);
  if (journeyToken !== null && !steps.adopt(journeyToken)) {
    steps.warn("The window could not adopt the journey of its opener.");
  }

  return session;
}

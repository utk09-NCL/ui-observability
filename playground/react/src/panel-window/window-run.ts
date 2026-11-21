// src/panel-window/window-run.ts
//
// The life of a panel window, in two parts. start() asks the opener, logs in and adopts the
// journey. end() stops the window for good, after the browser restored its page from the
// back/forward cache. The steps come in as functions, so a spec can check them without a browser.

import type { Session } from "../session/session";
import { revokeAtPageHide } from "./page-lifecycle";
import type { PanelSession } from "./protocol";

export interface WindowSteps {
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
  /** Forgets the token of this window. */
  clearToken: () => void;
  /** Stops the listener for the privacy choices of the workspace. */
  stopConsentWatch: () => void;
  /** Stops the library of this window and discards what it did not send. */
  discard: () => Promise<void>;
  /** Reports a failure that nobody else can handle. */
  report: (reason: unknown) => void;
}

export interface PanelWindowRun {
  /**
   * Starts the window. The login rotates the security context, and a rotation ends the active
   * journey, so the adoption comes after the login.
   * @param journeyToken The token of the journey of the opener, or null when the address has none.
   * @returns The session of this window, or null when the window ended first.
   */
  start(journeyToken: string | null): Promise<Session | null>;
  /** Ends the window. A later start() step does nothing, and a login in progress is undone. */
  end(): void;
}

/**
 * Creates the run of one panel window.
 * @param steps The steps of the run.
 * @returns The run.
 */
export function createPanelWindow(steps: WindowSteps): PanelWindowRun {
  let stopHide: (() => void) | undefined;
  // Set by end(). It stays set, because a page that came back from the cache is not usable again.
  let ended = false;
  // A function and not the variable, so the checks after an await stay real checks for the types.
  const isEnded = (): boolean => ended;

  return {
    async start(journeyToken) {
      // The listener comes first. The login sets the token and then rotates the security
      // context, which takes up to 3 seconds. A window that closes in that time would keep a
      // valid token on the server otherwise. revoke() does nothing while no token is set.
      stopHide = revokeAtPageHide(steps.revoke);
      const who = await steps.ask();
      // A pagehide before the login revoked nothing, because no token was set. If the browser
      // then restored the page, a login here would give a new token to a page that is gone.
      if (isEnded()) {
        return null;
      }

      // The window has what it needs from the opener, so the link can go.
      steps.dropOpener();
      const session = await steps.login(who);
      if (isEnded()) {
        // The login set the token after end() cleared it, and the pagehide before the restore
        // had no token to revoke. Without the revoke, that server session stays valid.
        steps.revoke();
        steps.clearToken();

        return null;
      }

      if (journeyToken !== null && !steps.adopt(journeyToken)) {
        steps.warn("The window could not adopt the journey of its opener.");
      }

      return session;
    },
    end() {
      if (ended) {
        return;
      }

      ended = true;
      stopHide?.();
      steps.stopConsentWatch();
      steps.clearToken();
      steps.discard().catch((reason: unknown) => {
        steps.report(reason);
      });
    },
  };
}

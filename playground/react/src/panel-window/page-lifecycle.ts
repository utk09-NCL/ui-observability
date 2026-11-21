// src/panel-window/page-lifecycle.ts
//
// What the window of a panel does when the browser hides or restores its page. The window revokes
// its own server session at pagehide, so the token doesn't stay valid after the window closes.
// A page that the browser restores from its back/forward cache holds that revoked token, so the
// window must not run on it. It ends instead, see window-run.ts.

/**
 * Calls revoke each time the page hides. The call must not wait, because the page is going away.
 * @param revoke Starts the revocation of the session, for example with a keepalive request.
 * @returns Function that removes the listener.
 */
export function revokeAtPageHide(revoke: () => void): () => void {
  const onHide = (): void => {
    revoke();
  };
  addEventListener("pagehide", onHide);

  return () => {
    removeEventListener("pagehide", onHide);
  };
}

/**
 * Calls onRestored when the browser shows the page again from its back/forward cache. The first
 * show of a page is not a restore.
 * @param onRestored Called with no argument.
 * @returns Function that removes the listener.
 */
export function watchPageRestore(onRestored: () => void): () => void {
  const onShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) {
      onRestored();
    }
  };
  addEventListener("pageshow", onShow);

  return () => {
    removeEventListener("pageshow", onShow);
  };
}

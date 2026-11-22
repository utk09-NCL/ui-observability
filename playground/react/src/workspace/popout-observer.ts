// src/workspace/popout-observer.ts
//
// Gives each dockview popout window to the library, so a click in a popout is captured. The panel
// code of a popout runs in this page, but dockview moves the DOM into another window, and the
// click capture only listens on the window of the page. observeWindow() adds that window.
// dockview opens a popout in four ways: the group button, the tab menu, a drop and a saved layout.
// All four end in onDidAddPopoutGroup, so this one hookup covers them.

import { observeWindow } from "@utk09/ui-observability";

/** One popout window. dockview gives a null handle for a window that is closing. */
interface PopoutWindow {
  window: Window | null;
}

/** The part of the dockview API that the hookup reads. DockviewApi has all of it. */
export interface PopoutSource {
  getPopouts(): readonly PopoutWindow[];
  onDidAddPopoutGroup(listener: (popout: PopoutWindow) => void): { dispose(): void };
  onWillClosePopoutWindow(listener: (popout: PopoutWindow) => void): { dispose(): void };
}

/**
 * Observes each popout window that is open now and each one that opens later. A window is observed
 * as a whole, so a second group in the same popout needs no second call. dockview fires the close
 * event for each close, and that stops the window and drops it from the map. The library's own
 * pagehide forget is only a backstop, and it leaves a stale entry here until the cleanup.
 * @param dock The dockview API.
 * @returns Function that stops the observation of each window and removes the listeners. The
 * effect cleanup calls it, so StrictMode can run the effect, clean up and run it again.
 */
export function observePopouts(dock: PopoutSource): () => void {
  const stops = new Map<Window, () => void>();

  const attach = (popout: PopoutWindow): void => {
    const { window: popoutWindow } = popout;
    if (popoutWindow && !stops.has(popoutWindow)) {
      stops.set(popoutWindow, observeWindow(popoutWindow));
    }
  };

  // dockview fires this while the window is still open, so the listeners leave it cleanly.
  const release = (popout: PopoutWindow): void => {
    const { window: popoutWindow } = popout;
    if (popoutWindow) {
      stops.get(popoutWindow)?.();
      stops.delete(popoutWindow);
    }
  };

  // The popouts that opened before the listeners, for example one that a saved layout restored.
  for (const popout of dock.getPopouts()) {
    attach(popout);
  }
  const addSub = dock.onDidAddPopoutGroup(attach);
  const closeSub = dock.onWillClosePopoutWindow(release);

  return () => {
    addSub.dispose();
    closeSub.dispose();
    for (const stop of stops.values()) {
      stop();
    }
    stops.clear();
  };
}

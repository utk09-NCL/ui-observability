// src/workspace/panel-windows.ts
//
// "Open in new window". The workspace opens a real window that shows one panel. The window is
// its own document, so it starts its own runtime and sends its own records. What links its
// records to the workspace is the journey. The opener serializes its journey with
// getJourneyToken() into the address, and the window adopts it with adoptJourney().
//
// Trust: the opener answers a message only from a window that it opened, from its own origin,
// and it answers to its own origin. The answer holds the user name and the tenant, and no token.

import {
  currentJourney,
  endJourney,
  getJourneyToken,
  getLogger,
  startJourney,
} from "@utk09/ui-observability";
import type { PanelId } from "./default-layout";
import {
  buildPanelUrl,
  comesFrom,
  isReadyMessage,
  SESSION_TYPE,
  type PanelSession,
} from "../panel-window/protocol";

const log = getLogger("workspace.windows");
const JOURNEY_NAME = "panel-window";
const POLL_CLOSED_MS = 1000;

interface OpenedWindow {
  window: Window;
  session: PanelSession;
  /** The id of the journey that this call started, or null when a journey already ran. */
  startedJourney: string | null;
}

const opened = new Set<OpenedWindow>();
let timer: ReturnType<typeof setInterval> | undefined;
let listening = false;

/** Ends the journey that the call started, but only while it is still the active one. */
function endStartedJourney(entry: OpenedWindow): void {
  if (entry.startedJourney !== null && currentJourney()?.id === entry.startedJourney) {
    endJourney();
  }
}

function forget(entry: OpenedWindow): void {
  opened.delete(entry);
  endStartedJourney(entry);
  if (opened.size === 0) {
    stopWatching();
  }
}

function onMessage(event: MessageEvent): void {
  for (const entry of opened) {
    if (comesFrom(event, location.origin, entry.window)) {
      if (isReadyMessage(event.data)) {
        // The target origin is ours, never "*", so a window that navigated away gets nothing.
        entry.window.postMessage({ type: SESSION_TYPE, ...entry.session }, location.origin);
      }

      return;
    }
  }
}

function startWatching(): void {
  if (!listening) {
    addEventListener("message", onMessage);
    listening = true;
  }
  // Nothing tells the opener that a window closed, so it asks each second.
  timer ??= setInterval(() => {
    for (const entry of opened) {
      if (entry.window.closed) {
        forget(entry);
      }
    }
  }, POLL_CLOSED_MS);
}

function stopWatching(): void {
  removeEventListener("message", onMessage);
  listening = false;
  clearInterval(timer);
  timer = undefined;
}

/**
 * Opens a window with one panel. A call from a click is necessary, or the browser blocks it.
 * @param panel The panel to show.
 * @param session The user and the tenant of the workspace.
 * @returns True when the window opened.
 */
export function openPanelWindow(panel: PanelId, session: PanelSession): boolean {
  // The journey is ambient, so it covers the records of the opener while the window lives. If
  // the user is in a journey already, the window adopts it and leaves its end to its owner.
  const startedJourney = currentJourney() ? null : startJourney(JOURNEY_NAME).id;
  const url = buildPanelUrl(new URL("/panel.html", location.origin).href, panel, getJourneyToken());
  const child = window.open(url, "_blank");
  const entry: OpenedWindow | null = child ? { window: child, session, startedJourney } : null;

  if (!entry) {
    log.warn("The browser did not open the panel window. Allow popups for this site.");
    if (startedJourney !== null) {
      endJourney();
    }

    return false;
  }

  opened.add(entry);
  startWatching();
  log.logAction("PANEL_WINDOW_OPENED", { panel });

  return true;
}

/** Closes each panel window, for example at logout. The windows hold a session that ends. */
export function closePanelWindows(): void {
  for (const entry of [...opened]) {
    entry.window.close();
    forget(entry);
  }
}

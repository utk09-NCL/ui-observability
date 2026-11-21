// src/panel-window/protocol.ts
//
// What the workspace and the window of one panel say to each other. The opener puts the panel and
// the journey token in the address of the window. The window asks the opener for the user and
// the tenant with one postMessage, and the opener answers to the same origin. No token crosses
// the channel. The window logs in for itself.

import { PANELS, type PanelId } from "../workspace/default-layout";

const PANEL_PARAM = "panel";
const JOURNEY_PARAM = "journey";

/** The window asks for the session with this message type. */
export const READY_TYPE = "uiobs-panel-ready";
/** The opener answers with the user and the tenant under this message type. */
export const SESSION_TYPE = "uiobs-panel-session";

/** The panels that a window can show. The settings panel changes the runtime of its own page. */
export const WINDOW_PANELS: readonly PanelId[] = PANELS.filter(
  (panel) => panel.id !== "settings",
).map((panel) => panel.id);

export interface PanelRequest {
  panel: PanelId;
  /** The token of the journey of the opener, or null when the address has none. */
  journeyToken: string | null;
}

export interface PanelSession {
  user: string;
  tenant: string;
}

/**
 * Builds the address of the window of a panel.
 * @param base The address of the page, for example "http://localhost:5180/panel.html".
 * @param panel The panel that the window shows.
 * @param journeyToken The result of getJourneyToken(), or null.
 * @returns The address.
 */
export function buildPanelUrl(base: string, panel: PanelId, journeyToken: string | null): string {
  const url = new URL(base);
  url.searchParams.set(PANEL_PARAM, panel);
  if (journeyToken !== null) {
    url.searchParams.set(JOURNEY_PARAM, journeyToken);
  }

  return url.href;
}

/**
 * Reads the panel and the journey token from the address of the window. The panel must be one
 * that a window can show, so the address can't make the page render anything else.
 * @param search The query string of the window.
 * @returns The request, or null when the address has no valid panel.
 */
export function parsePanelRequest(search: string): PanelRequest | null {
  const params = new URLSearchParams(search);
  const panel = WINDOW_PANELS.find((id) => id === params.get(PANEL_PARAM));
  if (!panel) {
    return null;
  }

  const token = params.get(JOURNEY_PARAM);

  return { panel, journeyToken: token === null || token === "" ? null : token };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Checks the question of the window. */
export function isReadyMessage(data: unknown): boolean {
  return isObject(data) && data.type === READY_TYPE;
}

/**
 * Checks the answer of the opener.
 * @param data The data of a message event.
 * @returns True for a session message with a user and a tenant of text.
 */
export function isSessionMessage(data: unknown): data is { type: string } & PanelSession {
  return (
    isObject(data) &&
    data.type === SESSION_TYPE &&
    typeof data.user === "string" &&
    data.user !== "" &&
    typeof data.tenant === "string" &&
    data.tenant !== ""
  );
}

/**
 * Checks where a message comes from. A message passes only from the expected window and from the
 * origin of this page. A page of another origin that holds a reference to the window can't pass.
 * @param event The origin and the source of the message event.
 * @param origin The origin of this page.
 * @param source The window that the message must come from.
 * @returns True when both match.
 */
export function comesFrom(
  event: { origin: string; source: unknown },
  origin: string,
  source: unknown,
): boolean {
  return event.origin === origin && event.source !== null && event.source === source;
}

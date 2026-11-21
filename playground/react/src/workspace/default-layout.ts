// src/workspace/default-layout.ts
//
// The panels that the workspace knows, and the layout that a new user, a corrupt layout and
// "Reset layout" open. A panel id is also its dockview component name.

import type { DockviewApi } from "dockview-react";
import { FRAME_PANELS } from "./frame-panels";

export type PanelId =
  | "prices"
  | "ticket"
  | "blotter"
  | "positions"
  | "chart"
  | "research"
  | "partner"
  | "untrusted"
  | "activity"
  | "support"
  | "settings";

export interface PanelInfo {
  id: PanelId;
  title: string;
  /** The text of the "Add panel" menu. */
  description: string;
}

export const PANELS: readonly PanelInfo[] = [
  { id: "prices", title: "Prices", description: "Live FX tiles from the WebSocket" },
  { id: "ticket", title: "Order ticket", description: "Place an order" },
  { id: "blotter", title: "Blotter", description: "Filter and cancel orders" },
  { id: "positions", title: "Positions", description: "P&L that a worker computes" },
  { id: "chart", title: "Chart", description: "A canvas chart of the prices" },
  { id: "research", title: "Research", description: "A same-origin frame on the bus" },
  { id: "partner", title: "Partner widget", description: "A cross-origin frame, registered" },
  {
    id: "untrusted",
    title: "Untrusted widget",
    description: "A frame that the app did not register",
  },
  { id: "activity", title: "Activity log", description: "The records that the app emits" },
  { id: "support", title: "Support", description: "Replays, health and the debug bundle" },
  { id: "settings", title: "Observability settings", description: "Change the config" },
];

export type PanelPosition =
  | { referencePanel: string; direction: "right" | "below" | "within" }
  | { direction: "right" | "below" };

/**
 * Adds one panel, or shows it when it already exists. The id of the panel is its component name,
 * so the workspace has at most one panel of each kind.
 * @param api The dockview API.
 * @param id The panel to open.
 * @param position Where a new panel goes. Without it, the panel joins the active group. A frame
 * panel goes to the edge of the grid instead when the active group is a popout window, because a
 * frame in a popout window leaves the bus. See frame-panels.ts.
 */
export function openPanel(api: DockviewApi, id: PanelId, position?: PanelPosition): void {
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();

    return;
  }

  const isFrame = FRAME_PANELS.includes(id);
  // A popout group is the active group while its window has focus. A floating group is a part of
  // the same document, so it is fine for a frame.
  const target =
    position ??
    (isFrame && api.activeGroup?.api.location.type === "popout"
      ? ({ direction: "right" } as const)
      : undefined);
  const info = PANELS.find((panel) => panel.id === id);
  api.addPanel({
    id,
    component: id,
    title: info?.title ?? id,
    // A panel with an iframe uses the renderer "always". dockview removes the DOM of a hidden
    // panel, and the browser reloads an iframe that leaves the document. With "always", a tab
    // change or a move inside the page does not reload the frame. A move into a popout window
    // does, in a new browsing context, so these panels stay out of popout windows. See
    // frame-panels.ts.
    ...(isFrame ? { renderer: "always" as const } : {}),
    ...(target ? { position: target } : {}),
  });
}

/**
 * Builds the default layout in an empty dockview. Prices and the ticket stand in the left
 * column. The blotter and positions share a group at the top right, and the activity log and
 * the settings share a group below it. The order of the calls matters. A panel that goes to the
 * right of the first panel splits the whole row, so the right column comes before the ticket.
 * @param api The dockview API.
 */
export function addDefaultPanels(api: DockviewApi): void {
  openPanel(api, "prices");
  openPanel(api, "blotter", { referencePanel: "prices", direction: "right" });
  openPanel(api, "ticket", { referencePanel: "prices", direction: "below" });
  openPanel(api, "positions", { referencePanel: "blotter", direction: "within" });
  openPanel(api, "activity", { referencePanel: "blotter", direction: "below" });
  openPanel(api, "settings", { referencePanel: "activity", direction: "within" });
  // The last panel of a group becomes active, so show the first tab of each shared group.
  api.getPanel("blotter")?.api.setActive();
  api.getPanel("activity")?.api.setActive();
}

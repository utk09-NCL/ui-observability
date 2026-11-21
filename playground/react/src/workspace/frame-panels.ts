// src/workspace/frame-panels.ts
//
// The panels that hold an iframe, and the rule that keeps them out of a popout window. dockview
// moves the DOM of a group into the popout window, and the browser then loads the iframe again in
// a new browsing context. The frame there has a parent that has no runtime, so its records can't
// reach the bus of the workspace. The workspace therefore does not offer "Pop out" for a group
// with a frame panel, and it blocks the drop of a frame panel into a popout window.

/** The panels that hold an iframe. Their renderer is "always", see default-layout.ts. */
export const FRAME_PANELS: readonly string[] = ["research", "partner", "untrusted"];

/**
 * Checks whether a panel id is one of the frame panels.
 * @param id The panel id.
 * @returns True for a frame panel.
 */
export function isFramePanel(id: string | undefined): boolean {
  return id !== undefined && FRAME_PANELS.includes(id);
}

/**
 * Checks whether a group holds a frame panel. dockview moves the whole group into a popout
 * window, so one frame panel is enough to keep the group out of it.
 * @param panels The panels of the group.
 * @returns True when one of them is a frame panel.
 */
export function holdsFramePanel(panels: readonly { id: string }[]): boolean {
  return panels.some((panel) => isFramePanel(panel.id));
}

export interface DropFacts {
  /** The group under the pointer. An edge of a window has none. */
  targetGroup: { api: { location: { type: string } } } | undefined;
  /** True when the pointer is over another document than the page, which is a popout window. */
  overPopoutDocument: boolean;
  /** The panels that the drag carries: one panel, or each panel of a group. */
  dragged: readonly { id: string }[];
}

/**
 * Decides whether a drop would put a frame panel into a popout window.
 * @param facts The target, the document under the pointer and the dragged panels.
 * @returns True when the drop must be blocked.
 */
export function movesFrameIntoPopout(facts: DropFacts): boolean {
  const intoPopout = facts.targetGroup?.api.location.type === "popout" || facts.overPopoutDocument;

  return intoPopout && holdsFramePanel(facts.dragged);
}

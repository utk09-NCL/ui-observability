// src/workspace/layout-store.ts
//
// Saves the dockview layout of each user and tenant in localStorage, and restores it. A saved
// layout can be missing, damaged by an edit or old, so each read checks the shape and each
// restore has a fallback. The page must open with the default layout and never crash.

import type { SerializedDockview } from "dockview-react";
import { isFramePanel } from "./frame-panels";

const KEY_PREFIX = "react-workspace.layout";
// A new number makes every older saved layout read as "corrupt", so the default layout opens.
const FORMAT_VERSION = 1;
const SAVE_DELAY_MS = 250;

export type SavedLayout =
  | { status: "none" }
  | { status: "corrupt"; reason: string }
  | { status: "ok"; layout: SerializedDockview };

/** The part of the dockview API that a restore needs. A spec passes a fake. */
export interface LayoutApi {
  fromJSON(data: SerializedDockview): void;
  clear(): void;
}

/**
 * Returns the storage key of a user and a tenant.
 * @param user The user name.
 * @param tenant The tenant id.
 * @returns The key.
 */
export function layoutKey(user: string, tenant: string): string {
  // encodeURIComponent encodes ":", so a user or a tenant that holds one can't move the border.
  return `${KEY_PREFIX}:${encodeURIComponent(user)}:${encodeURIComponent(tenant)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the fields that dockview needs before it reads a layout. dockview checks the rest when
 * fromJSON() runs, and restoreLayout() handles a throw from there.
 */
function isSerializedDockview(value: unknown): value is SerializedDockview {
  return isRecord(value) && isRecord(value.grid) && isRecord(value.panels);
}

/**
 * Reads the layout of a user and a tenant. A blocked store, bad JSON and a wrong shape give a
 * "corrupt" result and no throw.
 * @param user The user name.
 * @param tenant The tenant id.
 * @returns The saved layout, or the reason that there is none.
 */
export function readLayout(user: string, tenant: string): SavedLayout {
  let text: string | null;
  try {
    text = localStorage.getItem(layoutKey(user, tenant));
  } catch {
    // A private window or blocked site data. The page then opens with the default layout.
    return { status: "corrupt", reason: "The browser storage is not readable." };
  }

  if (text === null) {
    return { status: "none" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "corrupt", reason: "The saved text is not JSON." };
  }

  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION) {
    return { status: "corrupt", reason: "The saved layout has another format version." };
  }
  if (!isSerializedDockview(parsed.layout)) {
    return { status: "corrupt", reason: "The saved layout has no grid or no panels." };
  }

  return { status: "ok", layout: parsed.layout };
}

/**
 * Saves the layout of a user and a tenant. A failed write keeps the layout for this page only.
 * @param user The user name.
 * @param tenant The tenant id.
 * @param layout The result of toJSON().
 */
export function writeLayout(user: string, tenant: string, layout: SerializedDockview): void {
  try {
    localStorage.setItem(
      layoutKey(user, tenant),
      JSON.stringify({ version: FORMAT_VERSION, layout }),
    );
  } catch {
    // The layout then lasts until the page closes. Nothing else depends on the store.
  }
}

/**
 * Removes the saved layout of a user and a tenant.
 * @param user The user name.
 * @param tenant The tenant id.
 */
export function removeLayout(user: string, tenant: string): void {
  try {
    localStorage.removeItem(layoutKey(user, tenant));
  } catch {
    // Nothing to remove when the store is blocked.
  }
}

/**
 * Removes the saved layouts of a user in every tenant. A shared-device logout uses it, because
 * the next user of the device must find no trace of the layouts of this one.
 * @param user The user name.
 */
export function removeUserLayouts(user: string): void {
  const prefix = `${KEY_PREFIX}:${encodeURIComponent(user)}:`;
  try {
    // Collect first. Removing a key while the loop runs would skip the key after it.
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  } catch {
    // Nothing to remove when the store is blocked.
  }
}

/** Collects the panel ids of each group in a node of the grid of a popout window. */
function gridViews(node: unknown): string[] {
  if (!isRecord(node)) {
    return [];
  }
  if (Array.isArray(node.data)) {
    return node.data.flatMap(gridViews);
  }

  return isRecord(node.data) && Array.isArray(node.data.views)
    ? node.data.views.filter((view): view is string => typeof view === "string")
    : [];
}

/**
 * Removes the frame panels from the saved popout groups. dockview opens each saved popout window
 * again, and a frame panel there loads in a new browsing context, where its runtime finds no
 * owner. A group that holds only frame panels goes away. A popout window with a nested grid and a
 * frame panel goes away as a whole, because pruning the grid would need new sizes. The input is
 * not changed. A layout without such a group comes back as it is.
 * @param layout The saved layout.
 * @returns A layout that opens no frame panel in a popout window.
 */
export function withoutFramePopouts(layout: SerializedDockview): SerializedDockview {
  if (!layout.popoutGroups?.length) {
    return layout;
  }

  // A view can name a panel that the map lacks, because the saved text may be old or edited.
  const states: Partial<Record<string, { contentComponent?: string }>> = layout.panels;
  const isFrame = (id: string): boolean =>
    isFramePanel(id) || isFramePanel(states[id]?.contentComponent);
  const removed = new Set<string>();
  const kept: NonNullable<SerializedDockview["popoutGroups"]> = [];

  for (const popout of layout.popoutGroups) {
    const ids = popout.data ? popout.data.views : gridViews(popout.grid?.root);
    if (!ids.some(isFrame)) {
      kept.push(popout);

      continue;
    }

    for (const id of ids.filter(isFrame)) {
      removed.add(id);
    }
    if (popout.data) {
      const views = popout.data.views.filter((id) => !isFrame(id));
      if (views.length > 0) {
        const active = popout.data.activeView;
        kept.push({
          ...popout,
          data: {
            ...popout.data,
            views,
            activeView: active !== undefined && views.includes(active) ? active : views[0],
          },
        });
      }
    } else {
      // The other panels of a nested popout window go too, so the panels map keeps no orphan.
      for (const id of ids) {
        removed.add(id);
      }
    }
  }

  if (removed.size === 0) {
    return layout;
  }

  const result: SerializedDockview = {
    ...layout,
    panels: Object.fromEntries(Object.entries(layout.panels).filter(([id]) => !removed.has(id))),
    popoutGroups: kept,
  };
  if (kept.length === 0) {
    delete result.popoutGroups;
  }

  return result;
}

export type RestoreOutcome = "restored" | "default" | "fallback";

/**
 * Opens the saved layout, or the default one. A layout that dockview refuses, for example one
 * that names a panel component that no longer exists, leaves the page with the default layout.
 * @param api The dockview API.
 * @param saved The result of readLayout().
 * @param addDefaults Adds the panels of the default layout to an empty dockview.
 * @param report Called with the reason when a saved layout could not open.
 * @returns How the layout opened.
 */
export function restoreLayout(
  api: LayoutApi,
  saved: SavedLayout,
  addDefaults: () => void,
  report: (reason: string) => void,
): RestoreOutcome {
  if (saved.status === "ok") {
    try {
      api.fromJSON(withoutFramePopouts(saved.layout));

      return "restored";
    } catch (error) {
      report(error instanceof Error ? error.message : "dockview refused the saved layout.");
    }
  } else if (saved.status === "corrupt") {
    report(saved.reason);
  }

  // A failed fromJSON() can leave some groups behind, so start from an empty dockview.
  api.clear();
  addDefaults();

  return saved.status === "none" ? "default" : "fallback";
}

export interface LayoutSaver {
  /** Saves after a short quiet time. Dockview fires many events during one drag. */
  schedule(): void;
  /** Saves now, for example before a logout. */
  flush(): void;
  /** Stops the saver for good. A later schedule() does nothing. */
  dispose(): void;
}

/**
 * Creates the saver of one layout. Dockview fires the change event many times during a drag or
 * a sash move, so the saver writes once after the events stop.
 * @param read Returns the layout to save.
 * @param write Stores it.
 * @returns The saver.
 */
export function createLayoutSaver(
  read: () => SerializedDockview,
  write: (layout: SerializedDockview) => void,
): LayoutSaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const save = (): void => {
    timer = undefined;
    if (closed) {
      return;
    }

    write(read());
  };

  return {
    schedule() {
      if (closed) {
        return;
      }

      clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    },
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      save();
    },
    dispose() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

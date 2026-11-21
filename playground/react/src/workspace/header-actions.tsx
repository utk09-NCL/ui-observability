// src/workspace/header-actions.tsx
//
// The buttons at the right end of each group header: open in a new window, maximize, float and
// popout. A floating group and a popout group get a "Dock" button that moves the panels back into
// the grid.

import { type ReactElement, useEffect, useState } from "react";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { WINDOW_PANELS } from "../panel-window/protocol";
import { useWorkspace } from "./context";
import { holdsFramePanel } from "./frame-panels";
import type { PanelId } from "./default-layout";
import { openPanelWindow } from "./panel-windows";

/**
 * Renders the header buttons of one group.
 * @param props The group, its API and the dockview API.
 * @returns The buttons.
 */
export function HeaderActions({
  api,
  containerApi,
  group,
  activePanel,
  panels,
}: IDockviewHeaderActionsProps): ReactElement {
  const { session } = useWorkspace();
  // A frame in a popout window loads again with a parent that has no runtime, so a group with a
  // frame panel has no "Pop out" button. See frame-panels.ts.
  const canPopOut = !holdsFramePanel(panels);
  const windowPanel = WINDOW_PANELS.find((id: PanelId) => id === activePanel?.id);
  const [maximized, setMaximized] = useState(api.isMaximized());
  const [location, setLocation] = useState(api.location.type);

  useEffect(() => {
    const maximizeSub = containerApi.onDidMaximizedGroupChange(() => {
      setMaximized(api.isMaximized());
    });
    const locationSub = api.onDidLocationChange(() => {
      setLocation(api.location.type);
    });

    return () => {
      maximizeSub.dispose();
      locationSub.dispose();
    };
  }, [api, containerApi]);

  // dockview tells the workspace when the browser blocks the window, and workspace.tsx logs it.
  const popout = (): void => {
    void containerApi.addPopoutGroup(group);
  };

  return (
    <div className="header-actions">
      {windowPanel && (
        <button
          type="button"
          className="icon-button"
          aria-label="Open panel in new window"
          title="Open this panel in a new window with its own runtime"
          data-observability-action="panel-window"
          onClick={() => {
            // A window that the browser blocks logs a WARN record, see openPanelWindow().
            openPanelWindow(windowPanel, { user: session.user, tenant: session.tenant });
          }}
        >
          {"\u25A3"}
        </button>
      )}
      {location === "grid" && (
        <button
          type="button"
          className="icon-button"
          aria-label={maximized ? "Restore group" : "Maximize group"}
          title={maximized ? "Restore" : "Maximize"}
          data-observability-action="group-maximize"
          onClick={() => {
            if (maximized) {
              api.exitMaximized();
            } else {
              api.maximize();
            }
          }}
        >
          {maximized ? "❐" : "□"}
        </button>
      )}
      {location === "grid" && (
        <>
          <button
            type="button"
            className="icon-button"
            aria-label="Float group"
            title="Float"
            data-observability-action="group-float"
            onClick={() => {
              containerApi.addFloatingGroup(group, { width: 460, height: 340, x: 90, y: 90 });
            }}
          >
            {"⧉"}
          </button>
          {canPopOut && (
            <button
              type="button"
              className="icon-button"
              aria-label="Pop out group"
              title="Pop out into a new window"
              data-observability-action="group-popout"
              onClick={popout}
            >
              {"↗"}
            </button>
          )}
        </>
      )}
      {location !== "grid" && (
        <button
          type="button"
          className="icon-button"
          aria-label="Dock group"
          title="Move back into the grid"
          data-observability-action="group-dock"
          onClick={() => {
            api.moveTo({ position: "right" });
          }}
        >
          {"↓"}
        </button>
      )}
    </div>
  );
}

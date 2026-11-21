// src/workspace/header-actions.tsx
//
// The buttons at the right end of each group header: maximize, float and popout. A floating
// group and a popout group get a "Dock" button that moves the panels back into the grid.

import { type ReactElement, useEffect, useState } from "react";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { getLogger } from "@utk09/ui-observability";

const log = getLogger("workspace.layout");

/**
 * Renders the header buttons of one group.
 * @param props The group, its API and the dockview API.
 * @returns The buttons.
 */
export function HeaderActions({
  api,
  containerApi,
  group,
}: IDockviewHeaderActionsProps): ReactElement {
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

  const popout = (): void => {
    void containerApi.addPopoutGroup(group).then((opened) => {
      if (!opened) {
        log.warn("The browser did not open the popout window. Allow popups for this site.");
      }
    });
  };

  return (
    <div className="header-actions">
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

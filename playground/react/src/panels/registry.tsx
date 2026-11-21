// src/panels/registry.tsx
//
// The panel components of the workspace, by component name. Each one sits in its own error
// boundary. React sends a render error to the nearest boundary and not to window.onerror, so
// without the boundary the library never sees it, and one broken panel would take down the page.

import type { FunctionComponent, ReactElement } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ObservabilityErrorBoundary } from "../observability/react";
import type { PanelId } from "../workspace/default-layout";
import { ActivityPanel } from "./activity-panel";
import { BlotterPanel } from "./blotter-panel";
import { ObservabilityPanel } from "./observability-panel";
import { PositionsPanel } from "./positions-panel";
import { PricesPanel } from "./prices-panel";
import { TicketPanel } from "./ticket-panel";

/**
 * Wraps a panel in a boundary that logs a render error in the namespace of the panel.
 * @param id The panel id.
 * @param Panel The panel component.
 * @returns A component for the dockview registry.
 */
function guarded(id: PanelId, Panel: FunctionComponent): FunctionComponent<IDockviewPanelProps> {
  return function GuardedPanel(): ReactElement {
    return (
      <ObservabilityErrorBoundary
        namespace={`panel.${id}`}
        fallback={
          <p role="alert">
            This panel broke, and the library logged it. Close it and open it again.
          </p>
        }
      >
        <Panel />
      </ObservabilityErrorBoundary>
    );
  };
}

// One object for the page. dockview reads the registry when it makes a panel, so a new object on
// each render would only be work.
export const PANEL_COMPONENTS: Record<PanelId, FunctionComponent<IDockviewPanelProps>> = {
  prices: guarded("prices", PricesPanel),
  ticket: guarded("ticket", TicketPanel),
  blotter: guarded("blotter", BlotterPanel),
  positions: guarded("positions", PositionsPanel),
  activity: guarded("activity", ActivityPanel),
  settings: guarded("settings", ObservabilityPanel),
};

// src/workspace/watermark.tsx
//
// What the workspace shows when it has no panel.

import type { ReactElement } from "react";
import type { IWatermarkPanelProps } from "dockview-react";
import { addDefaultPanels, openPanel, PANELS } from "./default-layout";

/**
 * Renders the watermark, with a button for each panel and one for the default layout.
 * @param props The dockview API.
 * @returns The watermark.
 */
export function Watermark({ containerApi }: IWatermarkPanelProps): ReactElement {
  return (
    <div className="watermark">
      <h2>No panel is open</h2>
      <p className="muted">Open a panel, or bring back the default layout.</p>
      <div className="controls">
        {PANELS.map((panel) => (
          <button
            key={panel.id}
            type="button"
            onClick={() => {
              openPanel(containerApi, panel.id);
            }}
          >
            {panel.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            addDefaultPanels(containerApi);
          }}
        >
          Default layout
        </button>
      </div>
    </div>
  );
}

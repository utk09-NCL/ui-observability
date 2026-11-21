// src/panels/research-panel.tsx
//
// The Research panel: a same-origin frame. The workspace registers it with registerFrame() before
// it loads. The frame forwards its records over the bus, under the namespace research.frame.

import type { ReactElement } from "react";
import { FramePanel, type FrameRegistration } from "./frame-panel";

// journey:read lets the frame read the journey of the workspace, so its records carry it. The
// frame asks for the journey when it starts, and a registration without the permission makes the
// bus reject that request and count bus.rejected_message.
const REGISTRATION: FrameRegistration = {
  origin: location.origin,
  permissions: ["records", "journey:read"],
};

/**
 * Renders the Research panel.
 * @returns The panel.
 */
export function ResearchPanel(): ReactElement {
  return (
    <FramePanel title="Research" src="/research.html" registration={REGISTRATION}>
      <p className="muted">
        This frame is on the origin of the workspace. The workspace registers it before it loads.
        Click <strong>Log an action</strong> in the frame, then <strong>Reload frame</strong>, then
        click again. The records arrive in both cases, so the bus link comes back.
      </p>
    </FramePanel>
  );
}

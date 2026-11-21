// src/panels/partner-panel.tsx
//
// The Partner widget panel: a frame from another origin, port 5174 by default. The workspace
// registers the window at that exact origin. The widget lists the origin of the workspace in its
// own bus.trustedOrigins, because a cross-origin frame posts its hello only to a trusted origin.
// Both sides name each other, and neither one uses a wildcard.

import type { ReactElement } from "react";
import { FramePanel, type FrameRegistration } from "./frame-panel";

// The page of the widget. The vite.cross-origin.config.ts server serves it from the repository.
// The smoke test sets another origin, so it runs its own copy of that server.
const PARTNER_ORIGIN = String(import.meta.env.VITE_PARTNER_ORIGIN ?? "http://localhost:5174");
const PARTNER_PAGE = `${PARTNER_ORIGIN}/playground/vanilla/partner.html`;

const REGISTRATION: FrameRegistration = {
  origin: PARTNER_ORIGIN,
  permissions: ["records", "journey:read"],
};

/**
 * Renders the Partner widget panel.
 * @returns The panel.
 */
export function PartnerPanel(): ReactElement {
  return (
    <FramePanel
      title="Partner widget"
      src={PARTNER_PAGE}
      registration={REGISTRATION}
      // allow-same-origin keeps the origin of the widget. Without it the frame would get an opaque
      // origin, and the bus can't forward for it. The sandbox still blocks popups, forms and top
      // navigation.
      sandbox="allow-scripts allow-same-origin"
    >
      <p className="muted">
        The widget runs on <code>{PARTNER_ORIGIN}</code>. The workspace registers that origin. The
        widget trusts the origin of the workspace in <code>bus.trustedOrigins</code>. Start the
        widget server with <code>pnpm run example:react</code>.
      </p>
    </FramePanel>
  );
}

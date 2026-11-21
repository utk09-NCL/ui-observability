// src/panels/untrusted-panel.tsx
//
// The Untrusted widget panel. The widget comes from another origin, the one of the partner
// widget, and the workspace never registers its window. The widget lists the origin of the
// workspace in its own bus.trustedOrigins, so it posts its hello to the workspace when it loads.
// The bus accepts only registered sources by default, so it rejects the hello. The panel shows the
// counters of the bus diagnostics, and they go up with each load of the frame.
//
// The widget is on another origin, so it can't read the DOM of the workspace or wrap its
// functions. A same-origin frame can do both, also when the app does not register it.

import { type ReactElement, useEffect, useState } from "react";
import { getDiagnosticCounters } from "@utk09/ui-observability";
import { FramePanel } from "./frame-panel";
import { PARTNER_ORIGIN } from "./partner-origin";

const POLL_MS = 500;
const UNTRUSTED_PAGE = `${PARTNER_ORIGIN}/playground/vanilla/untrusted.html`;

/** Returns the counters of the bus diagnostics. */
function busCounters(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(getDiagnosticCounters()).filter(([code]) => code.startsWith("bus.")),
  );
}

function same(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);

  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Renders the Untrusted widget panel.
 * @returns The panel.
 */
export function UntrustedPanel(): ReactElement {
  const [counters, setCounters] = useState<Record<string, number>>(busCounters);

  // The local timer is safe under StrictMode. The state changes only when a counter changed.
  useEffect(() => {
    const timer = setInterval(() => {
      const next = busCounters();
      setCounters((previous) => (same(previous, next) ? previous : next));
    }, POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <FramePanel
      title="Untrusted widget"
      src={UNTRUSTED_PAGE}
      // No registration, on purpose. The sandbox is the one of the partner frame. allow-same-origin
      // keeps the origin of the widget, and the widget origin differs from the workspace origin.
      sandbox="allow-scripts allow-same-origin"
    >
      <p className="muted">
        The widget runs on <code>{PARTNER_ORIGIN}</code>. The workspace does not register its
        window. The widget lists the origin of the workspace in <code>bus.trustedOrigins</code>, so
        it posts its hello when it loads, and the bus rejects the hello. The counters of the bus
        diagnostics go up. Click <strong>Reload frame</strong> to see it again. The widget then
        sends for itself. It has no endpoint, so it sends nothing.
      </p>
      <p>
        Rejected bus messages:{" "}
        <strong data-testid="rejected-messages">{counters["bus.rejected_message"] ?? 0}</strong>
      </p>
      <ul className="diagnostics" aria-label="Bus diagnostic counters">
        {Object.entries(counters).map(([code, count]) => (
          <li key={code}>
            <code>{code}</code> {count}
          </li>
        ))}
      </ul>
    </FramePanel>
  );
}

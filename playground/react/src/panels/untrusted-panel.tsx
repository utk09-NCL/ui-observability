// src/panels/untrusted-panel.tsx
//
// The Untrusted widget panel. The frame is not registered. It tries to join the bus when it
// loads, and the bus accepts only registered sources by default, so it rejects the frame. The
// panel shows the counters of the bus diagnostics, and they go up with each load of the frame.

import { type ReactElement, useEffect, useState } from "react";
import { getDiagnosticCounters } from "@utk09/ui-observability";
import { FramePanel } from "./frame-panel";

const POLL_MS = 500;

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
    <FramePanel title="Untrusted widget" src="/untrusted.html">
      <p className="muted">
        The workspace does not register this frame. The frame tries to join the bus when it loads,
        and the bus rejects it, so the counters of the bus diagnostics go up. Click{" "}
        <strong>Reload frame</strong> to see it again. The frame then sends its own records. It has
        no endpoint, so they go nowhere.
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

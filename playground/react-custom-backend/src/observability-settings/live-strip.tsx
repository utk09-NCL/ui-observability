// src/observability-settings/live-strip.tsx
//
// A strip that reads getHealth() once a second. getHealth() has no byte count, so the strip
// shows records and batches, not bytes.

import { type ReactElement, useEffect, useState } from "react";
import {
  getDiagnosticCounters,
  getHealth,
  type ObservabilityHealth,
} from "@utk09/ui-observability";
import { readDiagnostics, readTap, type TappedDiagnostic } from "./tap";

const POLL_MS = 1000;
const MS_PER_SECOND = 1000;
const SHOWN_DIAGNOSTICS = 5;

interface Live {
  health: ObservabilityHealth;
  counters: Record<string, number>;
  built: number;
  /** Records built each second, or null until the second poll has a window to measure. */
  builtPerSecond: number | null;
  diagnostics: readonly TappedDiagnostic[];
}

function formatCounts(counts: Record<string, number | undefined>): string {
  const parts = Object.entries(counts).map(([name, count]) => `${name} ${String(count)}`);

  return parts.length === 0 ? "none" : parts.join(", ");
}

/**
 * Shows the delivery state of the library, and how fast the app builds records.
 * @returns The strip.
 */
export function LiveStrip(): ReactElement {
  const [live, setLive] = useState<Live | null>(null);

  // The local cleanup is safe under StrictMode, which runs this effect twice in development.
  useEffect(() => {
    let active = true;
    let lastBuilt: number | undefined;
    let lastAt = 0;

    const poll = async (): Promise<void> => {
      // Read the tap and the clock before the await. getHealth() takes a moment, and a count
      // that is read after it would not match the time that it is divided by.
      const { built } = readTap();
      const now = performance.now();
      const health = await getHealth();
      if (!active) {
        return;
      }

      // The first poll has no window, so it shows no rate. A zero window would give NaN.
      const builtPerSecond =
        lastBuilt === undefined || now <= lastAt
          ? null
          : Math.round(((built - lastBuilt) * MS_PER_SECOND) / (now - lastAt));
      lastBuilt = built;
      lastAt = now;
      setLive({
        health,
        counters: getDiagnosticCounters(),
        built,
        builtPerSecond,
        diagnostics: readDiagnostics().slice(-SHOWN_DIAGNOSTICS),
      });
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, POLL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (!live) {
    return <p className="muted">Reading the library state.</p>;
  }

  const { delivery, status } = live.health;

  return (
    <div className="live" role="group" aria-label="Live state of the library">
      <dl className="strip">
        <div>
          <dt>Status</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>Records built per second</dt>
          <dd>{live.builtPerSecond ?? "-"}</dd>
        </div>
        <div>
          <dt>Records built</dt>
          <dd>{live.built}</dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>{delivery.pending}</dd>
        </div>
        <div>
          <dt>In flight</dt>
          <dd>{delivery.inFlight}</dd>
        </div>
        <div>
          <dt>Stored batches</dt>
          <dd>{delivery.stored}</dd>
        </div>
        <div>
          <dt>Dropped</dt>
          <dd>{formatCounts(delivery.dropped)}</dd>
        </div>
        <div className="wide">
          <dt>Diagnostics</dt>
          <dd>{formatCounts(live.counters)}</dd>
        </div>
      </dl>
      <p className="muted">
        Records built counts what the processors see. That includes a record that only the console
        or a breadcrumb uses, so it can be more than the records sent.
      </p>
      {live.diagnostics.length > 0 && (
        <ul className="diagnostics" aria-label="Last diagnostic reports">
          {live.diagnostics.map((item) => (
            <li key={item.id}>
              <code>{item.code}</code> {item.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

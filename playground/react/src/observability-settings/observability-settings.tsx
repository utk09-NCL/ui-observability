// src/observability-settings/observability-settings.tsx
//
// The whole section: the live strip, the settings table and the cost meter. The recent records
// have their own panel in this app, so they are not part of the section.

import type { ReactElement } from "react";
import { CostMeter } from "./cost-meter";
import { LiveStrip } from "./live-strip";
import type { Settings } from "./settings";
import { SettingsPanel } from "./settings-panel";

/**
 * Renders the section that changes the config and shows what each choice costs.
 * @param props `onRestart` stops the library and starts it again with the given settings.
 * @returns The section.
 */
export function ObservabilitySettings({
  onRestart,
}: {
  onRestart: (settings: Settings) => Promise<void>;
}): ReactElement {
  return (
    <section aria-labelledby="observability-heading" className="card">
      <h2 id="observability-heading">Observability settings</h2>
      <LiveStrip />
      <SettingsPanel onRestart={onRestart} />
      <CostMeter />
    </section>
  );
}

// src/panels/activity-panel.tsx
//
// The records that the app emits, from the processor tap. A change of minLevel or of a sampling
// rate in the settings panel shows here at once, because the tap sees each record that the
// library builds, and the setting decides which records it builds.

import type { ReactElement } from "react";
import { RecentRecords } from "../observability-settings/recent-records";

/**
 * Renders the recent records.
 * @returns The panel.
 */
export function ActivityPanel(): ReactElement {
  return (
    <section className="panel" aria-label="Activity log">
      <p className="muted">
        The records that the library built in this page, newest first. Change the lowest level or
        the keep rate of <code>market.prices</code> in the settings panel and watch the list.
      </p>
      <RecentRecords />
    </section>
  );
}

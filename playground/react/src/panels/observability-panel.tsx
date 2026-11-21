// src/panels/observability-panel.tsx
//
// The "Observability settings" panel of the workspace. The section lives in
// observability-settings/, and this wrapper gives it the restart function of the app.

import type { ReactElement } from "react";
import { restartObservability } from "../observability/user-context";
import { ObservabilitySettings } from "../observability-settings/observability-settings";

/**
 * Renders the settings section.
 * @returns The panel.
 */
export function ObservabilityPanel(): ReactElement {
  return (
    <div className="panel panel-settings">
      <ObservabilitySettings onRestart={restartObservability} />
    </div>
  );
}

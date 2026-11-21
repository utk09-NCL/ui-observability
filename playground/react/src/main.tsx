import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configure } from "@utk09/ui-observability";
import { App } from "./app";
import { buildConfig } from "./observability/config";
import { getSettingsState } from "./observability-settings/settings-store";
import { applyTheme, loadTheme } from "./workspace/theme";

// Module scope, before render, one time. A call in a component would run on each render, and
// StrictMode would run it twice.
configure(buildConfig(getSettingsState().applied, "anonymous"));
// The theme is set before the first paint, so a light user doesn't see a dark flash.
applyTheme(loadTheme());

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing #root");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

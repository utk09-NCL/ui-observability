// src/frames/research.ts
//
// The page of the Research panel. It is a same-origin frame of the workspace. The workspace
// registers it with registerFrame() before it loads, so the frame forwards its records to the
// workspace, which batches them and runs its redact hook on them. The frame logs under its own
// namespace, research.frame.

import { configure, getLogger } from "@utk09/ui-observability";
import { loadConsent } from "../observability/consent";
import { onOrigin } from "../observability-settings/app-routes";
import { element, showBusRole } from "./frame-page";

// The frame names the endpoint of the page. A frame that finds no owner sends its own records
// there. That happens when the workspace runs paused, because a runtime that is paused starts no
// bus. A user who withdrew the telemetry consent must not get records from a frame, so the frame
// reads the same stored choice as the workspace and starts paused too.
configure({
  serviceName: "react-workspace-research",
  serviceVersion: "0.0.0",
  environment: "local",
  endpoint: onOrigin("/telemetry/v1/logs"),
  enabled: loadConsent().telemetry,
  onDiagnostic: showBusRole(element("#role"), element("#note")),
});

const log = getLogger("research.frame");

element("#log").addEventListener("click", () => {
  // The record arrives in the workspace with the context of the frame, and the sender is the
  // workspace. The data-observability-action attribute names the click of the workspace.
  log.logAction("RESEARCH_VIEWED", { note: "EURUSD outlook" });
});

element("#fail").addEventListener("click", () => {
  log.error("research frame failed", new Error("The research service did not answer."));
});

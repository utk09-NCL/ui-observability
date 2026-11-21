// src/frames/research.ts
//
// The page of the Research panel. It is a same-origin frame of the workspace. The workspace
// registers it with registerFrame() before it loads, so the frame forwards its records to the
// workspace, which batches them and runs its redact hook on them. The frame logs under its own
// namespace, research.frame.
//
// The frame has no endpoint, so a frame that finds no owner sends nothing. That happens when the
// workspace runs paused, because a paused runtime starts no bus, and while the workspace
// restarts its runtime. A frame can't be sure that its parent follows the consent of the user, so
// it never sends around the parent.

import { configure, getLogger } from "@utk09/ui-observability";
import { element, showBusRole } from "./frame-page";

configure({
  serviceName: "react-workspace-research",
  serviceVersion: "0.0.0",
  environment: "local",
  onDiagnostic: showBusRole(element("#role"), element("#note")),
});

const log = getLogger("research.frame");

element("#log").addEventListener("click", () => {
  // The record arrives in the workspace with the context of the frame, and the sender is the
  // workspace.
  log.logAction("RESEARCH_VIEWED", { note: "EURUSD outlook" });
});

element("#fail").addEventListener("click", () => {
  log.error("research frame failed", new Error("The research service did not answer."));
});

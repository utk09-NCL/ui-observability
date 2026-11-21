// src/frames/untrusted.ts
//
// The page of the Untrusted widget. The workspace never registers this frame. The frame is on the
// same origin, and it tries to join the bus of the workspace when it loads. The bus accepts only
// registered sources, so it rejects the frame, and its diagnostic counter goes up. The frame then
// becomes its own sender. It has no endpoint, so it sends nothing.

import { configure, getLogger } from "@utk09/ui-observability";
import { element, showBusRole } from "./frame-page";

configure({
  serviceName: "react-workspace-untrusted",
  serviceVersion: "0.0.0",
  environment: "local",
  onDiagnostic: showBusRole(element("#role"), element("#note")),
});

const log = getLogger("untrusted.widget");
let sent = 0;

element("#send").addEventListener("click", () => {
  sent += 1;
  log.info("A record of the untrusted widget", { number: sent });
  element("#sent").textContent = String(sent);
});

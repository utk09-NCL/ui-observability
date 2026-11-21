// playground/vanilla/partner.ts
//
// The partner widget of the React FX workspace, a page on another origin (port 5174). The vanilla
// playground may load the library source, so the page lives here and not in the React example,
// which imports the package. The workspace embeds this page and registers its window at the exact
// origin of this page. This page lists the origins of the workspace in bus.trustedOrigins, so it
// accepts the welcome of the workspace and posts its hello only to those origins. The widget has
// no endpoint, so it sends nothing when it finds no owner. A widget of another team can't read
// the consent of the user in the workspace, and it must not send around it.

import { configure, getLogger } from "../../src/index";

// The origins that may embed this widget: the dev server of the workspace, and its smoke test.
const WORKSPACE_ORIGINS = ["http://localhost:5180", "http://localhost:5187"];

/**
 * Finds an element by selector and throws if it is missing.
 * @param selector CSS selector.
 * @returns The element.
 */
const el = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`partner widget: no element matches ${selector}`);
  }

  return found;
};

const roleEl = el("#role");
const noteEl = el("#note");

configure({
  serviceName: "react-workspace-partner",
  serviceVersion: "0.0.0-dev",
  environment: "local",
  bus: { trustedOrigins: WORKSPACE_ORIGINS },
  onDiagnostic: (event) => {
    if (event.code === "bus.role_resolved" && typeof event.detail?.role === "string") {
      roleEl.textContent = event.detail.role;
    }
    if (event.code.startsWith("bus.")) {
      noteEl.textContent = `${event.code}: ${event.message}`;
    }
  },
});

const log = getLogger("partner.widget");

el("#partner-log").addEventListener("click", () => {
  // The record reaches the workspace over the message link and goes out in its batch.
  log.logAction("PARTNER_CLICK", { at: Date.now() });
});

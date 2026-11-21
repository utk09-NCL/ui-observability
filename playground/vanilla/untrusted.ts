// playground/vanilla/untrusted.ts
//
// The untrusted widget of the React FX workspace, a page on another origin (port 5174). The
// workspace embeds this page and does not register its window. The widget lists the origins of
// the workspace in bus.trustedOrigins, so it posts its hello to them when it loads. The bus of
// the workspace accepts only registered sources, so it rejects the hello and counts it. The widget
// then becomes its own sender. It has no endpoint, so it sends nothing.

import { configure, getLogger } from "../../src/index";

// The origins of the workspace: the dev server, and its smoke test.
const WORKSPACE_ORIGINS = ["http://localhost:5180", "http://localhost:5187"];

/**
 * Finds an element by selector and throws if it is missing.
 * @param selector CSS selector.
 * @returns The element.
 */
const el = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`untrusted widget: no element matches ${selector}`);
  }

  return found;
};

const roleEl = el("#role");
const noteEl = el("#note");

configure({
  serviceName: "react-workspace-untrusted",
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

const log = getLogger("untrusted.widget");

el("#untrusted-send").addEventListener("click", () => {
  log.info("A record of the untrusted widget", { at: Date.now() });
});

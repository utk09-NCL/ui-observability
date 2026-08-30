// playground/vanilla/child.ts
//
// The iframe half of the harness. A child document forwards its records to the
// nearest long-lived owner, which batches and posts them. Nothing here says
// "forwarder": the runtime resolves that on its own and reports it.

import { configure, getLogger, startJourney } from "../../src/index";

const INGEST_ENDPOINT = "http://localhost:8787/v1/logs";

/**
 * Queries a DOM element by selector, throwing if missing.
 * @param selector CSS selector string.
 * @returns Matched DOM element.
 */
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`playground child: no element matches ${selector}`);
  }
  return found;
};

const roleEl = el("#role");

let role = "resolving";
let lastNote = "";

/** Renders the resolved role and the most recent diagnostic into the frame. */
const render = (): void => {
  roleEl.textContent = lastNote ? `${role} (${lastNote})` : role;
};

/**
 * Records the most recent diagnostic for display.
 * @param code Diagnostic event code.
 * @param message Event description.
 */
const note = (code: string, message: string): void => {
  lastNote = `${code}: ${message}`;
  render();
};

// The child uses the same endpoint as the parent. A forwarder never posts, but
// an empty endpoint raises config.invalid and makes the frame look broken on
// the day it promotes itself to sender. The bus mode stays unpinned: which role
// it resolves to is the thing under test.
configure({
  endpoint: INGEST_ENDPOINT,
  serviceName: "playground-child",
  serviceVersion: "0.0.0-dev",
  environment: "local",
  minLevel: "DEBUG",
  // Mirrors every record to the devtools console at its own level.
  console: { enabled: true, level: "DEBUG" },
  onDiagnostic: (event) => {
    // bus.role_resolved carries the resolved role, which is the frame's readout.
    if (event.code === "bus.role_resolved" && typeof event.detail?.role === "string") {
      role = event.detail.role;
    }

    note(event.code, event.message);
  },
});

/** Namespaced logger for records this frame emits by hand. */
const log = getLogger("playground.child");

el("#child-log").addEventListener("click", () => {
  // Arrives in the parent's request carrying this frame's context id and the
  // parent's tab id. That pairing is the evidence.
  log.logAction("CHILD_CLICK", { at: Date.now() });
});

el("#child-journey").addEventListener("click", () => {
  // A same-origin child shares sessionStorage with its parent, so this
  // overwrites the parent's journey. Intended: a journey belongs to the user's
  // task, not to the document that started it.
  const started = startJourney("started-in-the-child");
  note("playground.journey", `started ${started.name}`);
});

render();

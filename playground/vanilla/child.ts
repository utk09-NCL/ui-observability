// playground/vanilla/child.ts
//
// The iframe half of the harness. A child document forwards its records to the
// nearest long-lived owner, normally the top window, which batches and posts
// them. Proving that is the point of this file.
//
// It imports nothing yet, for the same reason main.ts does not: naming an
// absent export fails at module link time and leaves the frame dead.
//
// Two details of the eventual configure call that get written wrong:
//
//   1. The child uses the SAME endpoint as the parent
//      ("http://localhost:8787/v1/logs"). A forwarder never posts, so it looks
//      redundant, but an empty endpoint raises config.invalid and makes the
//      frame look broken on the day it promotes itself to sender.
//   2. The child does NOT pin its bus mode. Which role it resolves to is the
//      thing under test. Trusted origins are the parent's concern: the
//      receiver decides whose messages it believes.
//
// Once the bus exists, the diagnostics callback writes the resolved role and
// transport into #role. Until then the role is genuinely unresolved and the
// text says so, rather than reading "resolving" forever.
//
// The `export {}` at the bottom is load-bearing: with no import and no export,
// tsc treats this file and main.ts as one global scope and reports TS2451.

// Same as main.ts: name the missing selector rather than assert it away.
// Duplicated instead of pulling a third file into a two-file harness.
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`playground child: no element matches ${selector}`);
  }
  return found;
};

const roleEl = el("#role");
const baseRole = "unresolved, the bus does not exist yet";

const showChildState = (detail: string) => {
  roleEl.textContent = detail ? `${baseRole} (${detail})` : baseRole;
};

showChildState("");

el("#child-log").addEventListener("click", () => {
  // Final form: log.logAction("CHILD_CLICK", { at: Date.now() })
  // The record should arrive in the parent's request carrying this frame's
  // context id and the parent's tab id. That pairing is the evidence.
  showChildState(`CHILD_CLICK at ${String(Date.now())}, waiting on the bus to forward it`);
});
el("#child-journey").addEventListener("click", () => {
  // Final form: startJourney("started-in-the-child")
  // A same-origin child shares sessionStorage with its parent, so this
  // overwrites the parent's journey. Intended: a journey belongs to the
  // user's task, not to the document that started it.
  showChildState("startJourney: waiting on the journey engine and the bus");
});

// Once forwarding works, a heartbeat shows records arriving in the parent
// without clicking anything:
//
//   setInterval(() => log.debug("child heartbeat", getDiagnosticCounters()), 1000);
//
// A comment for now: there are no counters to read, and a timer firing into a
// dead handler is noise on a page whose success condition is silence.

export {};

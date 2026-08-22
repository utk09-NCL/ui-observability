// playground/vanilla/child.ts
//
// The iframe half of the harness. A child document does not send its own
// records: it forwards them to the nearest long-lived owner, normally the top
// window, which batches and posts them. Proving that is the point of this file.
//
// It imports nothing today, for the same reason main.ts does not: src/index.ts
// exports nothing yet, and named imports of exports that do not exist fail at
// module link time, leaving the frame dead rather than merely quiet.
//
// Two details of the eventual configure call are the ones that get written
// wrong, so they are recorded here rather than rediscovered later:
//
//   1. The child configures with the SAME endpoint as the parent
//      ("http://localhost:8787/v1/logs"). A forwarder never posts, so the
//      endpoint looks redundant, but an empty one raises config.invalid and
//      makes the frame look broken for the wrong reason on the day it does
//      promote itself to sender.
//   2. The child deliberately does NOT pin its bus mode. Which role this frame
//      resolves to is the thing under test, so hard-coding it removes the
//      test. Trusted origins are the parent's concern, not the child's: the
//      receiver is what decides whose messages it believes.
//
// Once the bus exists, the diagnostics callback listens for a role_resolved
// event and writes the resolved role and the transport it resolved through
// into #role. Until then the role genuinely is unresolved, and the text below
// says so rather than leaving the markup reading "resolving" forever, which
// would be a lie that outlives whoever wrote it.
//
// The `export {}` at the bottom is load-bearing. With no import and no export,
// tsc treats this file and main.ts as global scripts sharing one scope and
// reports TS2451 on their top level consts.

// Same reasoning as main.ts: name the missing selector instead of asserting it
// away. The two files share no module, so this helper is duplicated rather
// than pulling a third file into a two-file harness for four lines.
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
  // The bus is what carries that record into the parent's request, where it
  // should arrive tagged with this frame's own context id but the parent's
  // tab id. That pairing is the evidence forwarding actually happened.
  showChildState(`CHILD_CLICK at ${String(Date.now())}, waiting on the bus to forward it`);
});
el("#child-journey").addEventListener("click", () => {
  // Final form: startJourney("started-in-the-child")
  // A same-origin child shares sessionStorage with its parent, so starting a
  // journey here overwrites the parent's. That is intended: a journey is a
  // property of the user's task, not of the document that happened to start
  // it, and every window on the origin should adopt it.
  showChildState("startJourney: waiting on the journey engine and the bus");
});

// Once forwarding works, a heartbeat here lets you watch records arrive in the
// parent without clicking anything:
//
//   setInterval(() => log.debug("child heartbeat", getDiagnosticCounters()), 1000);
//
// It stays a comment for now. There are no counters to read, and a timer
// firing every second into a dead handler is noise on a page whose success
// condition is that it stays quiet.

export {};

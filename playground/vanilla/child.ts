// playground/vanilla/child.ts
//
// The iframe half of the harness. A child document forwards its records to the
// nearest long-lived owner, which batches and posts them.

import { Bus } from "../../src/bus/bus";
import { resolveConfig } from "../../src/core/config";
import { ContextStore } from "../../src/core/context";
import { Diagnostics } from "../../src/core/diagnostics";
import { JourneyEngine } from "../../src/core/journey";
import { type BuildInput, RecordBuilder } from "../../src/core/record";
import { resolveIdentity } from "../../src/utils/identity";
import { detectPlatform } from "../../src/utils/platform";
import { Sequence } from "../../src/utils/sequence";
import { TraceEngine } from "../../src/utils/tracing";

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

/**
 * Normalizes caught errors into string messages.
 * @param err Unknown caught error.
 * @returns Formatted message string.
 */
const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const diagnostics = new Diagnostics((event) => {
  note(event.code, event.message);
});

// The child uses the same endpoint as the parent. A forwarder never posts, but
// an empty endpoint raises config.invalid and makes the frame look broken on
// the day it promotes itself to sender. The bus mode stays unpinned: which role
// it resolves to is the thing under test.
const config = resolveConfig(
  {
    endpoint: INGEST_ENDPOINT,
    serviceName: "playground-child",
    serviceVersion: "0.0.0-dev",
    environment: "local",
    minLevel: "DEBUG",
  },
  diagnostics,
);

const identity = resolveIdentity(diagnostics);
const platform = detectPlatform(diagnostics);

let bus: Bus | null = null;

const journey = new JourneyEngine(config.journey, diagnostics, identity.contextId, (changed) => {
  bus?.broadcastJourney(changed);
});

const builder = new RecordBuilder({
  config,
  diagnostics,
  context: new ContextStore(),
  journey,
  tracing: new TraceEngine(diagnostics),
  sequence: new Sequence(),
  identity,
  platform,
});

bus = new Bus(config, diagnostics, platform, identity.contextId, identity.tabId, {
  // Only reached if this frame promoted itself to sender, which it cannot act
  // on: a child builds no transport of its own.
  onRecords: (records) => {
    note("playground.child_orphaned", `${String(records.length)} record(s) with nowhere to go`);
  },
  onJourney: (incoming) => {
    journey.applyRemote(incoming);
  },
  onJourneyRequest: () => journey.current(),
  onTabConflict: () => {
    note("playground.tab_conflict", "another context claimed this tab id");
  },
});

bus
  .start()
  .then((resolved) => {
    role = resolved;
    render();
  })
  .catch((error: unknown) => {
    note("playground.bus_failed", toMessage(error));
  });

journey.bootstrap().catch((error: unknown) => {
  note("playground.bootstrap_failed", toMessage(error));
});

/**
 * Builds a record and hands it to the owner that batches it.
 * @param input Build options and payload.
 */
const forward = (input: BuildInput): void => {
  const record = builder.build(input);
  if (record === null) {
    note("playground.dropped", "produced no record");
    return;
  }

  bus.sendRecords([record]);
};

el("#child-log").addEventListener("click", () => {
  // Arrives in the parent's request carrying this frame's context id and the
  // parent's tab id. That pairing is the evidence.
  forward({
    level: "INFO",
    type: "action",
    body: "CHILD_CLICK",
    namespace: "playground.child",
    payload: { at: Date.now() },
  });
});

el("#child-journey").addEventListener("click", () => {
  // A same-origin child shares sessionStorage with its parent, so this
  // overwrites the parent's journey. Intended: a journey belongs to the user's
  // task, not to the document that started it.
  const started = journey.start("started-in-the-child");
  note("playground.journey", `started ${started.name}`);
});

render();

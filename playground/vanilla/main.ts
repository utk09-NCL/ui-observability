// playground/vanilla/main.ts
//
// The development harness for the library in ../../src. It is deliberately the
// only thing in this repository that imports the source tree directly rather
// than the built package, which is exactly why the framework examples are
// barred from doing the same: they exist to prove the published API is usable
// from outside, and a deep import would prove nothing.
//
// Right now it imports nothing at all, because src/index.ts exports nothing
// yet. Writing the intended imports ahead of the code fails two ways, and the
// second is the one that costs an afternoon:
//
//   1. tsc reports TS2305, "has no exported member 'configure'".
//   2. The browser fails at module link time, before any of this evaluates,
//      with "does not provide an export named 'configure'". The page then
//      loads dead and the diagnostics box below is empty for the wrong
//      reason: not because nothing went wrong, but because the script that
//      reports what went wrong never ran.
//
// So every button is wired and no click is a silent no-op. Handlers that need
// library code which does not exist yet print what they are waiting for, and
// carry their intended final form in a comment directly above them.
//
// One configuration line belongs with the second iframe in index.html and is
// easy to lose, so it is recorded here for whoever writes the real configure
// call:
//
//   bus: { trustedOrigins: [location.origin, "http://localhost:5174", "http://127.0.0.1:5174"] }
//
// The receiver decides whose bus messages it believes. The cross-origin child
// on 127.0.0.1:5174 cannot read window.parent, so it forwards over postMessage
// instead, and if its origin is missing from that list every record it sends
// is rejected with a bus.untrusted_origin diagnostic naming the origin.
//
// The `export {}` at the bottom is load-bearing. With no import and no export,
// tsc treats this file and child.ts as global scripts sharing one scope and
// reports TS2451 on their top level consts.

// A missing element means the harness itself is broken, so name the selector
// and fail loudly. That is worth four lines to avoid a non-null assertion,
// which would instead surface as "cannot read properties of null" on the first
// click, pointing at the symptom rather than the cause.
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`playground: no element matches ${selector}`);
  }
  return found;
};

const out = el("#diagnostics");

// The stand-in for the library's own diagnostics callback: same shape, same
// prepend, so swapping it for a real configure({ onDiagnostic }) is mechanical.
// Nothing calls it during module evaluation, because an empty diagnostics box
// on load is the signal that the harness came up clean.
const note = (code: string, message: string) => {
  out.textContent = `${new Date().toISOString()}  ${code}  ${message}\n${out.textContent}`;
};

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const on = (id: string, fn: () => void) => {
  el(`#${id}`).addEventListener("click", fn);
};

on("info", () => {
  // Final form: log.info("hello from the playground", { clicked: true })
  note("playground.deferred", "info: waiting on the record builder and the public logger");
});
on("action", () => {
  // Final form: log.logAction("ORDER_SUBMIT", { orderId: "ORD-1001", qty: 100 })
  note("playground.deferred", "logAction: waiting on the record builder and the public logger");
});
on("metric", () => {
  // Final form: log.logMetric("grid.render", 42.5, "ms", "histogram")
  note("playground.deferred", "logMetric: waiting on the metrics stream and the public logger");
});
on("error", () => {
  // Final form: log.error("something went wrong", new Error("boom"))
  note("playground.deferred", "logger.error: waiting on the record builder and the public logger");
});

on("journey-start", () => {
  // Final form: startJourney("order-lifecycle")
  note("playground.deferred", "startJourney: waiting on the journey engine and the public API");
});
on("journey-end", () => {
  // Final form: endJourney()
  note("playground.deferred", "endJourney: waiting on the journey engine and the public API");
});
on("open-window", () => {
  // Live: opening the window needs nothing from the library. Seeding the
  // journey is the half that does not exist yet. Once the journey engine and
  // its token accessor exist, this handler writes the token into an
  // __uiobs_journey search parameter before opening, and the new window
  // adopts that journey instead of starting its own.
  const url = new URL("/playground/vanilla/index.html", location.href);
  window.open(url, "_blank");
});

on("throw", () => {
  // Live, and it currently reaches the browser console and stops there.
  // Automatic error capture is what turns an uncaught throw into a record.
  setTimeout(() => {
    throw new Error("uncaught from a timeout");
  });
});
on("reject", () => {
  // Live. Same as above: automatic rejection capture is what turns an
  // unhandled rejection into a record.
  void Promise.reject(new Error("nobody caught me"));
});
on("fetch-500", () => {
  // Live: it hits the mock server and needs nothing from the library.
  // Automatic network capture is what wraps window.fetch and turns the
  // failed response into a record.
  void fetch("http://localhost:8787/does-not-exist")
    .then((res) => {
      note("playground.fetch_done", `mock server answered ${String(res.status)}`);
    })
    .catch((err: unknown) => {
      note("playground.fetch_failed", toMessage(err));
    });
});
on("circular", () => {
  // Final form: log.info("circular payload", a)
  // The payload is built for real, so this button is ready to prove the
  // sanitizer survives a cycle and a DOM node the moment one exists.
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  a.el = document.body;
  note(
    "playground.deferred",
    `circular payload built with ${String(Object.keys(a).length)} keys: waiting on the sanitizer and the record builder`,
  );
});

on("burst", () => {
  // Final form: for (let i = 0; i < 250; i++) log.debug(`burst ${i}`, { i })
  // The point of the burst is to prove batching coalesces it and that the
  // durable queue survives a server that is refusing writes.
  note("playground.deferred", "burst of 250: waiting on batching and the durable queue");
});

// The most useful live button on the page today. It drives the mock server's
// control plane end to end, which is the half of the system that already
// exists, and it is how you make the server refuse writes to test durability.
// Once the logger exists, the note below becomes a real log.warn.
let failing = false;
on("offline", () => {
  failing = !failing;
  const control = `http://localhost:8787/__control?status=${failing ? "503&retryAfter=3" : "200"}`;
  // Not an async handler. addEventListener takes a void-returning listener,
  // so an async one hands it a floating promise nothing can await, which
  // no-misused-promises rejects and which swallows rejections at runtime.
  // The explicit chain is the same behaviour without the trap.
  void fetch(control, { method: "POST" })
    .then(() => {
      note("playground.server_forced", `server forced failure: ${String(failing)}`);
    })
    .catch((err: unknown) => {
      note("playground.control_failed", toMessage(err));
    });
});

export {};

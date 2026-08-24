// playground/vanilla/main.ts
//
// The development harness for the library in ../../src, and the only thing here
// that imports the source tree rather than the built package. The framework
// examples must not: they exist to prove the published API works from outside.
//
// It imports nothing yet, because src/index.ts exports nothing. Naming an
// absent export fails at module link time, before any of this evaluates, and
// the page then loads dead with an empty diagnostics box: the script that
// reports failures never ran. So every button is wired, and handlers waiting on
// library code print what they wait for and carry a `// Final form:` comment.
//
// For whoever writes the real configure call, the line that goes with the
// second iframe in index.html:
//
//   bus: { trustedOrigins: [location.origin, "http://localhost:5174", "http://127.0.0.1:5174"] }
//
// The receiver decides whose bus messages it believes. The cross-origin child
// cannot read window.parent, so it forwards over postMessage, and an origin
// missing from that list is rejected with bus.untrusted_origin.
//
// The `export {}` at the bottom is load-bearing: with no import and no export,
// tsc treats this file and child.ts as one global scope and reports TS2451.

// A missing element means the harness is broken, so name the selector and fail
// loudly. A non-null assertion instead surfaces as "cannot read properties of
// null" on the first click, pointing at the symptom.
const el = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`playground: no element matches ${selector}`);
  }
  return found;
};

const out = el("#diagnostics");

// Stand-in for the library's diagnostics callback: same shape, so swapping it
// for a real configure({ onDiagnostic }) is mechanical. Nothing calls it during
// module evaluation: an empty box on load means the harness came up clean.
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
  // Live: opening the window needs nothing from the library. Seeding does.
  // Once the journey engine has a token accessor, this writes the token into
  // an __uiobs_journey search parameter and the new window adopts it.
  const url = new URL("/playground/vanilla/index.html", location.href);
  window.open(url, "_blank");
});

on("throw", () => {
  // Live. Reaches the browser console and stops there until error capture
  // turns an uncaught throw into a record.
  setTimeout(() => {
    throw new Error("uncaught from a timeout");
  });
});
on("reject", () => {
  // Live. Same as above, waiting on rejection capture.
  void Promise.reject(new Error("nobody caught me"));
});
on("fetch-500", () => {
  // Live: hits the mock server directly. Network capture is what wraps
  // window.fetch and turns the failed response into a record.
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
  // The payload is built for real, ready to prove the sanitizer survives a
  // cycle and a DOM node.
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
  // Proves batching coalesces the burst and the durable queue survives a
  // server refusing writes.
  note("playground.deferred", "burst of 250: waiting on batching and the durable queue");
});

// Drives the mock server's control plane end to end. This is how you make the
// server refuse writes to test durability. The note becomes a real log.warn
// once the logger exists.
let failing = false;
on("offline", () => {
  failing = !failing;
  const control = `http://localhost:8787/__control?status=${failing ? "503&retryAfter=3" : "200"}`;
  // Not an async handler: addEventListener takes a void-returning listener, so
  // an async one leaves a floating promise that swallows rejections, which
  // no-misused-promises rejects. The chain is the same behaviour without it.
  void fetch(control, { method: "POST" })
    .then(() => {
      note("playground.server_forced", `server forced failure: ${String(failing)}`);
    })
    .catch((err: unknown) => {
      note("playground.control_failed", toMessage(err));
    });
});

export {};

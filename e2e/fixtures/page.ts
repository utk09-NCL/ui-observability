// e2e/fixtures/page.ts
//
// The page that every browser test loads, as the top document and as a child frame. It puts
// the library on window.e2e and configures nothing, so each test's configure() call sits next
// to the assertions that depend on it.

import * as uiobs from "../../src/index";
import { WORKER_SENDS_CHANNEL } from "./worker-channel";

/** What the page hands to a test's page.evaluate() callback. */
interface E2eHandle {
  /** The library's public entry point, loaded from src/ through Vite. */
  uiobs: typeof uiobs;
  /** Every diagnostic this document reported, oldest first. */
  diagnostics: uiobs.DiagnosticEvent[];
  /** Pass this as onDiagnostic to fill `diagnostics`. */
  onDiagnostic: (event: uiobs.DiagnosticEvent) => void;
  /** The browser's own fetch, kept so a test can tell when the fetch capture has replaced it. */
  nativeFetch: typeof fetch;
  /** Every URL the transport worker fetched, oldest first. */
  workerSends: string[];
  /** Pass this as transportWorker for a worker that serves the library's protocol. */
  startWorker: () => Worker;
  /** Pass this as transportWorker for a worker that never answers ready. */
  startSilentWorker: () => Worker;
  /** Pass this as replay.loader. It loads the real recorder, the optional peer. */
  loadRecorder: uiobs.ReplayLoader;
  /** Pass this as capture.webVitals.loader. It loads the real web-vitals, the optional peer. */
  loadWebVitals: NonNullable<uiobs.WebVitalsOptions["loader"]>;
}

declare global {
  interface Window {
    e2e: E2eHandle;
  }
}

const diagnostics: uiobs.DiagnosticEvent[] = [];
const workerSends: string[] = [];

// The worker can't write to the page, so it announces each fetch on this channel instead.
const sends = new BroadcastChannel(WORKER_SENDS_CHANNEL);
sends.addEventListener("message", (event: MessageEvent<string>) => {
  workerSends.push(event.data);
});

window.e2e = {
  uiobs,
  diagnostics,
  onDiagnostic: (event) => {
    diagnostics.push(event);
  },
  // Read at page load, which is before any test calls configure().
  nativeFetch: globalThis.fetch,
  workerSends,
  // Vite only bundles a worker that is created with this exact `new URL` form.
  startWorker: () =>
    new Worker(new URL("./transport-worker.ts", import.meta.url), { type: "module" }),
  startSilentWorker: () =>
    new Worker(new URL("./silent-worker.ts", import.meta.url), { type: "module" }),
  // A test can't import the peer by name inside page.evaluate(), so the page owns the import.
  loadRecorder: () => import("@rrweb/record"),
  // The same reason as the recorder: page.evaluate() can't import the peer by name.
  loadWebVitals: () => import("web-vitals"),
};

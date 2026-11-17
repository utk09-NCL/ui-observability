// e2e/fixtures/transport-worker.ts
//
// The transport worker of the browser tests. It serves the library's protocol and announces
// each fetch, so a test can tell a batch the worker sent from one the page sent itself.

import { serveTransportWorker } from "../../src/index";
import { WORKER_SENDS_CHANNEL } from "./worker-channel";

const sends = new BroadcastChannel(WORKER_SENDS_CHANNEL);
const pageFetch = globalThis.fetch;

// Both paths post the same body to the same URL, so the server can't tell them apart.
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  sends.postMessage(url);

  return pageFetch(input, init);
};

serveTransportWorker();

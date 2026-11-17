// e2e/fixtures/worker-channel.ts
//
// The name that the transport worker and the test page share.

/** BroadcastChannel on which the transport worker announces each URL it fetches. */
export const WORKER_SENDS_CHANNEL = "e2e-worker-sends";

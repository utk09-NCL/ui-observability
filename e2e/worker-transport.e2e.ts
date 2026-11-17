// e2e/worker-transport.e2e.ts
//
// With `transportWorker`, a dedicated worker posts the batches. A worker that never answers
// ready must not hold the records back, so the library falls back to plain HTTP.

import { expect, test } from "@playwright/test";
import { LOGS_ENDPOINT, PAGE_PATH, readLogs, resetIngest, stopLibrary } from "./fixtures/ingest";

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

test("sends a batch through the transport worker", async ({ page }) => {
  await page.goto(PAGE_PATH);

  await page.evaluate(async (endpoint) => {
    const { configure, flush, getLogger } = window.e2e.uiobs;
    configure({ endpoint, serviceName: "e2e-app", transportWorker: window.e2e.startWorker });
    getLogger("worker").info("sent by the worker");
    await flush();
  }, LOGS_ENDPOINT);

  await expect.poll(() => readLogs("sent by the worker")).toHaveLength(1);
  // The worker fixture announces each URL it fetches. The page's own fetch announces nothing.
  await expect.poll(() => page.evaluate(() => window.e2e.workerSends)).toEqual([LOGS_ENDPOINT]);
});

test("falls back to plain HTTP when the worker never answers ready", async ({ page }) => {
  await page.goto(PAGE_PATH);

  await page.evaluate(async (endpoint) => {
    const { configure, flush, getLogger } = window.e2e.uiobs;
    configure({
      endpoint,
      serviceName: "e2e-app",
      transportWorker: window.e2e.startSilentWorker,
      // The library waits one request timeout for the ready answer. The default is too long
      // for a test.
      delivery: { requestTimeoutMs: 1_000 },
      onDiagnostic: window.e2e.onDiagnostic,
    });
    getLogger("worker").info("sent after the fallback");
    await flush();
  }, LOGS_ENDPOINT);

  await expect.poll(() => readLogs("sent after the fallback")).toHaveLength(1);

  const reported = await page.evaluate(() =>
    window.e2e.diagnostics.map((event) => ({ code: event.code, message: event.message })),
  );
  // The diagnostic tells the app developer why the worker isn't in use.
  expect(reported).toContainEqual({
    code: "transport.http_error",
    message: "The transport worker request failed.",
  });
  // A worker that isn't ready is a dead channel, not a slow send. A transport.timeout here
  // would mean the batch went to the retry queue and not to plain HTTP.
  expect(reported.map((event) => event.code)).not.toContain("transport.timeout");
});

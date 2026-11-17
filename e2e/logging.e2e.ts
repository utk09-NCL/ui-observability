// e2e/logging.e2e.ts
//
// The shortest real path: a logger call in a page becomes one OTLP record at /v1/logs.

import { expect, test } from "@playwright/test";
import { LOGS_ENDPOINT, PAGE_PATH, readLogs, resetIngest, stopLibrary } from "./fixtures/ingest";

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

test("delivers a logger call to /v1/logs with its body, level and attributes", async ({ page }) => {
  await page.goto(PAGE_PATH);

  await page.evaluate(async (endpoint) => {
    const { configure, flush, getLogger } = window.e2e.uiobs;
    configure({ endpoint, serviceName: "e2e-app", serviceVersion: "1.2.3", environment: "e2e" });
    getLogger("checkout").info("order placed", { orderId: "ORD-1", qty: 3 });
    await flush();
  }, LOGS_ENDPOINT);

  await expect.poll(() => readLogs("order placed")).toHaveLength(1);
  const [log] = await readLogs("order placed");

  expect(log).toMatchObject({
    scope: "checkout",
    severityText: "INFO",
    attributes: {
      orderId: "ORD-1",
      qty: 3,
      "log.type": "log",
      "app.namespace": "checkout",
    },
    resource: {
      "service.name": "e2e-app",
      "service.version": "1.2.3",
      "deployment.environment": "e2e",
    },
  });
  expect(log.traceId).toMatch(/^[0-9a-f]{32}$/);
  // One record with its resource is above the 1,024-byte threshold, so the body travels as gzip.
  expect(log.contentEncoding).toBe("gzip");
});

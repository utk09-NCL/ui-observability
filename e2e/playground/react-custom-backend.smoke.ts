// e2e/playground/react-custom-backend.smoke.ts
//
// Smoke test of playground/react-custom-backend in Chromium. It logs in, places an order and
// reads what the mock ingest server received, then changes a setting in the panel.

import { expect, test, type Page } from "@playwright/test";
import { APP_API_ORIGIN, INGEST_ORIGIN } from "./ports";

interface UilogsRecord {
  message: string;
  journeyId?: string;
  attributes: Record<string, unknown>;
}

interface Received {
  "/uilogs": {
    hasAuthorization: boolean;
    payload: { service: string; records: UilogsRecord[] };
  }[];
  "/v1/traces": {
    payload: { resourceSpans?: { scopeSpans?: { spans?: { name: string; kind?: number }[] }[] }[] };
  }[];
  "/v1/metrics": {
    payload: {
      resourceMetrics?: {
        scopeMetrics?: {
          metrics?: {
            name: string;
            sum?: { dataPoints?: { asInt?: string | number; asDouble?: number }[] };
          }[];
        }[];
      }[];
    };
  }[];
}

async function post(url: string): Promise<void> {
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new Error(`${url} answered ${String(response.status)}`);
  }
}

async function readReceived(): Promise<Received> {
  const response = await fetch(`${INGEST_ORIGIN}/__received`);

  return (await response.json()) as Received;
}

/** Returns the ORDER_PLACED records that the uilogs backend got for one order. */
async function placedRecords(orderId: string): Promise<UilogsRecord[]> {
  const received = await readReceived();

  return received["/uilogs"]
    .flatMap((request) => request.payload.records)
    .filter((record) => record.message === "ORDER_PLACED" && record.attributes.orderId === orderId);
}

/** Adds up the counter points that the OTLP metrics endpoint got for one counter. */
async function countedPoints(name: string): Promise<number> {
  const received = await readReceived();
  let total = 0;
  for (const request of received["/v1/metrics"]) {
    for (const resource of request.payload.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          for (const point of metric.sum?.dataPoints ?? []) {
            total += metric.name === name ? Number(point.asInt ?? point.asDouble ?? 0) : 0;
          }
        }
      }
    }
  }

  return total;
}

async function logIn(page: Page, user: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("User name").fill(user);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

/** Places an order and returns its id, once the blotter shows it as filled. */
async function placeAndFill(page: Page, qty: string): Promise<string> {
  await page.getByLabel("Quantity").fill(qty);
  await page.getByRole("button", { name: "Place order" }).click();
  const text = await page.getByText(/^Order ORD-\d+ placed\.$/).textContent();
  const orderId = /ORD-\d+/.exec(text ?? "")?.[0] ?? "";
  const row = page.getByRole("row", { name: new RegExp(orderId) });
  // The mock API fills an order after about 1.5 seconds and pushes it on the stream.
  await expect(row).toContainText("filled", { timeout: 10_000 });

  return orderId;
}

/**
 * Fails when the library lost a batch because the backend refused it. A 400 from /uilogs makes
 * the library drop the batch with the reason "rejected", and the live strip shows the reason.
 */
async function expectNoRejectedBatch(page: Page): Promise<void> {
  // The strip reads getHealth() once a second.
  await page.waitForTimeout(1500);
  const dropped = page.locator(".strip div").filter({ hasText: "Dropped" });

  await expect(dropped).not.toContainText("rejected");
}

test.beforeEach(async () => {
  await post(`${INGEST_ORIGIN}/__reset`);
  await post(`${APP_API_ORIGIN}/api/__reset`);
});

test("places an order and the backends get its records", async ({ page }) => {
  await logIn(page, "smoke-user");
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const orderId = await placeAndFill(page, "250");

  // The log batch waits up to 2 seconds for its flush.
  await expect
    .poll(async () => (await placedRecords(orderId)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const placed = (await placedRecords(orderId)).at(0);
  expect(placed?.journeyId).toEqual(expect.any(String));
  expect(placed?.attributes).toMatchObject({ qty: 250, pair: "EURUSD", tenant: "tenant-a" });

  // The headers function sent the token of the user to the custom backend.
  const received = await readReceived();
  const withToken = received["/uilogs"].filter((request) =>
    request.payload.records.some((record) => record.attributes.orderId === orderId),
  );
  expect(withToken.every((request) => request.hasAuthorization)).toBe(true);

  // The POST /api/orders call is a client span, because the app sets propagateTraceHeaderTo.
  await expect
    .poll(
      async () =>
        (await readReceived())["/v1/traces"]
          .flatMap((request) => request.payload.resourceSpans ?? [])
          .flatMap((resource) => resource.scopeSpans ?? [])
          .flatMap((scope) => scope.spans ?? [])
          .filter((span) => span.name === "POST").length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  await expectNoRejectedBatch(page);
});

test("applies a runtime setting at once", async ({ page }) => {
  const lines: string[] = [];
  page.on("console", (message) => {
    lines.push(message.text());
  });
  await logIn(page, "smoke-user");

  // Console output is on and the price stream logs at DEBUG, so lines arrive all the time.
  await expect
    .poll(() => lines.filter((line) => line.includes("market.prices")).length)
    .toBeGreaterThan(0);

  await page.getByLabel("Console output", { exact: true }).selectOption("off");

  // Four pairs tick four times a second. A silent second and a half means the console is off.
  lines.length = 0;
  await page.waitForTimeout(1500);
  expect(lines.filter((line) => line.includes("market.prices"))).toEqual([]);
});

test("keeps logging and counting after a restart", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page, "smoke-user");
  await placeAndFill(page, "100");

  // A limit is fixed after startup, so the panel stages the change.
  await page.getByLabel("Deepest object").selectOption({ label: "3 levels" });
  const row = page.getByRole("row").filter({ has: page.getByLabel("Deepest object") });
  await expect(row).toContainText("Staged. Needs restart");
  await page.getByRole("button", { name: /Apply and restart/ }).click();
  await expect(page.getByText("Restarted. The new settings are in force.")).toBeVisible();

  // The logger and the metric handles of the first order were made before the restart.
  const orderId = await placeAndFill(page, "321");
  await expect
    .poll(async () => (await placedRecords(orderId)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const placed = (await placedRecords(orderId)).at(0);
  expect(placed?.attributes).toMatchObject({ qty: 321, tenant: "tenant-a" });

  // Both orders count in orders.placed. A point arrives about 10 seconds after its value.
  await expect.poll(() => countedPoints("orders.placed"), { timeout: 40_000 }).toBe(2);

  await expectNoRejectedBatch(page);
});

test("logs out one time on a double click", async ({ page }) => {
  let logouts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/logout")) {
      logouts += 1;
    }
  });
  await logIn(page, "smoke-user");

  // The button is disabled while the logout runs, and a second logout would find no token.
  await page.getByRole("button", { name: "Log out" }).dblclick();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();

  // A second logout would start after the first one ended, so give it time to show up.
  await page.waitForTimeout(1500);

  expect(logouts).toBe(1);
});

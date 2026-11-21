// e2e/playground/react.smoke.ts
//
// Smoke test of playground/react, the FX workspace, in Chromium. It logs in, checks the default
// layout, places an order and reads what the mock ingest server received. It changes a setting
// and watches the Activity log, and it checks that the layout survives a reload and that a
// damaged saved layout falls back to the default.

import { expect, test, type Page } from "@playwright/test";
import { APP_API_ORIGIN, INGEST_ORIGIN, REACT_ORIGIN } from "./ports";

// The page and the servers are separate origins. The app calls its API and its log backend
// through the proxy of its dev server, so the browser sees one origin.
test.use({ baseURL: REACT_ORIGIN });

const DEFAULT_TABS = [
  "Prices",
  "Order ticket",
  "Blotter",
  "Positions",
  "Activity log",
  "Observability settings",
];

interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
}

interface OtlpLogRecord {
  body?: { stringValue?: string };
  attributes?: { key: string; value: OtlpValue }[];
}

interface Received {
  "/v1/logs": {
    payload: {
      resourceLogs?: {
        resource?: { attributes?: { key: string; value: OtlpValue }[] };
        scopeLogs?: { logRecords?: OtlpLogRecord[] }[];
      }[];
    };
  }[];
  "/v1/traces": {
    payload: { resourceSpans?: { scopeSpans?: { spans?: { name: string }[] }[] }[] };
  }[];
}

interface Seen {
  service: string;
  body: string;
  attributes: Record<string, string | number | undefined>;
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

function plain(value: OtlpValue): string | number | undefined {
  return value.stringValue ?? value.doubleValue ?? (value.intValue ? Number(value.intValue) : 0);
}

/** Flattens the OTLP log batches that the ingest server received into one list of records. */
async function receivedRecords(): Promise<Seen[]> {
  const received = await readReceived();
  const seen: Seen[] = [];
  for (const request of received["/v1/logs"]) {
    for (const resource of request.payload.resourceLogs ?? []) {
      const service = resource.resource?.attributes?.find((item) => item.key === "service.name");
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          seen.push({
            service: service?.value.stringValue ?? "",
            body: record.body?.stringValue ?? "",
            attributes: Object.fromEntries(
              (record.attributes ?? []).map((item) => [item.key, plain(item.value)]),
            ),
          });
        }
      }
    }
  }

  return seen;
}

async function logIn(page: Page, user: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("User name").fill(user);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("tab", { name: "Prices" })).toBeVisible();
}

function tabs(page: Page): Promise<string[]> {
  return page.getByRole("tab").allTextContents();
}

async function logOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^trader1, / }).click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
}

test.beforeEach(async () => {
  await post(`${INGEST_ORIGIN}/__reset`);
  await post(`${APP_API_ORIGIN}/api/__reset`);
});

test("opens the default layout, places an order and the backends get its records", async ({
  page,
}) => {
  await logIn(page, "smoke-user");
  expect(await tabs(page)).toEqual(DEFAULT_TABS);

  await page.getByLabel("Quantity").fill("250");
  await page.getByRole("button", { name: "Place order" }).click();
  const text = await page.getByText(/^Order ORD-\d+ placed\.$/).textContent();
  const orderId = /ORD-\d+/.exec(text ?? "")?.[0] ?? "";
  // The mock API fills an order after about 1.5 seconds and pushes it on the stream.
  await expect(page.getByRole("row", { name: new RegExp(orderId) })).toContainText("filled", {
    timeout: 10_000,
  });

  // The log batch waits up to 2 seconds for its flush.
  await expect
    .poll(async () => (await receivedRecords()).filter((r) => r.body === "ORDER_PLACED").length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const placed = (await receivedRecords()).find((record) => record.body === "ORDER_PLACED");
  expect(placed?.service).toBe("react-workspace");
  expect(placed?.attributes).toMatchObject({
    orderId,
    qty: 250,
    pair: "EURUSD",
    tenant: "tenant-a",
    "journey.name": "place-order",
  });
  expect(placed?.attributes["journey.id"]).toEqual(expect.any(String));

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

  // The fill makes the panel read the positions, and the worker logs what it received. The page
  // registered the worker, so the page sends that record.
  await expect
    .poll(
      async () =>
        (await receivedRecords()).filter(
          (record) =>
            record.service === "react-workspace-positions" && record.body === "positions received",
        ).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});

test("shows a change of the lowest level in the Activity log at once", async ({ page }) => {
  await logIn(page, "smoke-user");

  // Show only the price ticks. Each tick is a DEBUG record of the namespace market.prices.
  await page.getByLabel("Namespace contains").fill("market.prices");
  await page.getByLabel("Hide market.prices").uncheck();
  const newest = page.locator("ol.recent li time").first();
  await expect(newest).toBeVisible();
  const first = await newest.textContent();
  await expect.poll(() => newest.textContent()).not.toBe(first);

  // The console prints the DEBUG record too, and the library builds a record for it. So the
  // lowest level alone doesn't stop the list. Console output goes off first.
  await page.getByRole("tab", { name: "Observability settings" }).click();
  await page.getByLabel("Console output", { exact: true }).selectOption("off");
  await page.getByLabel("Lowest level sent").selectOption("WARN");

  // The list keeps polling while its tab is hidden. A silent second and a half means that the
  // library builds no tick record any more.
  await page.getByRole("tab", { name: "Activity log" }).click();
  await page.waitForTimeout(1000);
  const stopped = await page.locator("ol.recent li time").first().textContent();
  await page.waitForTimeout(1500);
  expect(await page.locator("ol.recent li time").first().textContent()).toBe(stopped);

  // The value goes back and the ticks come back.
  await page.getByRole("tab", { name: "Observability settings" }).click();
  await page.getByLabel("Lowest level sent").selectOption("DEBUG");
  await page.getByRole("tab", { name: "Activity log" }).click();
  await expect
    .poll(() => page.locator("ol.recent li time").first().textContent())
    .not.toBe(stopped);
});

test("keeps the layout after a reload, and opens the default layout when the saved one is damaged", async ({
  page,
}) => {
  await logIn(page, "smoke-user");
  await page.getByLabel("Close Prices").click();
  await expect(page.getByRole("tab", { name: "Prices" })).toHaveCount(0);
  // The saver writes 250 ms after the last change.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("react-workspace.layout:"))
          .some(
            (key) => !(localStorage.getItem(key) ?? "").includes('"contentComponent":"prices"'),
          ),
      ),
    )
    .toBe(true);

  await page.reload();
  await page.getByLabel("User name").fill("smoke-user");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("tab", { name: "Order ticket" })).toBeVisible();
  expect(await tabs(page)).toEqual(DEFAULT_TABS.filter((name) => name !== "Prices"));

  // Another tenant of the same user has its own layout, and it starts with the default one.
  await page.getByRole("button", { name: /^smoke-user, / }).click();
  await page.getByRole("menuitem", { name: "Beta Partners" }).click();
  await expect(page.getByRole("button", { name: /^smoke-user, Beta Partners/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Prices" })).toBeVisible();
  expect(await tabs(page)).toEqual(DEFAULT_TABS);

  // A damaged layout of the first tenant does not crash the page.
  await page.getByRole("button", { name: /^smoke-user, / }).click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("react-workspace.layout:smoke-user:tenant-a", "{not json");
  });
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("tab", { name: "Prices" })).toBeVisible();
  expect(await tabs(page)).toEqual(DEFAULT_TABS);
});

test("logs out on a shared device and removes the saved layouts of the user", async ({ page }) => {
  await logIn(page, "trader1");
  await page.getByRole("button", { name: /^trader1, / }).click();
  await page.getByRole("menuitem", { name: "Log out on a shared device" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();

  const layouts = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("react-workspace.layout:")),
  );
  expect(layouts).toEqual([]);

  // The shared-device logout starts a new anonymous runtime, and the next login works with it.
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("tab", { name: "Prices" })).toBeVisible();
  await logOut(page);
});

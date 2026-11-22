// e2e/playground/react.smoke.ts
//
// Smoke test of playground/react, the FX workspace, in Chromium. It logs in, checks the default
// layout, places an order and reads what the mock ingest server received. It changes a setting
// and watches the Activity log, and it checks that the layout survives a reload and that a
// damaged saved layout falls back to the default. It also checks the three frames and the bus,
// the replay of a refused order, the token refresh and the window of one panel.

import { expect, test, type Locator, type Page } from "@playwright/test";
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
    /** True when the server had this batch id already. The records of such a request count once. */
    duplicate?: boolean;
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
    // A batch that the library sent twice would double each count that a test reads.
    if (request.duplicate) {
      continue;
    }

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

/** Opens a panel through the "Add panel" menu. */
async function addPanel(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: /^Add panel/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${title}`) }).click();
  await expect(page.getByRole("tab", { name: title })).toBeVisible();
}

/** Counts the records of one service with one text that the ingest server received. */
async function countRecords(service: string, body: string): Promise<number> {
  return (await receivedRecords()).filter(
    (record) => record.service === service && record.body === body,
  ).length;
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

test("keeps the layout after a reload, and opens the default one for a damaged layout", async ({
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

test("registers the three frames, and the bus rejects the one that it does not know", async ({
  page,
}) => {
  await logIn(page, "smoke-user");
  await addPanel(page, "Research");
  await addPanel(page, "Untrusted widget");
  await addPanel(page, "Partner widget");

  // A frame in a popout window loads again with a parent that has no runtime. So the group of a
  // frame panel has no "Pop out" button, and the group of the prices still has one.
  const groupOf = (tab: string): Locator =>
    page.getByRole("region").filter({ has: page.getByRole("tab", { name: tab, exact: true }) });
  await expect(groupOf("Research").getByRole("button", { name: "Pop out group" })).toHaveCount(0);
  await expect(
    groupOf("Prices").first().getByRole("button", { name: "Pop out group" }),
  ).toHaveCount(1);

  // A same-origin frame forwards its records over the direct link. The workspace registered it
  // before it loaded, and it registered the frame with journey:read, so no request was refused.
  await page.getByRole("tab", { name: "Research" }).click();
  const research = page.frameLocator('iframe[title="Research"]');
  await expect(research.locator("#role")).toHaveText("forwarder");
  await research.getByRole("button", { name: "Log an action" }).click();
  await expect
    .poll(() => countRecords("react-workspace-research", "RESEARCH_VIEWED"), { timeout: 15_000 })
    .toBe(1);

  // The registration binds the window and not one document, so a reload brings the link back.
  await page.locator('[data-observability-action="reload-research"]').click();
  await expect(research.locator("#role")).toHaveText("forwarder");
  await research.getByRole("button", { name: "Log an action" }).click();
  await expect
    .poll(() => countRecords("react-workspace-research", "RESEARCH_VIEWED"), { timeout: 15_000 })
    .toBe(2);

  // A frame on another origin forwards over the message link. The widget trusts the origin of
  // the workspace, and the workspace registered the exact origin of the widget.
  await page.getByRole("tab", { name: "Partner widget" }).click();
  const partner = page.frameLocator('iframe[title="Partner widget"]');
  await expect(partner.locator("#role")).toHaveText("forwarder");
  await partner.getByRole("button", { name: "log from the partner" }).click();
  await expect
    .poll(() => countRecords("react-workspace-partner", "PARTNER_CLICK"), { timeout: 15_000 })
    .toBe(1);

  // The frame that nobody registered joins no bus. It comes from another origin, so it can't read
  // the page, and it lists the workspace as its trusted parent, so it posts its hello. The bus
  // rejects the hello, and each load of the frame adds to the counter.
  await page.getByRole("tab", { name: "Untrusted widget" }).click();
  const counter = page.getByTestId("rejected-messages");
  await expect.poll(async () => Number(await counter.textContent())).toBeGreaterThan(0);
  const before = Number(await counter.textContent());
  await page.locator('[data-observability-action="reload-untrusted-widget"]').click();
  await expect.poll(async () => Number(await counter.textContent())).toBeGreaterThan(before);
  // The widget then sends for itself. It has no endpoint, so nothing arrives at the ingest server.
  await expect(page.frameLocator('iframe[title="Untrusted widget"]').locator("#role")).toHaveText(
    "sender",
    { timeout: 15_000 },
  );
  expect(
    (await receivedRecords()).filter((record) => record.service === "react-workspace-untrusted"),
  ).toEqual([]);
});

test("keeps the worker and the Research frame on the bus after Apply and restart", async ({
  page,
}) => {
  await logIn(page, "smoke-user");
  await addPanel(page, "Research");
  await page.getByRole("tab", { name: "Research" }).click();
  const research = page.frameLocator('iframe[title="Research"]');
  await expect(research.locator("#role")).toHaveText("forwarder");

  // A limit is fixed after startup. Apply and restart runs shutdown() and then configure(), and
  // shutdown() removes each registration with the old runtime.
  await page.getByRole("tab", { name: "Observability settings" }).click();
  await page.getByLabel("Deepest object").selectOption({ label: "3 levels" });
  await page.getByRole("button", { name: /Apply and restart/ }).click();
  await expect(page.getByText("Restarted. The new settings are in force.")).toBeVisible();

  // The frame loads again and joins the new runtime. Until it does, a click sends nothing.
  await page.getByRole("tab", { name: "Research" }).click();
  await expect
    .poll(
      async () => {
        await research.getByRole("button", { name: "Log an action" }).click();

        return countRecords("react-workspace-research", "RESEARCH_VIEWED");
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  // The worker is new too. A fill makes the panel read the positions, and the worker logs them.
  const before = await countRecords("react-workspace-positions", "positions received");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("row", { name: /ORD-\d+/ })).toContainText("filled", {
    timeout: 10_000,
  });
  await expect
    .poll(() => countRecords("react-workspace-positions", "positions received"), {
      timeout: 15_000,
    })
    .toBeGreaterThan(before);
});

test("uploads a replay after a refused order, and the Support panel plays it", async ({ page }) => {
  await logIn(page, "smoke-user");

  // The replay is off until the user agrees, because the config has replay.requireConsent.
  await page.getByRole("button", { name: /^smoke-user, / }).click();
  await page.getByRole("menuitem", { name: "Privacy choices" }).click();
  const dialog = page.getByRole("dialog", { name: "Privacy choices" });
  await dialog.getByLabel("Record this session for support").check();
  await expect(dialog.getByText("The replay records.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // The radio button is controlled. It turns on after the API answers, so check() is too fast.
  await page.getByLabel("Reject, 422").click();
  await expect(page.getByLabel("Reject, 422")).toBeChecked();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Order refused. Insufficient credit")).toBeVisible();

  // The upload starts after the ERROR record. The recorder keeps sending for 5 seconds after it.
  await addPanel(page, "Support");
  const rows = page.locator("table.replays tbody tr");
  await expect
    .poll(
      async () => {
        await page.getByRole("button", { name: "Refresh the list" }).click();

        return rows.count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await rows.first().getByRole("button", { name: /^Play/ }).click();
  await expect(page.locator(".replay-stage .rr-player")).toBeVisible();

  // The recording is also on the server, with the segments in order.
  const list = (await (await fetch(`${INGEST_ORIGIN}/v1/replay/recordings`)).json()) as {
    id: string;
    segments: number;
  }[];
  const detail = (await (
    await fetch(`${INGEST_ORIGIN}/v1/replay/recordings/${list[0].id}`)
  ).json()) as {
    segments: { sequence: number }[];
  };
  expect(detail.segments.map((segment) => segment.sequence)).toEqual(
    detail.segments.map((_segment, index) => index),
  );
});

test("refreshes the token with no library call, and opens a panel window with the journey", async ({
  page,
}) => {
  const tokens: string[] = [];
  page.on("request", (request) => {
    const header = request.headers().authorization;
    if (request.url().endsWith("/api/orders") && header) {
      tokens.push(header.replace("Bearer ", ""));
    }
  });
  await logIn(page, "smoke-user");
  await expect.poll(() => tokens.length).toBeGreaterThan(0);
  const oldToken = tokens[0];

  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/refresh"));
  await page.getByRole("button", { name: /^smoke-user, / }).click();
  await page.getByRole("menuitem", { name: "Refresh token now" }).click();
  expect((await refreshed).status()).toBe(200);

  // The next request carries the new token, and the old one is no longer valid.
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText(/^Order ORD-\d+ placed\.$/)).toBeVisible();
  const newToken = tokens.at(-1) ?? "";
  expect(newToken).not.toBe(oldToken);
  const session = (token: string): Promise<Response> =>
    fetch(`${APP_API_ORIGIN}/api/session`, { headers: { Authorization: `Bearer ${token}` } });
  expect((await session(oldToken)).status).toBe(401);
  expect((await session(newToken)).status).toBe(200);

  // The window of one panel is its own document. It starts its own runtime, and it adopts the
  // journey of the opener, so the records of both have the same journey id.
  const popup = page.waitForEvent("popup");
  await page
    .getByRole("region", { name: "Blotter" })
    .first()
    .getByRole("button", { name: "Open panel in new window" })
    .click();
  const child = await popup;
  await expect(child.getByTestId("journey-id")).not.toHaveText("none", { timeout: 15_000 });
  const journeyId = (await child.getByTestId("journey-id").textContent()) ?? "";
  await child.getByRole("button", { name: "Freeze 300 ms" }).click();
  await page.getByRole("button", { name: "Freeze 300 ms" }).click();

  await expect
    .poll(
      async () =>
        (await receivedRecords()).filter(
          (record) =>
            record.body === "The page froze on purpose." &&
            record.attributes["journey.id"] === journeyId,
        ),
      { timeout: 15_000 },
    )
    .toHaveLength(2);
  const froze = (await receivedRecords()).filter(
    (record) => record.body === "The page froze on purpose.",
  );
  expect(new Set(froze.map((record) => record.attributes["page.url"]))).toEqual(
    new Set([`${REACT_ORIGIN}/`, `${REACT_ORIGIN}/panel.html`]),
  );
  expect(froze.every((record) => record.attributes["journey.name"] === "panel-window")).toBe(true);
});

test("a panel window follows the withdrawal and the grant of consent in the workspace", async ({
  page,
}) => {
  await logIn(page, "smoke-user");
  const popup = page.waitForEvent("popup");
  await page
    .getByRole("region", { name: "Blotter" })
    .first()
    .getByRole("button", { name: "Open panel in new window" })
    .click();
  const child = await popup;
  await expect(child.getByTestId("journey-id")).not.toHaveText("none", { timeout: 15_000 });

  const windowFroze = async (): Promise<number> =>
    (await receivedRecords()).filter(
      (record) =>
        record.body === "The page froze on purpose." &&
        record.attributes["page.url"] === `${REACT_ORIGIN}/panel.html`,
    ).length;
  const setTelemetry = async (on: boolean): Promise<void> => {
    await page.getByRole("button", { name: /^smoke-user, / }).click();
    await page.getByRole("menuitem", { name: "Privacy choices" }).click();
    const dialog = page.getByRole("dialog", { name: "Privacy choices" });
    await dialog.getByLabel("Send telemetry about this session").setChecked(on);
    await dialog.getByRole("button", { name: "Close" }).click();
  };

  await child.getByRole("button", { name: "Freeze 300 ms" }).click();
  await expect.poll(windowFroze, { timeout: 15_000 }).toBe(1);

  // The window never reads the consent again by itself. The storage event of the workspace's
  // choice is the only way that it learns of the withdrawal.
  await setTelemetry(false);
  await expect
    .poll(() => child.evaluate(() => localStorage.getItem("react-workspace.consent")))
    .toContain('"telemetry":false');
  await child.getByRole("button", { name: "Freeze 300 ms" }).click();
  // A batch leaves within seconds. A wait that is long enough shows that none leaves.
  await child.waitForTimeout(6000);
  expect(await windowFroze()).toBe(1);

  await setTelemetry(true);
  await child.getByRole("button", { name: "Freeze 300 ms" }).click();
  await expect.poll(windowFroze, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
});

test("captures the clicks in a popout window, and a dead click while the prices tick", async ({
  page,
}) => {
  await logIn(page, "smoke-user");
  // The panel code of a popout runs in the opener, but dockview moves its DOM into another
  // window. The workspace gives that window to observeWindow(), so the library hears the click.
  const popup = page.waitForEvent("popup");
  await page
    .getByRole("region")
    .filter({ has: page.getByRole("tab", { name: "Blotter", exact: true }) })
    .first()
    .getByRole("button", { name: "Pop out group" })
    .click();
  const popout = await popup;
  const exportButton = popout.getByRole("button", { name: /^Export/ });
  await expect(exportButton).toBeVisible();
  // dockview sizes the new window for a moment, and each size write is a page change. A click
  // before it ends has an answer, and so it is not a dead click.
  await popout.waitForTimeout(1500);

  // One click on a control that does nothing, while the live tiles of the main window tick. They
  // carry data-observability-live, so they are not an answer to the click. The Order ticket form
  // is open and re-renders at each tick, but the library ignores a write with the old value.
  await exportButton.click();
  await expect
    .poll(
      async () =>
        (await receivedRecords()).filter(
          (record) =>
            record.body === "ui.dead_click" &&
            record.attributes["click.action"] === "export-orders",
        ).length,
      { timeout: 15_000 },
    )
    .toBe(1);

  // Three quick clicks on the same control are a rage click, which the library also finds there.
  for (let count = 0; count < 3; count += 1) {
    await exportButton.click();
  }
  await expect
    .poll(
      async () =>
        (await receivedRecords()).filter(
          (record) =>
            record.body === "ui.rage_click" &&
            record.attributes["click.action"] === "export-orders",
        ).length,
      { timeout: 15_000 },
    )
    .toBe(1);
});

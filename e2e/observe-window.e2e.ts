// e2e/observe-window.e2e.ts
//
// observeWindow() on a popup that window.open() just returned. The popup is still the initial
// about:blank when the app calls it. The browser then fires pagehide on that blank document and
// loads the real page into the same window, so the click capture must survive that pagehide.

import { expect, test } from "@playwright/test";
import {
  LOGS_ENDPOINT,
  PAGE_ORIGIN,
  PAGE_PATH,
  readReceived,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

const POPUP_URL = `${PAGE_ORIGIN}/e2e/fixtures/popup.html`;

/** One OTLP value, with the variants that a breadcrumb list uses. */
interface AnyValue {
  stringValue?: string;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: { key: string; value: AnyValue }[] };
}

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

/**
 * Reads the breadcrumbs of the error record with the given message, as the server received them.
 * @param message The record's body.
 * @returns The click messages of the breadcrumbs, or an empty list when no such record arrived.
 */
async function clickCrumbs(message: string): Promise<string[]> {
  const received = await readReceived();
  const clicks: string[] = [];

  for (const request of received["/v1/logs"]) {
    for (const resourceLog of request.payload.resourceLogs ?? []) {
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          if (record.body.stringValue !== message) {
            continue;
          }
          const crumbs = record.attributes?.find(({ key }) => key === "breadcrumbs");
          const value: AnyValue | undefined = crumbs?.value;
          const list = value?.arrayValue?.values ?? [];
          for (const crumb of list) {
            const fields = Object.fromEntries(
              (crumb.kvlistValue?.values ?? []).map(({ key, value }) => [key, value.stringValue]),
            );
            if (fields.category === "click" && fields.message) {
              clicks.push(fields.message);
            }
          }
        }
      }
    }
  }

  return clicks;
}

test("records a click in a popup that the app observed before the page loaded in it", async ({
  page,
}) => {
  await page.goto(PAGE_PATH);
  await page.evaluate(
    async ({ endpoint, popupUrl }) => {
      const { configure, flush } = window.e2e.uiobs;
      configure({ endpoint, serviceName: "e2e-app", capture: { interactions: true } });
      // flush() waits for the capture install, so the click listener is on before the popup opens.
      await flush();

      // A real click gives the page the user activation that window.open() needs in every engine.
      const opener = document.createElement("button");
      opener.id = "open-popup";
      opener.textContent = "Open popup";
      opener.setAttribute("data-observability-ignore", "");
      opener.addEventListener("click", () => {
        // Observe at once, as an app does with the result of window.open().
        const popup = window.open(popupUrl, "_blank");
        if (popup) {
          window.e2e.uiobs.observeWindow(popup);
        }
      });
      document.body.append(opener);

      // A click in this page is the control. Without it, an empty answer could also mean that the
      // error record or the breadcrumb list never arrived.
      const own = document.createElement("button");
      own.id = "page-buy";
      own.textContent = "Buy here";
      own.setAttribute("data-observability-action", "page-buy");
      document.body.append(own);
    },
    { endpoint: LOGS_ENDPOINT, popupUrl: POPUP_URL },
  );

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.locator("#open-popup").click(),
  ]);
  await popup.waitForLoadState("load");
  await page.locator("#page-buy").click();
  await popup.locator("#popup-buy").click();

  await page.evaluate(async () => {
    const { error, flush } = window.e2e.uiobs;
    error("after the popup click", new Error("e2e"));
    await flush();
  });

  await expect.poll(() => clickCrumbs("after the popup click")).toEqual(["page-buy", "popup-buy"]);
});

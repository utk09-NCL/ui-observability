// e2e/exit-flush.e2e.ts
//
// The exit flush on a real navigation, to an ingest server on another origin. sendBeacon always
// sends the page's cookies, so the tests assert at the server which requests carried one.

import { expect, type Page, test } from "@playwright/test";
import {
  LOGS_ENDPOINT,
  PAGE_PATH,
  readReceived,
  type Received,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

/** Body of the record that is still in the buffer when the page goes away. */
const LAST_BODY = "last words";

/** Body of the record that a normal flush sends first, so the sender is loaded before the exit. */
const FIRST_BODY = "warm up";

/** One request to /v1/logs, as the mock server kept it. */
type LogsRequest = Received["/v1/logs"][number];

/** Returns every request to /v1/logs that carried a record with the given body. */
async function readRequests(body: string): Promise<LogsRequest[]> {
  const received = await readReceived();

  return received["/v1/logs"].filter((request) =>
    (request.payload.resourceLogs ?? []).some((resourceLog) =>
      (resourceLog.scopeLogs ?? []).some((scopeLog) =>
        (scopeLog.logRecords ?? []).some((record) => record.body.stringValue === body),
      ),
    ),
  );
}

/**
 * Sets a cookie, logs one record that stays in the buffer, and then leaves the page for real,
 * so pagehide fires on an unload and not on a synthetic event.
 * @param page The test's page.
 * @param credentials The library's `credentials` setting.
 */
async function logAndLeave(page: Page, credentials: RequestCredentials): Promise<void> {
  await page.goto(PAGE_PATH);

  await page.evaluate(
    async ({ endpoint, mode, first, last }) => {
      // A cookie ignores the port, so the browser would send this one to the ingest server.
      // Without path=/ it only matches the fixture's folder, and /v1/logs would never get it.
      document.cookie = "uiobs_probe=1; path=/";

      const { configure, flush, getLogger } = window.e2e.uiobs;
      configure({ endpoint, serviceName: "e2e-app", credentials: mode });

      // The exit flush belongs to the sender chunk, which the first flush has loaded.
      const logger = getLogger("exit");
      logger.info(first);
      await flush();

      // No flush follows, so only the exit flush can deliver this record.
      logger.info(last);
    },
    { endpoint: LOGS_ENDPOINT, mode: credentials, first: FIRST_BODY, last: LAST_BODY },
  );

  await page.goto("about:blank");
}

test.beforeEach(async () => {
  await resetIngest();
});

// After the navigation the library's document is gone and this finds nothing to stop. It still
// runs for a test that failed before it left the page, whose exit flush would hit the next test.
test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

test("sends the exit batch of a real navigation without the page's cookie by default", async ({
  page,
}) => {
  await logAndLeave(page, "omit");

  await expect.poll(() => readRequests(LAST_BODY)).toHaveLength(1);
  const [exit] = await readRequests(LAST_BODY);

  // text/plain with no custom header needs no preflight, which a closing page can't wait for.
  expect(exit).toMatchObject({
    exit: "pagehide",
    contentType: "text/plain;charset=UTF-8",
    hasCookie: false,
    duplicate: false,
  });

  // The normal send obeys `credentials` too, so no request of this page carried the cookie.
  const [first] = await readRequests(FIRST_BODY);
  expect(first).toMatchObject({ exit: null, hasCookie: false });
});

test("sends the exit batch with a beacon and the cookie when credentials is include", async ({
  page,
}) => {
  await logAndLeave(page, "include");

  await expect.poll(() => readRequests(LAST_BODY)).toHaveLength(1);
  const [exit] = await readRequests(LAST_BODY);

  // A beacon lower-cases its Blob's type, which tells it apart from the keepalive fetch.
  expect(exit).toMatchObject({
    exit: "pagehide",
    contentType: "text/plain;charset=utf-8",
    hasCookie: true,
    duplicate: false,
  });

  // This is the control for the test above: the browser does send the cookie to the server.
  const [first] = await readRequests(FIRST_BODY);
  expect(first).toMatchObject({ exit: null, hasCookie: true });
});

// e2e/cross-site-credentials.e2e.ts
//
// An ingest server on another site. localhost and 127.0.0.1 are different sites, so the cookie
// of the ingest host is a third-party cookie for the page. The tests assert which batches carry
// it, because `credentials` is the library's only say in that, and the docs promise "omit" sends
// no cookie and "include" sends it with the live fetch and with the exit beacon.

import { expect, test } from "@playwright/test";
import {
  INGEST_OTHER_ORIGIN,
  PAGE_PATH,
  readReceived,
  type Received,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

/** Where the page under test posts its log batches, on the other site. */
const CROSS_SITE_ENDPOINT = `${INGEST_OTHER_ORIGIN}/v1/logs`;

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

test.beforeEach(async () => {
  await resetIngest();
});

// After the navigation the library's document is gone and this finds nothing to stop. It still
// runs for a test that failed before it left the page.
test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

/** Names each mode's behavior in a test title. */
const TITLES = {
  omit: "sends no cookie to a cross-site ingest server with credentials omit",
  include: "sends the cookie to a cross-site ingest server with credentials include",
};

for (const credentials of ["omit", "include"] as const) {
  test(TITLES[credentials], async ({ page, context, browserName }) => {
    // The cookie that the ingest server set at login, with the host as its domain. SameSite=None
    // and Secure are what a browser needs to send a cookie across sites at all.
    await context.addCookies([
      {
        name: "ingest_sid",
        value: "abc",
        domain: "127.0.0.1",
        path: "/",
        sameSite: "None",
        secure: true,
      },
    ]);

    await page.goto(PAGE_PATH);

    // The control: a plain credentialed fetch from the page. It shows what the engine does with
    // a third-party cookie, whatever the library does.
    const browserSends = await page.evaluate(async (origin) => {
      const response = await fetch(`${origin}/__echo`, { credentials: "include" });
      const echo = (await response.json()) as { headers: Record<string, string | undefined> };

      return echo.headers.cookie !== undefined;
    }, INGEST_OTHER_ORIGIN);

    // WebKit blocks a third-party cookie by default. The other two engines send it. A change here
    // means the engine changed, and the expectations below need a new look.
    expect(browserSends).toBe(browserName !== "webkit");

    await page.evaluate(
      async ({ endpoint, mode, first, last }) => {
        const { configure, flush, getLogger } = window.e2e.uiobs;
        configure({ endpoint, serviceName: "e2e-app", credentials: mode });

        // The exit flush belongs to the sender chunk, which the first flush has loaded.
        const logger = getLogger("exit");
        logger.info(first);
        await flush();

        // No flush follows, so only the exit flush can deliver this record.
        logger.info(last);
      },
      { endpoint: CROSS_SITE_ENDPOINT, mode: credentials, first: FIRST_BODY, last: LAST_BODY },
    );
    await page.goto("about:blank");

    await expect.poll(() => readRequests(LAST_BODY)).toHaveLength(1);
    const [exit] = await readRequests(LAST_BODY);
    const [live] = await readRequests(FIRST_BODY);

    // The cookie travels exactly when the app asked for credentials and the engine allows it.
    const carries = credentials === "include" && browserSends;

    // The live batch is a fetch with the serializer's content type, and it obeys `credentials`.
    expect(live).toMatchObject({ exit: null, contentType: "application/json", hasCookie: carries });

    // The exit batch is a keepalive fetch under "omit" and a beacon, which lower-cases its Blob's
    // type, under "include". A beacon sends the cookie whatever the app asked for, so "include"
    // is the only mode where the library uses one.
    expect(exit).toMatchObject({
      exit: "pagehide",
      contentType:
        credentials === "include" ? "text/plain;charset=utf-8" : "text/plain;charset=UTF-8",
      hasCookie: carries,
      duplicate: false,
    });
  });
}

// e2e/exit-close.e2e.ts
//
// The exit flush when a tab or a whole browser context closes, which exit-flush.e2e.ts doesn't
// cover because it leaves with a navigation. The tests assert what the mock ingest server got.
// An engine that fires no lifecycle event on a close gives the library no hook, so those cases
// are fixme with the evidence in a comment.

import { expect, type BrowserContext, type Page, test } from "@playwright/test";
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

/** The ways a test closes the page. */
type CloseKind = "tab-beforeunload" | "tab" | "context";

/** One way to close, with the words that name it in a test title. */
interface Close {
  kind: CloseKind;
  title: string;
  run: (page: Page, context: BrowserContext) => Promise<void>;
}

const CLOSES: Close[] = [
  {
    kind: "tab-beforeunload",
    title: "a tab close that runs beforeunload",
    run: (page) => page.close({ runBeforeUnload: true }),
  },
  { kind: "tab", title: "a plain tab close", run: (page) => page.close() },
  { kind: "context", title: "a context close", run: (_page, context) => context.close() },
];

/** The reason that an engine can't deliver a kind of close, or undefined when it can. */
function whyNotDelivered(engine: string, kind: CloseKind): string | undefined {
  // Probe, 2026-11-22: Chromium fires pagehide on a tab close, and no event on a context close.
  if (engine === "chromium" && kind === "context") {
    return "Chromium fires no pagehide on a context close, so the library has no hook";
  }

  // Probe, 2026-11-22: WebKit fires only beforeunload, and only with runBeforeUnload.
  if (engine === "webkit") {
    return "Playwright's WebKit fires no pagehide on any close, so the library has no hook";
  }

  // Probe, 2026-11-22: the library's exit batch is lost in 8 to 40 percent of tab closes. A fetch
  // at the start of pagehide lost 0 of 60, and the same fetch after a 10 ms wait lost 20 of 20.
  if (engine === "firefox") {
    return "Firefox drops the exit fetch of a closed tab unless it starts within a few ms";
  }

  return undefined;
}

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

// A closed page has no document left, and stopLibrary() skips it.
test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

for (const close of CLOSES) {
  for (const credentials of ["omit", "include"] as const) {
    test(`sends the exit batch of ${close.title} with credentials ${credentials}`, async ({
      page,
      context,
      browserName,
    }) => {
      const reason = whyNotDelivered(browserName, close.kind);
      test.fixme(reason !== undefined, reason);

      await page.goto(PAGE_PATH);
      await page.evaluate(
        async ({ endpoint, mode, first, last }) => {
          // A cookie ignores the port, so the browser sends this one to the ingest server.
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

      await close.run(page, context);

      await expect.poll(() => readRequests(LAST_BODY)).toHaveLength(1);
      const [exit] = await readRequests(LAST_BODY);

      // The beacon lower-cases its Blob's type, which tells it apart from the keepalive fetch.
      expect(exit).toMatchObject({
        exit: "pagehide",
        contentType:
          credentials === "include" ? "text/plain;charset=utf-8" : "text/plain;charset=UTF-8",
        hasCookie: credentials === "include",
        duplicate: false,
      });

      // The normal send obeys `credentials` too, so it is the control for the exit request.
      const [first] = await readRequests(FIRST_BODY);
      expect(first).toMatchObject({ exit: null, hasCookie: credentials === "include" });
    });
  }
}

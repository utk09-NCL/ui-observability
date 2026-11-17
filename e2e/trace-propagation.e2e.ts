// e2e/trace-propagation.e2e.ts
//
// The fetch capture adds traceparent only for an allowlisted origin. A header on any other
// request would trigger a CORS preflight that a third party doesn't answer.

import { expect, test } from "@playwright/test";
import {
  INGEST_ORIGIN,
  INGEST_OTHER_ORIGIN,
  LOGS_ENDPOINT,
  PAGE_PATH,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

/** What GET /__echo answers: the request headers as the server saw them. */
interface Echo {
  headers: Record<string, string | undefined>;
}

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

test("adds traceparent to a fetch for an allowlisted origin only", async ({ page }) => {
  await page.goto(PAGE_PATH);

  await page.evaluate(
    ({ endpoint, allowedOrigin }) => {
      window.e2e.uiobs.configure({
        endpoint,
        serviceName: "e2e-app",
        capture: { fetch: true, propagateTraceHeaderTo: [allowedOrigin] },
      });
    },
    { endpoint: LOGS_ENDPOINT, allowedOrigin: INGEST_ORIGIN },
  );

  // The fetch capture loads through a dynamic import, and neither configure() nor flush()
  // waits for it. A fetch before the capture replaces window.fetch carries no traceparent.
  await page.waitForFunction(() => window.fetch !== window.e2e.nativeFetch);

  const { allowed, other } = await page.evaluate(
    async ({ allowedOrigin, otherOrigin }) => {
      const allowedAnswer = await fetch(`${allowedOrigin}/__echo`);
      const otherAnswer = await fetch(`${otherOrigin}/__echo`);

      return {
        allowed: (await allowedAnswer.json()) as Echo,
        other: (await otherAnswer.json()) as Echo,
      };
    },
    { allowedOrigin: INGEST_ORIGIN, otherOrigin: INGEST_OTHER_ORIGIN },
  );

  // W3C trace context: version, 16-byte trace id, 8-byte parent id, flags.
  expect(allowed.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  // Both answers come from one server, so the origin is the only difference.
  expect(other.headers.host).toBe(new URL(INGEST_OTHER_ORIGIN).host);
  expect(other.headers).not.toHaveProperty("traceparent");
});

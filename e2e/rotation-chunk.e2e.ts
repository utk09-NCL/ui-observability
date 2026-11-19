// e2e/rotation-chunk.e2e.ts
//
// The rotation code is a lazy chunk, and its load can fail, for example on a network error. The
// failed rotation closes delivery. Browsers keep a failed import in the document's module map,
// so this test pins what docs/production-recipes.md tells an app to do then.

import { expect, type Page, test } from "@playwright/test";
import {
  INGEST_ORIGIN,
  LOGS_ENDPOINT,
  PAGE_PATH,
  readLogs,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

/** The rotation module as the Vite dev server serves it. The build makes it its own chunk. */
const ROTATION_CHUNK = "**/src/core/rotation.ts*";

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

/**
 * Rotates to a new context id and returns how the promise settled.
 * @returns "resolved", or the name of the error that the rotation rejected with.
 */
function rotate(page: Page, id: string): Promise<string> {
  return page.evaluate(
    async ({ endpoint, contextId }) => {
      try {
        await window.e2e.uiobs.rotateSecurityContext({ id: contextId, routing: { endpoint } });
        return "resolved";
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    },
    { endpoint: LOGS_ENDPOINT, contextId: id },
  );
}

/** Makes the mock server answer each batch with this status. 0 ends it. */
async function forceStatus(status: number): Promise<void> {
  const response = await fetch(`${INGEST_ORIGIN}/__control?status=${String(status)}`);
  if (!response.ok) {
    throw new Error(`mock ingest control answered ${String(response.status)}`);
  }
}

/** Returns the issues of getHealth() in the page. */
function issues(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await window.e2e.uiobs.getHealth()).issues);
}

/** Configures the library for one context and waits for its startup. */
async function start(page: Page, contextId: string): Promise<void> {
  await page.evaluate(
    async ({ endpoint, id }) => {
      window.e2e.uiobs.configure({
        endpoint,
        serviceName: "e2e-rotation",
        securityContext: { id },
      });
      await window.e2e.uiobs.flush();
    },
    { endpoint: LOGS_ENDPOINT, id: contextId },
  );
}

/** Logs one record and flushes it. */
async function logAndFlush(page: Page, body: string): Promise<void> {
  await page.evaluate(async (text) => {
    window.e2e.uiobs.getLogger("e2e.rotation").info(text);
    await window.e2e.uiobs.flush();
  }, body);
}

test("keeps a failed rotation chunk load until a reload, and a clearing shutdown() then configure() recover", async ({
  page,
}) => {
  const chunkRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/src/core/rotation.ts")) {
      chunkRequests.push(request.url());
    }
  });

  await page.goto(PAGE_PATH);
  await start(page, "tenant-a");
  await logAndFlush(page, "tenant-a before the failure");
  await expect.poll(() => readLogs("tenant-a before the failure")).toHaveLength(1);
  const [before] = await readLogs("tenant-a before the failure");

  // The server refuses this batch, so it waits in storage under tenant-a.
  await forceStatus(503);
  const stored = await page.evaluate(async () => {
    window.e2e.uiobs.getLogger("e2e.rotation").info("tenant-a stored");
    return (await window.e2e.uiobs.flush({ timeoutMs: 2000 })).stored;
  });
  expect(stored).toBeGreaterThan(0);

  await page.route(ROTATION_CHUNK, (route) => route.abort("failed"), { times: 1 });

  // The failed load closes delivery, because the app asked to leave the old context.
  expect(await rotate(page, "tenant-b")).toBe("TypeError");
  expect(await issues(page)).toContain("security.rotation_failed");

  // The route is used up, but the browser answers the same import from its module map. If this
  // starts to resolve, the browser retries now, and the recipe in the docs can say so.
  expect(await rotate(page, "tenant-c")).toBe("TypeError");
  expect(chunkRequests).toHaveLength(1);

  // The recipe's way out: a new runtime needs no rotation chunk, and the clear removes the old
  // user's stored batches and ids.
  await page.evaluate(() =>
    window.e2e.uiobs.shutdown({ pending: "discard", clearStorage: "context" }),
  );
  await forceStatus(0);
  await start(page, "tenant-c");
  await logAndFlush(page, "after shutdown and configure");
  await expect.poll(() => readLogs("after shutdown and configure")).toHaveLength(1);
  const [after] = await readLogs("after shutdown and configure");
  expect(after.resource["session.id"]).not.toBe(before.resource["session.id"]);
  expect(await rotate(page, "tenant-d")).toBe("TypeError");

  // A reload gives a new module map, so the rotation loads again. A tenant-a runtime would find
  // tenant-a's stored batch now, if the clear had left it.
  await stopLibrary(page);
  await page.reload();
  await start(page, "tenant-a");
  const storedAfter = await page.evaluate(async () => {
    await window.e2e.uiobs.flush({ timeoutMs: 3000 });
    return (await window.e2e.uiobs.getHealth()).delivery.stored;
  });
  expect(storedAfter).toBe(0);
  expect(await readLogs("tenant-a stored")).toEqual([]);
  expect(await rotate(page, "tenant-e")).toBe("resolved");
  expect(chunkRequests).toHaveLength(2);
  await logAndFlush(page, "after the reload");
  await expect.poll(() => readLogs("after the reload")).toHaveLength(1);
});

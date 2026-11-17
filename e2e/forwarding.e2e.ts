// e2e/forwarding.e2e.ts
//
// A child frame hands its records to the parent, and the parent is the only document that
// posts. The parent's redact hook is the last privacy gate, so it also covers the child.

import { expect, type Frame, type Page, test } from "@playwright/test";
import {
  CROSS_ORIGIN,
  LOGS_ENDPOINT,
  PAGE_ORIGIN,
  PAGE_PATH,
  readLogs,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

const SAME_ORIGIN_CHILD = `${PAGE_ORIGIN}${PAGE_PATH}?role=child`;
const CROSS_ORIGIN_CHILD = `${CROSS_ORIGIN}${PAGE_PATH}?role=child`;

/**
 * The test page as srcdoc markup. Vite adds its define globals only to a page it serves, so
 * /@vite/env sets them here first, or the library fails on __UIOBS_VERSION__.
 */
const SRCDOC_CHILD = [
  '<script type="module" src="/@vite/env"></script>',
  '<script type="module" src="/e2e/fixtures/page.ts"></script>',
].join("");

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

/**
 * Records which frame posts each log batch. The server can't tell a same-origin parent from
 * its child, so the browser's own request list is the evidence.
 */
function watchPosters(page: Page): Frame[] {
  const posters: Frame[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().startsWith(LOGS_ENDPOINT)) {
      posters.push(request.frame());
    }
  });

  return posters;
}

/** Registers an empty frame in the configured parent, then loads the child page into it. */
async function loadChild(page: Page, childUrl: string): Promise<Frame> {
  await page.evaluate(async (url) => {
    const { flush, registerFrame } = window.e2e.uiobs;

    // Register before the child loads. A child that starts first finds no owner and posts
    // its own records.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    registerFrame(frame, { origin: new URL(url).origin, permissions: ["records"] });
    // flush() waits for the bus module, so registerFrame() takes effect before the child loads.
    await flush();

    const loaded = new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
    });
    frame.src = url;
    await loaded;
  }, childUrl);

  const child = page.frame({ url: /role=child/ });
  if (!child) {
    throw new Error("the parent page has no child frame");
  }

  return child;
}

/**
 * Registers an empty frame in the configured parent, then fills it through srcdoc. Such a frame
 * runs on the parent's origin, but its location.origin is "null".
 */
async function loadSrcdocChild(page: Page): Promise<Frame> {
  await page.evaluate(async (markup) => {
    const { flush, registerFrame } = window.e2e.uiobs;

    // Register before the child loads, with the parent's origin, as for any same-origin frame.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    registerFrame(frame, { origin: location.origin, permissions: ["records"] });
    await flush();

    const loaded = new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
    });
    frame.srcdoc = markup;
    await loaded;
  }, SRCDOC_CHILD);

  const child = page.frame({ url: "about:srcdoc" });
  if (!child) {
    throw new Error("the parent page has no srcdoc frame");
  }

  return child;
}

/**
 * Flushes the child and then the parent. Each one sends on a 2,000 ms timer by default, so
 * without this a document that wrongly holds a copy hasn't posted it when the test looks.
 */
async function flushBoth(page: Page, child: Frame): Promise<void> {
  await child.evaluate(() => window.e2e.uiobs.flush());
  await page.evaluate(() => window.e2e.uiobs.flush());
}

/** Returns each role the frame's bus resolved to, from its bus.role_resolved diagnostics. */
function resolvedRoles(frame: Frame): Promise<unknown[]> {
  return frame.evaluate(() =>
    window.e2e.diagnostics
      .filter((event) => event.code === "bus.role_resolved")
      .map((event) => event.detail?.role),
  );
}

test("forwards a child frame's record through the parent, after the parent's redact", async ({
  page,
}) => {
  const posters = watchPosters(page);
  await page.goto(PAGE_PATH);

  await page.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-parent",
      redact: (record) => {
        delete record.attributes.cardNumber;
        return record;
      },
    });
  }, LOGS_ENDPOINT);

  const child = await loadChild(page, SAME_ORIGIN_CHILD);
  await child.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-child",
      onDiagnostic: window.e2e.onDiagnostic,
    });
  }, LOGS_ENDPOINT);

  // The child logs only after it has an owner, so the record can't take the child's own path.
  await expect.poll(() => resolvedRoles(child)).toEqual(["forwarder"]);

  await child.evaluate(() => {
    window.e2e.uiobs
      .getLogger("child.payments")
      .info("card charged", { orderId: "ORD-7", cardNumber: "4111111111111111" });
  });
  await page.evaluate(() => window.e2e.uiobs.flush());

  await expect.poll(() => readLogs("card charged")).toHaveLength(1);
  await flushBoth(page, child);
  const logs = await readLogs("card charged");
  expect(logs).toHaveLength(1);
  const [log] = logs;

  // The record keeps the child's identity, and the child has no redact hook of its own.
  expect(log.scope).toBe("child.payments");
  expect(log.resource["service.name"]).toBe("e2e-child");
  expect(log.attributes.orderId).toBe("ORD-7");
  expect(log.attributes).not.toHaveProperty("cardNumber");
  expect(posters.length).toBeGreaterThan(0);
  expect(posters.every((frame) => frame === page.mainFrame())).toBe(true);
});

test("forwards a srcdoc frame's record through the parent, after the parent's redact", async ({
  page,
}) => {
  const posters = watchPosters(page);
  await page.goto(PAGE_PATH);

  await page.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-parent",
      redact: (record) => {
        delete record.attributes.cardNumber;
        return record;
      },
    });
  }, LOGS_ENDPOINT);

  const child = await loadSrcdocChild(page);
  // The frame is the case under test only while its two origins disagree.
  expect(await child.evaluate(() => [location.origin, globalThis.origin])).toEqual([
    "null",
    PAGE_ORIGIN,
  ]);
  await child.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-srcdoc",
      onDiagnostic: window.e2e.onDiagnostic,
    });
  }, LOGS_ENDPOINT);

  // A srcdoc frame that the parent refuses becomes a sender, and then only its own redact runs.
  await expect.poll(() => resolvedRoles(child)).toEqual(["forwarder"]);

  await child.evaluate(() => {
    window.e2e.uiobs
      .getLogger("srcdoc.payments")
      .info("srcdoc card charged", { orderId: "ORD-8", cardNumber: "4111111111111111" });
  });
  await page.evaluate(() => window.e2e.uiobs.flush());

  await expect.poll(() => readLogs("srcdoc card charged")).toHaveLength(1);
  await flushBoth(page, child);
  const logs = await readLogs("srcdoc card charged");
  expect(logs).toHaveLength(1);
  const [log] = logs;

  expect(log.scope).toBe("srcdoc.payments");
  expect(log.resource["service.name"]).toBe("e2e-srcdoc");
  expect(log.attributes.orderId).toBe("ORD-8");
  expect(log.attributes).not.toHaveProperty("cardNumber");
  expect(posters.length).toBeGreaterThan(0);
  expect(posters.every((frame) => frame === page.mainFrame())).toBe(true);
});

test("forwards a cross-origin child's record when the child trusts the parent's origin", async ({
  page,
}) => {
  const posters = watchPosters(page);
  await page.goto(PAGE_PATH);

  await page.evaluate((endpoint) => {
    window.e2e.uiobs.configure({ endpoint, serviceName: "e2e-parent" });
  }, LOGS_ENDPOINT);

  const child = await loadChild(page, CROSS_ORIGIN_CHILD);
  await child.evaluate(
    ({ endpoint, parentOrigin }) => {
      window.e2e.uiobs.configure({
        endpoint,
        serviceName: "e2e-child",
        bus: { trustedOrigins: [parentOrigin] },
        onDiagnostic: window.e2e.onDiagnostic,
      });
    },
    { endpoint: LOGS_ENDPOINT, parentOrigin: PAGE_ORIGIN },
  );

  await expect.poll(() => resolvedRoles(child)).toEqual(["forwarder"]);

  await child.evaluate(() => {
    window.e2e.uiobs.getLogger("child.blotter").info("row selected", { rowId: "R-12" });
  });
  await page.evaluate(() => window.e2e.uiobs.flush());

  await expect.poll(() => readLogs("row selected")).toHaveLength(1);
  await flushBoth(page, child);
  const logs = await readLogs("row selected");
  expect(logs).toHaveLength(1);
  const [log] = logs;

  expect(log.resource["service.name"]).toBe("e2e-child");
  expect(log.attributes.rowId).toBe("R-12");
  expect(posters.length).toBeGreaterThan(0);
  expect(posters.every((frame) => frame === page.mainFrame())).toBe(true);
});

test("a cross-origin child that doesn't trust the parent's origin posts its own records", async ({
  page,
}) => {
  const posters = watchPosters(page);
  await page.goto(PAGE_PATH);

  await page.evaluate((endpoint) => {
    window.e2e.uiobs.configure({ endpoint, serviceName: "e2e-parent" });
  }, LOGS_ENDPOINT);

  const child = await loadChild(page, CROSS_ORIGIN_CHILD);
  await child.evaluate((endpoint) => {
    // No bus.trustedOrigins, so the child refuses the parent's welcome.
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-child",
      onDiagnostic: window.e2e.onDiagnostic,
    });
  }, LOGS_ENDPOINT);

  await expect.poll(() => resolvedRoles(child)).toEqual(["sender"]);

  await child.evaluate(async () => {
    window.e2e.uiobs.getLogger("child.blotter").info("row selected", { rowId: "R-12" });
    await window.e2e.uiobs.flush();
  });

  await expect.poll(() => readLogs("row selected")).toHaveLength(1);
  await flushBoth(page, child);
  expect(await readLogs("row selected")).toHaveLength(1);
  expect(posters).toEqual([child]);
});

// e2e/cross-origin-srcdoc.e2e.ts
//
// Three documents in a chain: a parent, a registered child on a second origin, and a srcdoc frame
// inside that child. The srcdoc frame runs on the child's origin but reads location.origin as
// "null", so each hop checks a different origin rule. The tests assert which document posts.

import { expect, type Frame, test } from "@playwright/test";
import {
  flushFrames,
  loadChildFrame,
  resolvedLinks,
  resolvedRoles,
  watchPosters,
} from "./fixtures/frames";
import {
  CROSS_ORIGIN,
  LOGS_ENDPOINT,
  PAGE_ORIGIN,
  PAGE_PATH,
  readLogs,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

const CROSS_ORIGIN_CHILD = `${CROSS_ORIGIN}${PAGE_PATH}?role=child`;

/**
 * The test page as srcdoc markup. A srcdoc frame resolves "/" against its parent's URL, so these
 * paths load from the child's origin. /@vite/env sets the version define that the library reads.
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

/** Returns the srcdoc frame that the given frame hosts. */
function srcdocFrameOf(host: Frame): Frame {
  const frame = host.childFrames().find((child) => child.url() === "about:srcdoc");
  if (!frame) {
    throw new Error("the child frame has no srcdoc frame");
  }

  return frame;
}

test("hands a srcdoc frame's record through a cross-origin child to the parent's redact", async ({
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

  await loadChildFrame(page.mainFrame(), { url: CROSS_ORIGIN_CHILD }, CROSS_ORIGIN);
  const child = page.frame({ url: /role=child/ });
  if (!child) {
    throw new Error("the parent page has no child frame");
  }
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

  // The child registers its srcdoc frame with the origin that the frame really runs on.
  await loadChildFrame(child, { srcdoc: SRCDOC_CHILD }, CROSS_ORIGIN);
  const srcdoc = srcdocFrameOf(child);
  // The frame is the case under test only while its two origins disagree.
  expect(await srcdoc.evaluate(() => [location.origin, globalThis.origin])).toEqual([
    "null",
    CROSS_ORIGIN,
  ]);
  await srcdoc.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-srcdoc",
      onDiagnostic: window.e2e.onDiagnostic,
    });
  }, LOGS_ENDPOINT);

  // The srcdoc frame uses the direct call to its same-origin parent, and that parent forwards.
  await expect.poll(() => resolvedRoles(srcdoc)).toEqual(["forwarder"]);
  expect(await resolvedLinks(srcdoc)).toEqual(["direct"]);

  await srcdoc.evaluate(() => {
    window.e2e.uiobs
      .getLogger("srcdoc.payments")
      .info("nested card charged", { orderId: "ORD-31", cardNumber: "4111111111111111" });
  });
  await flushFrames([srcdoc, child, page.mainFrame()]);

  await expect.poll(() => readLogs("nested card charged")).toHaveLength(1);
  const [log] = await readLogs("nested card charged");

  // The record keeps the srcdoc frame's identity, and the parent's redact is the last gate.
  expect(log.scope).toBe("srcdoc.payments");
  expect(log.resource["service.name"]).toBe("e2e-srcdoc");
  expect(log.attributes.orderId).toBe("ORD-31");
  expect(log.attributes).not.toHaveProperty("cardNumber");
  expect(posters.length).toBeGreaterThan(0);
  expect(posters.every((frame) => frame === page.mainFrame())).toBe(true);
});

test("a cross-origin child that doesn't trust the parent posts its srcdoc frame's record", async ({
  page,
}) => {
  const posters = watchPosters(page);
  await page.goto(PAGE_PATH);

  await page.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-parent",
      redact: (record) => {
        delete record.attributes.parentSecret;
        return record;
      },
    });
  }, LOGS_ENDPOINT);

  await loadChildFrame(page.mainFrame(), { url: CROSS_ORIGIN_CHILD }, CROSS_ORIGIN);
  const child = page.frame({ url: /role=child/ });
  if (!child) {
    throw new Error("the parent page has no child frame");
  }
  await child.evaluate((endpoint) => {
    // No bus.trustedOrigins, so the child refuses the parent's welcome and sends for itself.
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-child",
      redact: (record) => {
        delete record.attributes.cardNumber;
        return record;
      },
      onDiagnostic: window.e2e.onDiagnostic,
    });
  }, LOGS_ENDPOINT);
  await expect.poll(() => resolvedRoles(child)).toEqual(["sender"]);

  await loadChildFrame(child, { srcdoc: SRCDOC_CHILD }, CROSS_ORIGIN);
  const srcdoc = srcdocFrameOf(child);
  await srcdoc.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-srcdoc",
      onDiagnostic: window.e2e.onDiagnostic,
    });
  }, LOGS_ENDPOINT);
  await expect.poll(() => resolvedRoles(srcdoc)).toEqual(["forwarder"]);

  await srcdoc.evaluate(() => {
    window.e2e.uiobs
      .getLogger("srcdoc.payments")
      .info("nested card sent by the child", { orderId: "ORD-32", cardNumber: "4111111111111111" });
  });
  await flushFrames([srcdoc, child, page.mainFrame()]);

  await expect.poll(() => readLogs("nested card sent by the child")).toHaveLength(1);
  const [log] = await readLogs("nested card sent by the child");

  // The child is the sender, so its redact applies and the parent never sees the record.
  expect(log.resource["service.name"]).toBe("e2e-srcdoc");
  expect(log.attributes.orderId).toBe("ORD-32");
  expect(log.attributes).not.toHaveProperty("cardNumber");
  expect(posters.length).toBeGreaterThan(0);
  expect(posters.every((frame) => frame === child)).toBe(true);
});

test("a srcdoc frame that the child registered with the wrong origin posts its own record", async ({
  page,
}) => {
  const posters = watchPosters(page);
  await page.goto(PAGE_PATH);

  await page.evaluate((endpoint) => {
    window.e2e.uiobs.configure({ endpoint, serviceName: "e2e-parent" });
  }, LOGS_ENDPOINT);

  await loadChildFrame(page.mainFrame(), { url: CROSS_ORIGIN_CHILD }, CROSS_ORIGIN);
  const child = page.frame({ url: /role=child/ });
  if (!child) {
    throw new Error("the parent page has no child frame");
  }
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

  // The child expects the parent's origin for this frame, but the frame runs on the child's own.
  await loadChildFrame(child, { srcdoc: SRCDOC_CHILD }, PAGE_ORIGIN);
  const srcdoc = srcdocFrameOf(child);
  await srcdoc.evaluate((endpoint) => {
    window.e2e.uiobs.configure({
      endpoint,
      serviceName: "e2e-srcdoc",
      onDiagnostic: window.e2e.onDiagnostic,
    });
  }, LOGS_ENDPOINT);

  // Neither the direct call nor the message link passes the check, so the frame sends for itself.
  await expect.poll(() => resolvedRoles(srcdoc), { timeout: 10_000 }).toEqual(["sender"]);

  await srcdoc.evaluate(async () => {
    window.e2e.uiobs.getLogger("srcdoc.payments").info("nested card sent by the srcdoc frame");
    await window.e2e.uiobs.flush();
  });

  await expect.poll(() => readLogs("nested card sent by the srcdoc frame")).toHaveLength(1);
  await flushFrames([child, page.mainFrame()]);
  const logs = await readLogs("nested card sent by the srcdoc frame");

  expect(logs).toHaveLength(1);
  expect(logs[0].resource["service.name"]).toBe("e2e-srcdoc");
  expect(posters.length).toBeGreaterThan(0);
  expect(posters.every((frame) => frame === srcdoc)).toBe(true);
});

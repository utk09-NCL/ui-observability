// e2e/startup-burst.e2e.ts
//
// A burst of records before the sender loads fills the hold buffer. The first error is usually
// the cause of a failed startup, so it has to reach the server, and onDrop has to account for
// every record that didn't.

import { expect, test } from "@playwright/test";
import {
  LOGS_ENDPOINT,
  PAGE_PATH,
  readReceived,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

/** Default of buffering.maxHeldRecords. */
const DEFAULT_CAP = 500;

/** Records of each kind that a full hold buffer never drops. */
const HEAD = 100;

/** Info records the page logs after its one error. Four times the default cap. */
const BURST = 2000;

/** Logger namespace of the burst, which keeps other records out of the assertions. */
const SCOPE = "boot";

/** What the page's onDrop hook saw, reduced to the fields the tests assert. */
interface SeenDrop {
  reason: string;
  records: number;
}

/**
 * Returns the body of every record the server received from the burst's logger, sorted. A
 * batch that arrived twice gives its bodies twice, so a double send fails an equality check.
 */
async function readBurstBodies(): Promise<string[]> {
  const received = await readReceived();
  const bodies: string[] = [];

  for (const request of received["/v1/logs"]) {
    for (const resourceLog of request.payload.resourceLogs ?? []) {
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        if (scopeLog.scope?.name === SCOPE) {
          for (const record of scopeLog.logRecords ?? []) {
            bodies.push(record.body.stringValue);
          }
        }
      }
    }
  }

  return bodies.sort();
}

/**
 * Builds the bodies of one run of the burst, for example `burst 3` to `burst 6`.
 * @param from First index.
 * @param to Index after the last one.
 */
function burstBodies(from: number, to: number): string[] {
  const bodies: string[] = [];
  for (let index = from; index < to; index++) {
    bodies.push(`burst ${String(index)}`);
  }

  return bodies;
}

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

test("keeps the first error of a startup burst and reports the dropped records", async ({
  page,
}) => {
  await page.goto(PAGE_PATH);

  const drops = await page.evaluate(
    async ({ endpoint, scope, burst }) => {
      const { configure, flush, getLogger } = window.e2e.uiobs;
      const seen: SeenDrop[] = [];
      configure({
        endpoint,
        serviceName: "e2e-app",
        onDrop: (summary) => {
          seen.push({ reason: summary.reason, records: summary.records });
        },
      });

      // Everything below runs in the task that called configure(), so no record can leave
      // before the burst ends. The sender chunk hasn't even started to load.
      const logger = getLogger(scope);
      logger.error("first failure");
      for (let index = 0; index < burst; index++) {
        logger.info(`burst ${String(index)}`);
      }

      await flush();
      return seen;
    },
    { endpoint: LOGS_ENDPOINT, scope: SCOPE, burst: BURST },
  );

  // The error is record 1 of the head, so the head also holds the first 99 burst records.
  const newest = DEFAULT_CAP - HEAD;
  const expected = [
    "first failure",
    ...burstBodies(0, HEAD - 1),
    ...burstBodies(BURST - newest, BURST),
  ].sort();

  await expect.poll(async () => (await readBurstBodies()).length).toBe(DEFAULT_CAP);
  expect(await readBurstBodies()).toEqual(expected);

  // One summary for the whole burst, with every record the server didn't get.
  expect(drops).toEqual([{ reason: "buffer_full", records: BURST + 1 - DEFAULT_CAP }]);
});

test("delivers the whole startup burst when the app raises the cap", async ({ page }) => {
  await page.goto(PAGE_PATH);

  const drops = await page.evaluate(
    async ({ endpoint, scope, burst }) => {
      const { configure, flush, getLogger } = window.e2e.uiobs;
      const seen: SeenDrop[] = [];
      configure({
        endpoint,
        serviceName: "e2e-app",
        buffering: { maxHeldRecords: 5000 },
        onDrop: (summary) => {
          seen.push({ reason: summary.reason, records: summary.records });
        },
      });

      const logger = getLogger(scope);
      logger.error("first failure");
      for (let index = 0; index < burst; index++) {
        logger.info(`burst ${String(index)}`);
      }

      await flush();
      return seen;
    },
    { endpoint: LOGS_ENDPOINT, scope: SCOPE, burst: BURST },
  );

  const expected = ["first failure", ...burstBodies(0, BURST)].sort();

  await expect.poll(async () => (await readBurstBodies()).length).toBe(BURST + 1);
  expect(await readBurstBodies()).toEqual(expected);
  expect(drops).toEqual([]);
});

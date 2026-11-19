// e2e/replay.e2e.ts
//
// The session replay with the real recorder, the optional peer @rrweb/record. A unit test fakes
// the recorder, so only a browser shows what the real one puts in an upload.

import { expect, test } from "@playwright/test";
import {
  INGEST_ORIGIN,
  LOGS_ENDPOINT,
  PAGE_PATH,
  readLogs,
  readReceived,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

/** Where the page under test posts its replay segments. */
const REPLAY_ENDPOINT = `${INGEST_ORIGIN}/v1/replay`;

/** One recorder event, with only the fields the test reads. */
interface ReplayEvent {
  type: number;
  data?: { source?: number; node?: SerializedNode; text?: string };
}

/** One node of the recorder's full snapshot, with only the fields the test reads. */
interface SerializedNode {
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

/** One replay segment as the library posts it. */
interface ReplayBody {
  "replay.id": string;
  "session.id": string;
  "service.name": string;
  sequence: number;
  events: ReplayEvent[];
}

/** Event type of a full snapshot. */
const FULL_SNAPSHOT = 2;

/** Event type of an incremental snapshot. */
const INCREMENTAL = 3;

/** Event type of the meta event that comes before a full snapshot. */
const META = 4;

/** Incremental source of a DOM mutation. */
const MUTATION = 0;

/** Incremental source of an input change. */
const INPUT = 5;

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

/** Returns every replay segment the server kept, in the order it got them. */
async function readSegments(): Promise<ReplayBody[]> {
  const received = await readReceived();

  return received["/v1/replay"].map((request) => request.payload as ReplayBody);
}

/** Returns the first node in the tree whose class attribute is the given value. */
function findByClass(node: SerializedNode | undefined, name: string): SerializedNode | undefined {
  if (!node) {
    return undefined;
  }

  if (node.attributes?.class === name) {
    return node;
  }

  for (const child of node.childNodes ?? []) {
    const found = findByClass(child, name);
    if (found) {
      return found;
    }
  }

  return undefined;
}

test("uploads the real recorder's events after an error, with text and inputs masked", async ({
  page,
}) => {
  await page.goto(PAGE_PATH);

  // The page content exists before the start, so it is in the first full snapshot.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      [
        '<p id="holder">Card holder Alice Smith</p>',
        '<p id="status" data-observability-unmask>Order ORD-77 shipped</p>',
        '<div class="secret-box" data-observability-ignore><span>token 9f8e7d</span></div>',
        '<input id="pin" value="pin-qxz">',
      ].join(""),
    );
  });

  await page.evaluate(
    ({ endpoint, replayEndpoint }) => {
      window.e2e.uiobs.configure({
        endpoint,
        serviceName: "e2e-replay",
        onDiagnostic: window.e2e.onDiagnostic,
        replay: {
          enabled: true,
          endpoint: replayEndpoint,
          loader: window.e2e.loadRecorder,
          flushIntervalMs: 100,
          afterErrorMs: 1000,
        },
      });
    },
    { endpoint: LOGS_ENDPOINT, replayEndpoint: REPLAY_ENDPOINT },
  );

  // The recorder's mirror knows the document, node 1, once the first full snapshot is done.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { record } = await window.e2e.loadRecorder();
        const documentNode = record.mirror?.getNode(1);
        return documentNode !== null && documentNode !== undefined;
      }),
    )
    .toBe(true);

  await page.evaluate(() => {
    // Throws for a missing element, because a change that never happens can't leak a text.
    const find = (selector: string): Element => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`The page has no ${selector}.`);
      }
      return element;
    };

    const row = document.createElement("p");
    row.textContent = "Added for Bob Jones";
    document.body.append(row);
    find("#holder").textContent = "Card holder Carol White";
    find("#status").textContent = "Order ORD-78 shipped";
    find(".secret-box span").textContent = "token 1a2b3c";
    const pin = find("#pin");
    if (!(pin instanceof HTMLInputElement)) {
      throw new Error("The page has no input #pin.");
    }
    pin.value = "pin-wvy";
    pin.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // The recorder handles mutations in a microtask, so they are in the buffer before the error.
  await page.evaluate(async () => {
    window.e2e.uiobs.getLogger("e2e.replay").error("replay probe");
    await window.e2e.uiobs.flush();
  });

  await expect
    .poll(async () =>
      (await readSegments())
        .flatMap((segment) => segment.events)
        .some((event) => event.type === INCREMENTAL && event.data?.source === MUTATION),
    )
    .toBe(true);

  const segments = await readSegments();
  const [first] = segments;
  const events = segments.flatMap((segment) => segment.events);
  const text = JSON.stringify(events);

  // The upload starts with the meta event and the full snapshot, so a player can start there.
  expect(first.sequence).toBe(0);
  expect(first["service.name"]).toBe("e2e-replay");
  expect(first.events.slice(0, 2).map((event) => event.type)).toEqual([META, FULL_SNAPSHOT]);

  // Text is masked by default, and a masked text keeps the length of each word. Each clear
  // value has a letter, so a timestamp's digits can't match it.
  for (const clear of ["Alice", "Carol", "Bob", "9f8e7d", "1a2b3c", "pin-qxz", "pin-wvy"]) {
    expect(text).not.toContain(clear);
  }
  expect(text).toContain("**** ****** ***** *****");
  expect(text).toContain("***** *** *** *****");

  // The input change is its own event, so this doesn't pass on the snapshot's masked value.
  const input = events.find((event) => event.type === INCREMENTAL && event.data?.source === INPUT);
  expect(input?.data?.text).toBe("********");

  // data-observability-unmask keeps its text, in the snapshot and in the mutation.
  expect(text).toContain("Order ORD-77 shipped");
  expect(text).toContain("Order ORD-78 shipped");

  // data-observability-ignore blocks the element: the recorder keeps only its size.
  const snapshot = first.events.find((event) => event.type === FULL_SNAPSHOT);
  const blocked = findByClass(snapshot?.data?.node, "secret-box");
  expect(blocked?.attributes).toHaveProperty("rr_width");
  expect(blocked?.childNodes ?? []).toEqual([]);

  // The error record carries the replay id, so a person can find the replay of the record.
  await expect.poll(() => readLogs("replay probe")).toHaveLength(1);
  const [log] = await readLogs("replay probe");
  expect(log.attributes["replay.id"]).toBe(first["replay.id"]);
  expect(first["session.id"]).toBe(log.resource["session.id"]);
});

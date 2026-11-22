// e2e/cross-version.e2e.ts
//
// A parent and a child frame that run different releases of the library, as when a shell and its
// remotes deploy on different days. The 1.0.0 bundle comes from the git tag, so each pair here
// is two real builds. The tests assert that the handshake works and that the parent alone posts.

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
import { buildRelease, RELEASE_TAG, RELEASE_VERSION, releasePage } from "./fixtures/release";

/** Which build a document runs. */
type Build = "release" | "current";

/** One parent and child pair. `crossOrigin` puts the child on the second page server. */
interface Pair {
  parent: Build;
  child: Build;
  crossOrigin: boolean;
}

const PAIRS: Pair[] = [
  { parent: "release", child: "current", crossOrigin: false },
  { parent: "current", child: "release", crossOrigin: false },
  { parent: "release", child: "current", crossOrigin: true },
  { parent: "current", child: "release", crossOrigin: true },
];

/** The path that loads the given build as the top document. */
function pageFor(build: Build, query = ""): string {
  return build === "release" ? releasePage(RELEASE_TAG, query) : `${PAGE_PATH}?${query}`;
}

/** Names a pair in a test title. */
function titleOf({ parent, child, crossOrigin }: Pair): string {
  const label = (build: Build): string => (build === "release" ? RELEASE_VERSION : "current");
  const place = crossOrigin ? "cross-origin" : "same-origin";

  return `a ${label(parent)} parent forwards the record of a ${place} ${label(child)} child`;
}

// The first run of a checkout builds the bundle from its git tag. Later runs find the cache.
test.beforeAll(async () => {
  test.setTimeout(120_000);
  await buildRelease(RELEASE_TAG);
});

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

/** Waits until the frame's page has put the library on window.e2e. */
async function untilLoaded(frame: Frame): Promise<void> {
  await frame.waitForFunction(() => "e2e" in window);
}

for (const pair of PAIRS) {
  test(titleOf(pair), async ({ page }) => {
    const posters = watchPosters(page);
    await page.goto(pageFor(pair.parent));
    await untilLoaded(page.mainFrame());

    await page.evaluate((endpoint) => {
      window.e2e.uiobs.configure({
        endpoint,
        serviceName: "e2e-parent",
        onDiagnostic: window.e2e.onDiagnostic,
        redact: (record) => {
          delete record.attributes.cardNumber;
          return record;
        },
      });
    }, LOGS_ENDPOINT);

    const origin = pair.crossOrigin ? CROSS_ORIGIN : PAGE_ORIGIN;
    await loadChildFrame(
      page.mainFrame(),
      { url: `${origin}${pageFor(pair.child, "role=child")}` },
      origin,
    );
    const child = page.frame({ url: /role=child/ });
    if (!child) {
      throw new Error("the parent page has no child frame");
    }
    await untilLoaded(child);

    // The two documents must run the builds that the test names, or it proves nothing.
    const versions = await Promise.all(
      [page.mainFrame(), child].map((frame) =>
        frame.evaluate(async () => (await window.e2e.uiobs.getHealth()).sdkVersion),
      ),
    );
    const [parentVersion, childVersion] = versions;
    expect(pair.parent === "release" ? parentVersion : childVersion).toBe(RELEASE_VERSION);
    expect(pair.parent === "release" ? childVersion : parentVersion).not.toBe(RELEASE_VERSION);

    await child.evaluate(
      ({ endpoint, parentOrigin, crossOrigin }) => {
        window.e2e.uiobs.configure({
          endpoint,
          serviceName: "e2e-child",
          // A cross-origin child accepts only the origins it trusts. A same-origin one needs none.
          ...(crossOrigin ? { bus: { trustedOrigins: [parentOrigin] } } : {}),
          onDiagnostic: window.e2e.onDiagnostic,
        });
      },
      { endpoint: LOGS_ENDPOINT, parentOrigin: PAGE_ORIGIN, crossOrigin: pair.crossOrigin },
    );

    // A same-origin child calls its parent directly, and a cross-origin one uses postMessage.
    await expect.poll(() => resolvedRoles(child)).toEqual(["forwarder"]);
    expect(await resolvedLinks(child)).toEqual([pair.crossOrigin ? "parent" : "direct"]);

    await child.evaluate(() => {
      window.e2e.uiobs
        .getLogger("child.payments")
        .info("versioned card charged", { orderId: "ORD-41", cardNumber: "4111111111111111" });
    });
    await flushFrames([child, page.mainFrame()]);

    await expect.poll(() => readLogs("versioned card charged")).toHaveLength(1);
    const [log] = await readLogs("versioned card charged");

    // The record keeps the child's identity, and the parent's redact is the last gate.
    expect(log.scope).toBe("child.payments");
    expect(log.resource["service.name"]).toBe("e2e-child");
    expect(log.attributes.orderId).toBe("ORD-41");
    expect(log.attributes).not.toHaveProperty("cardNumber");
    expect(posters.length).toBeGreaterThan(0);
    expect(posters.every((frame) => frame === page.mainFrame())).toBe(true);
  });
}

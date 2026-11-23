// e2e/fixtures/frames.ts
//
// Helpers for the specs that nest frames: register a frame in its host, load a page or a srcdoc
// into it, and read which frame posted a batch and which bus role a frame resolved to.

import type { Frame, Page } from "@playwright/test";
import { LOGS_ENDPOINT } from "./ingest";

/** What a child frame loads: a page at a URL, or the markup of a srcdoc frame. */
export type ChildSource = { url: string } | { srcdoc: string };

/**
 * Records which frame posts each log batch. The server can't tell a same-origin parent from
 * its child, so the browser's own request list is the evidence.
 */
export function watchPosters(page: Page): Frame[] {
  const posters: Frame[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().startsWith(LOGS_ENDPOINT)) {
      posters.push(request.frame());
    }
  });

  return posters;
}

/**
 * Registers an empty frame in the host, then loads the child into it. The host registers the
 * frame before the child starts, because a child that starts first finds no owner and posts
 * its own records.
 * @param host The frame whose library owns the registration.
 * @param source The child's URL or srcdoc markup.
 * @param origin The origin that the host expects the child to run on.
 */
export async function loadChildFrame(
  host: Frame,
  source: ChildSource,
  origin: string,
): Promise<void> {
  await host.evaluate(
    async ({ child, expected }) => {
      const { flush, registerFrame } = window.e2e.uiobs;

      const frame = document.createElement("iframe");
      document.body.append(frame);
      registerFrame(frame, { origin: expected, permissions: ["records"] });
      // flush() waits for the bus module, so registerFrame() takes effect before the child loads.
      await flush();

      const loaded = new Promise((resolve) => {
        frame.addEventListener("load", resolve, { once: true });
      });
      if ("url" in child) {
        frame.src = child.url;
      } else {
        frame.srcdoc = child.srcdoc;
      }
      await loaded;
    },
    { child: source, expected: origin },
  );
}

/**
 * Flushes the frames in the given order. A child comes before its parent, so a record that the
 * child holds reaches the parent's flush, and a document that wrongly holds a copy has posted
 * it when the test looks.
 */
export async function flushFrames(frames: Frame[]): Promise<void> {
  for (const frame of frames) {
    await frame.evaluate(() => window.e2e.uiobs.flush());
  }
}

/** Returns each role the frame's bus resolved to, from its `bus.role_resolved` diagnostics. */
export function resolvedRoles(frame: Frame): Promise<unknown[]> {
  return frame.evaluate(() =>
    window.e2e.diagnostics
      .filter((event) => event.code === "bus.role_resolved")
      .map((event) => event.detail?.role),
  );
}

/** Returns the link that each role resolution of the frame used, such as "direct" or "parent". */
export function resolvedLinks(frame: Frame): Promise<unknown[]> {
  return frame.evaluate(() =>
    window.e2e.diagnostics
      .filter((event) => event.code === "bus.role_resolved")
      .map((event) => event.detail?.via),
  );
}

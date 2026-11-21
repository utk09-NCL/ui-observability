import { describe, expect, it, vi } from "vitest";
import { revokeAtPageHide, watchPageRestore } from "./page-lifecycle";

/** Sends a pageshow event. happy-dom has no PageTransitionEvent, so the spec adds the field. */
function pageShow(persisted: boolean): void {
  dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
}

describe("revokeAtPageHide", () => {
  it("calls revoke when the page hides, also for a page that goes to the bfcache", () => {
    const revoke = vi.fn();
    const stop = revokeAtPageHide(revoke);

    dispatchEvent(new Event("pagehide"));

    expect(revoke).toHaveBeenCalledTimes(1);
    stop();
  });

  it("calls revoke again at the next hide, because a restored page can hide twice", () => {
    const revoke = vi.fn();
    const stop = revokeAtPageHide(revoke);

    dispatchEvent(new Event("pagehide"));
    dispatchEvent(new Event("pagehide"));

    expect(revoke).toHaveBeenCalledTimes(2);
    stop();
  });

  it("listens no more after stop", () => {
    const revoke = vi.fn();
    revokeAtPageHide(revoke)();

    dispatchEvent(new Event("pagehide"));

    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("watchPageRestore", () => {
  it("reports a page that the browser restores from its cache", () => {
    const restored = vi.fn();
    const stop = watchPageRestore(restored);

    pageShow(true);

    expect(restored).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores the first show of a page", () => {
    const restored = vi.fn();
    const stop = watchPageRestore(restored);

    pageShow(false);

    expect(restored).not.toHaveBeenCalled();
    stop();
  });

  it("listens no more after stop", () => {
    const restored = vi.fn();
    watchPageRestore(restored)();

    pageShow(true);

    expect(restored).not.toHaveBeenCalled();
  });
});

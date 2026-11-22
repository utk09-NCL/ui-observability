// tests/observe-window-copies.test.ts
//
// Two copies of one library version on a page share one runtime through a global key. These
// specs load each copy with vi.resetModules(), so each copy has its own modules and its own
// module state. A reset changes every later dynamic import in its file, so these specs have a
// file of their own. Each spec loads the first copy and starts its runtime before it loads the
// second copy, because the click capture is a lazy chunk of the copy that was current at that
// moment.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservabilityRuntime } from "../src/core/runtime";
import type * as Library from "../src/index";
import { leftOn, openPopout, type Popout } from "./window-fakes";

const base = {
  endpoint: null,
  serviceName: "copies",
  storage: { backend: "memory" },
  identity: "memory",
  capture: { errors: false, rejections: false, interactions: true },
  bus: { mode: "off" },
} as const;

describe("observeWindow from a second copy of the library", () => {
  const stops: (() => void)[] = [];
  const popouts: Popout[] = [];

  /**
   * Returns the runtime on the global key, which the first copy started.
   * @returns The runtime.
   */
  const runtime = (): ObservabilityRuntime => {
    const current = ObservabilityRuntime.current();
    if (!current) {
      throw new Error("no runtime configured");
    }
    return current;
  };

  /** Waits until the shared runtime has installed the click capture. */
  const installed = (): Promise<void> =>
    vi.waitFor(() => {
      const names = runtime()["captures"].map((capture: { name: string }) => capture.name);
      expect(names).toContain("interactions");
    });

  /** Returns the click breadcrumbs of the shared runtime. */
  const clicks = () =>
    runtime()
      .breadcrumbs.snapshot()
      .filter(({ category }) => category === "click");

  /** Clicks an element with an event that bubbles. */
  const click = (element: Element): void => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };

  /**
   * Loads a copy of the library with its own modules and its own module state.
   * @returns The copy's public entry point.
   */
  const loadCopy = async (): Promise<typeof Library> => {
    vi.resetModules();
    return import("../src/index");
  };

  /**
   * Opens a popout for the spec.
   * @returns The popout, which afterEach closes.
   */
  const open = (): Popout => {
    const popout = openPopout();
    popouts.push(popout);
    return popout;
  };

  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop();
    }
    for (const popout of popouts.splice(0)) {
      popout.close();
    }
    // A fix may keep the window list on the global object. The runtime keys stay, because the
    // setup file shuts that runtime down.
    for (const key of Object.getOwnPropertySymbols(globalThis)) {
      if (/window/i.test(key.description ?? "")) {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("attaches the window to the capture of the shared runtime", async () => {
    const first = await loadCopy();
    first.configure(base);
    await installed();
    const popout = open();
    const second = await loadCopy();

    stops.push(second.observeWindow(popout.win));
    click(popout.buy);

    expect(clicks()).toHaveLength(1);
    expect(leftOn(popout, "click")).toBe(1);
  });

  it("detaches the window when the second copy runs the stop function", async () => {
    const first = await loadCopy();
    first.configure(base);
    await installed();
    const popout = open();
    const second = await loadCopy();
    const stop = second.observeWindow(popout.win);
    click(popout.buy);

    stop();
    click(popout.buy);

    expect(clicks()).toHaveLength(1);
    expect(leftOn(popout, "click")).toBe(0);
  });

  it("keeps one listener when both copies observe the same window", async () => {
    const first = await loadCopy();
    first.configure(base);
    await installed();
    const popout = open();
    stops.push(first.observeWindow(popout.win));
    const second = await loadCopy();

    stops.push(second.observeWindow(popout.win));
    click(popout.buy);

    expect(clicks()).toHaveLength(1);
    expect(leftOn(popout, "click")).toBe(1);
  });
});

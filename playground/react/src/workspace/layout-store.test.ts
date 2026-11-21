import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedDockview } from "dockview-react";
import {
  createLayoutSaver,
  type LayoutApi,
  layoutKey,
  readLayout,
  removeLayout,
  removeUserLayouts,
  restoreLayout,
  writeLayout,
} from "./layout-store";

// The shape that dockview needs before it reads a layout. The spec never builds a real dockview.
const LAYOUT = {
  grid: { root: { type: "leaf", data: {} }, height: 600, width: 800, orientation: "HORIZONTAL" },
  panels: { prices: { id: "prices", contentComponent: "prices" } },
} as unknown as SerializedDockview;

function blockedStorage(): Storage {
  const fail = (): never => {
    throw new Error("blocked");
  };

  return {
    getItem: fail,
    setItem: fail,
    removeItem: fail,
    length: 1,
    key: fail,
  } as unknown as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("layout key", () => {
  it("is different for each user and each tenant", () => {
    const keys = new Set([
      layoutKey("trader1", "tenant-a"),
      layoutKey("trader1", "tenant-b"),
      layoutKey("trader2", "tenant-a"),
    ]);

    expect(keys.size).toBe(3);
  });

  it("can't mix two users whose names hold a separator", () => {
    expect(layoutKey("a:b", "c")).not.toBe(layoutKey("a", "b:c"));
  });
});

describe("readLayout and writeLayout", () => {
  it("reads nothing before the first save", () => {
    expect(readLayout("trader1", "tenant-a")).toEqual({ status: "none" });
  });

  it("gives back the layout that was saved for the same user and tenant", () => {
    writeLayout("trader1", "tenant-a", LAYOUT);

    expect(readLayout("trader1", "tenant-a")).toEqual({ status: "ok", layout: LAYOUT });
  });

  it("keeps the layouts of two tenants apart", () => {
    writeLayout("trader1", "tenant-a", LAYOUT);

    expect(readLayout("trader1", "tenant-b")).toEqual({ status: "none" });
  });

  it("removes a saved layout", () => {
    writeLayout("trader1", "tenant-a", LAYOUT);
    removeLayout("trader1", "tenant-a");

    expect(readLayout("trader1", "tenant-a")).toEqual({ status: "none" });
  });

  it("removes the layouts of one user in every tenant, and no layout of another user", () => {
    writeLayout("trader1", "tenant-a", LAYOUT);
    writeLayout("trader1", "tenant-b", LAYOUT);
    writeLayout("trader2", "tenant-a", LAYOUT);

    removeUserLayouts("trader1");

    expect(readLayout("trader1", "tenant-a")).toEqual({ status: "none" });
    expect(readLayout("trader1", "tenant-b")).toEqual({ status: "none" });
    expect(readLayout("trader2", "tenant-a").status).toBe("ok");
  });

  it("keeps the layouts of a user whose name starts with the removed name", () => {
    writeLayout("trader1", "tenant-a", LAYOUT);
    writeLayout("trader10", "tenant-a", LAYOUT);

    removeUserLayouts("trader1");

    expect(readLayout("trader10", "tenant-a").status).toBe("ok");
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["a value that is not an object", "42"],
    ["another format version", JSON.stringify({ version: 99, layout: LAYOUT })],
    ["a layout without a grid", JSON.stringify({ version: 1, layout: { panels: {} } })],
    ["a layout without panels", JSON.stringify({ version: 1, layout: { grid: {} } })],
    ["a layout that is an array", JSON.stringify({ version: 1, layout: [] })],
  ])("reports %s as corrupt, and does not throw", (_name, text) => {
    localStorage.setItem(layoutKey("trader1", "tenant-a"), text);

    expect(readLayout("trader1", "tenant-a").status).toBe("corrupt");
  });

  it("works when the storage throws", () => {
    // A spy on Storage.prototype does not reach the localStorage of happy-dom, so the spec
    // replaces the global.
    vi.stubGlobal("localStorage", blockedStorage());

    expect(readLayout("trader1", "tenant-a").status).toBe("corrupt");
    expect(() => {
      writeLayout("trader1", "tenant-a", LAYOUT);
    }).not.toThrow();
    expect(() => {
      removeLayout("trader1", "tenant-a");
      removeUserLayouts("trader1");
    }).not.toThrow();
  });
});

describe("restoreLayout", () => {
  function fakeApi(
    fromJSON: LayoutApi["fromJSON"] = () => undefined,
  ): LayoutApi & { calls: string[] } {
    const calls: string[] = [];

    return {
      calls,
      fromJSON: (data) => {
        calls.push("fromJSON");
        fromJSON(data);
      },
      clear: () => {
        calls.push("clear");
      },
    };
  }

  it("opens the saved layout and adds no default panel", () => {
    const api = fakeApi();
    const addDefaults = vi.fn();
    const report = vi.fn();

    const outcome = restoreLayout(api, { status: "ok", layout: LAYOUT }, addDefaults, report);

    expect(outcome).toBe("restored");
    expect(api.calls).toEqual(["fromJSON"]);
    expect(addDefaults).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  describe("a saved popout group", () => {
    // dockview opens each saved popout window again. A frame panel there loads again in a new
    // browsing context, and its runtime finds no owner. So the restore removes frame panels from
    // each popout group first.
    function panel(id: string): unknown {
      return { id, contentComponent: id, title: id };
    }

    function popoutLayout(popoutGroups: unknown[], panelIds: string[]): SerializedDockview {
      return {
        ...LAYOUT,
        panels: Object.fromEntries(panelIds.map((id) => [id, panel(id)])),
        popoutGroups,
      } as unknown as SerializedDockview;
    }

    function restored(layout: SerializedDockview): SerializedDockview {
      const given: SerializedDockview[] = [];
      restoreLayout(
        fakeApi((data) => {
          given.push(data);
        }),
        { status: "ok", layout },
        vi.fn(),
        vi.fn(),
      );

      return given[0];
    }

    it("loses its frame panels and keeps the other panels of the group", () => {
      const layout = popoutLayout(
        [
          {
            data: { id: "g1", views: ["research", "prices"], activeView: "research" },
            position: null,
          },
        ],
        ["research", "prices"],
      );

      const given = restored(layout);

      expect(given.popoutGroups).toEqual([
        { data: { id: "g1", views: ["prices"], activeView: "prices" }, position: null },
      ]);
      expect(Object.keys(given.panels)).toEqual(["prices"]);
    });

    it("keeps the active tab when it is not a frame panel", () => {
      const layout = popoutLayout(
        [
          {
            data: { id: "g1", views: ["prices", "partner", "blotter"], activeView: "blotter" },
            position: null,
          },
        ],
        ["prices", "partner", "blotter"],
      );

      const given = restored(layout);

      expect(given.popoutGroups?.[0].data).toEqual({
        id: "g1",
        views: ["prices", "blotter"],
        activeView: "blotter",
      });
    });

    it("drops a group that holds only frame panels", () => {
      const layout = popoutLayout(
        [{ data: { id: "g1", views: ["untrusted"], activeView: "untrusted" }, position: null }],
        ["untrusted"],
      );

      const given = restored(layout);

      expect(given.popoutGroups).toBeUndefined();
      expect(given.panels).toEqual({});
    });

    it("drops a popout window with several groups when one of them holds a frame panel", () => {
      const layout = popoutLayout(
        [
          {
            grid: {
              root: {
                type: "branch",
                data: [
                  { type: "leaf", data: { id: "g1", views: ["prices"] } },
                  { type: "leaf", data: { id: "g2", views: ["research"] } },
                ],
              },
              height: 400,
              width: 600,
              orientation: "HORIZONTAL",
            },
            position: null,
          },
        ],
        ["prices", "research"],
      );

      const given = restored(layout);

      expect(given.popoutGroups).toBeUndefined();
      expect(given.panels).toEqual({});
    });

    it("keeps a popout window with several groups and no frame panel", () => {
      const popout = {
        grid: {
          root: { type: "leaf", data: { id: "g1", views: ["prices"] } },
          height: 400,
          width: 600,
          orientation: "HORIZONTAL",
        },
        position: null,
      };
      const layout = popoutLayout([popout], ["prices"]);

      expect(restored(layout).popoutGroups).toEqual([popout]);
    });

    it("keeps the other popout groups in their order", () => {
      const keep = { data: { id: "g1", views: ["prices"], activeView: "prices" }, position: null };
      const drop = { data: { id: "g2", views: ["research"] }, position: null };
      const layout = popoutLayout([keep, drop], ["prices", "research"]);

      expect(restored(layout).popoutGroups).toEqual([keep]);
    });

    it("gives dockview the same layout when no popout group holds a frame panel", () => {
      const layout = popoutLayout(
        [{ data: { id: "g1", views: ["prices"], activeView: "prices" }, position: null }],
        ["prices"],
      );

      expect(restored(layout)).toBe(layout);
    });

    it("gives dockview the same layout when there is no popout group", () => {
      expect(restored(LAYOUT)).toBe(LAYOUT);
    });

    it("doesn't change the saved object", () => {
      const layout = popoutLayout(
        [
          {
            data: { id: "g1", views: ["research", "prices"], activeView: "research" },
            position: null,
          },
        ],
        ["research", "prices"],
      );
      const before = JSON.stringify(layout);

      restored(layout);

      expect(JSON.stringify(layout)).toBe(before);
    });

    it("leaves a frame panel in the grid and in a floating group", () => {
      const layout = {
        ...popoutLayout([], ["research"]),
        floatingGroups: [{ data: { id: "f1", views: ["research"] }, position: {} }],
      } as unknown as SerializedDockview;

      const given = restored(layout);

      expect(Object.keys(given.panels)).toEqual(["research"]);
      expect(given.floatingGroups).toHaveLength(1);
    });
  });

  it("opens the default layout for a user who has none, and reports nothing", () => {
    const api = fakeApi();
    const addDefaults = vi.fn();
    const report = vi.fn();

    const outcome = restoreLayout(api, { status: "none" }, addDefaults, report);

    expect(outcome).toBe("default");
    expect(addDefaults).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("falls back to the default layout for a corrupt saved layout, and says why", () => {
    const api = fakeApi();
    const addDefaults = vi.fn();
    const report = vi.fn();

    const outcome = restoreLayout(
      api,
      { status: "corrupt", reason: "The saved text is not JSON." },
      addDefaults,
      report,
    );

    expect(outcome).toBe("fallback");
    expect(report).toHaveBeenCalledWith("The saved text is not JSON.");
    expect(addDefaults).toHaveBeenCalledTimes(1);
  });

  it("clears dockview and opens the default layout when fromJSON throws", () => {
    const api = fakeApi(() => {
      throw new Error("Cannot find component 'chart'");
    });
    const addDefaults = vi.fn();
    const report = vi.fn();

    const outcome = restoreLayout(api, { status: "ok", layout: LAYOUT }, addDefaults, report);

    expect(outcome).toBe("fallback");
    // clear() comes after the failed fromJSON(), because that call can leave groups behind.
    expect(api.calls).toEqual(["fromJSON", "clear"]);
    expect(report).toHaveBeenCalledWith("Cannot find component 'chart'");
    expect(addDefaults).toHaveBeenCalledTimes(1);
  });

  it("reports a thrown value that is not an Error with a fixed text", () => {
    const api = fakeApi(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "refused";
    });
    const report = vi.fn();

    restoreLayout(api, { status: "ok", layout: LAYOUT }, vi.fn(), report);

    expect(report).toHaveBeenCalledWith("dockview refused the saved layout.");
  });
});

describe("layout saver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes once after a burst of changes", () => {
    const write = vi.fn();
    const saver = createLayoutSaver(() => LAYOUT, write);

    for (let change = 0; change < 20; change += 1) {
      saver.schedule();
      vi.advanceTimersByTime(50);
    }
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(LAYOUT);
  });

  it("writes at once on flush, and the timer does not write a second time", () => {
    const write = vi.fn();
    const saver = createLayoutSaver(() => LAYOUT, write);

    saver.schedule();
    saver.flush();
    vi.advanceTimersByTime(1000);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes on flush when no change is waiting", () => {
    const write = vi.fn();
    const saver = createLayoutSaver(() => LAYOUT, write);

    saver.flush();

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes nothing after dispose, also for a change that was waiting", () => {
    const write = vi.fn();
    const saver = createLayoutSaver(() => LAYOUT, write);

    saver.schedule();
    saver.dispose();
    saver.schedule();
    saver.flush();
    vi.advanceTimersByTime(1000);

    expect(write).not.toHaveBeenCalled();
  });
});

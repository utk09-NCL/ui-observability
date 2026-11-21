import { describe, expect, it, vi } from "vitest";
import type { DockviewWillDropEvent } from "dockview-react";
import {
  blockFrameDrop,
  FRAME_PANELS,
  holdsFramePanel,
  isFramePanel,
  movesFrameIntoPopout,
} from "./frame-panels";

const grid = { api: { location: { type: "grid" } } };
const popout = { api: { location: { type: "popout" } } };

describe("frame panels", () => {
  it("names the three panels that hold an iframe", () => {
    expect([...FRAME_PANELS].sort()).toEqual(["partner", "research", "untrusted"]);
  });

  it.each(FRAME_PANELS)("knows %s as a frame panel", (id) => {
    expect(isFramePanel(id)).toBe(true);
  });

  it.each([["prices"], ["support"], [""], [undefined]])(
    "does not know %j as a frame panel",
    (id) => {
      expect(isFramePanel(id)).toBe(false);
    },
  );

  it("finds a frame panel among the panels of a group", () => {
    expect(holdsFramePanel([{ id: "positions" }, { id: "research" }])).toBe(true);
    expect(holdsFramePanel([{ id: "positions" }, { id: "blotter" }])).toBe(false);
    expect(holdsFramePanel([])).toBe(false);
  });
});

describe("movesFrameIntoPopout", () => {
  it("blocks a frame panel that is dropped in a group of a popout window", () => {
    expect(
      movesFrameIntoPopout({
        targetGroup: popout,
        overPopoutDocument: false,
        dragged: [{ id: "research" }],
      }),
    ).toBe(true);
  });

  it("blocks a drop at the edge of a popout window, where no group is under the pointer", () => {
    expect(
      movesFrameIntoPopout({
        targetGroup: undefined,
        overPopoutDocument: true,
        dragged: [{ id: "partner" }],
      }),
    ).toBe(true);
  });

  it("blocks a group that holds a frame panel next to other panels", () => {
    expect(
      movesFrameIntoPopout({
        targetGroup: popout,
        overPopoutDocument: true,
        dragged: [{ id: "positions" }, { id: "untrusted" }],
      }),
    ).toBe(true);
  });

  it("lets a frame panel move inside the grid", () => {
    expect(
      movesFrameIntoPopout({
        targetGroup: grid,
        overPopoutDocument: false,
        dragged: [{ id: "research" }],
      }),
    ).toBe(false);
  });

  it("lets a panel without a frame move into a popout window", () => {
    expect(
      movesFrameIntoPopout({
        targetGroup: popout,
        overPopoutDocument: true,
        dragged: [{ id: "positions" }],
      }),
    ).toBe(false);
  });

  it("lets a drop with nothing dragged go on", () => {
    expect(
      movesFrameIntoPopout({ targetGroup: popout, overPopoutDocument: true, dragged: [] }),
    ).toBe(false);
  });
});

describe("blockFrameDrop", () => {
  interface Drop {
    data?: { panelId?: string; groupId?: string };
    group?: unknown;
    target?: EventTarget | null;
  }

  /** A drop event with the parts that blockFrameDrop() reads. */
  function dropEvent(drop: Drop): { event: DockviewWillDropEvent; preventDefault: () => void } {
    const preventDefault = vi.fn();
    const event = {
      getData: () => drop.data,
      group: drop.group,
      nativeEvent: { target: drop.target ?? document.body },
      preventDefault,
      api: {
        getPanel: (id: string) => (id === "unknown" ? undefined : { id }),
        getGroup: (id: string) =>
          id === "frames" ? { panels: [{ id: "positions" }, { id: "research" }] } : undefined,
      },
    } as unknown as DockviewWillDropEvent;

    return { event, preventDefault };
  }

  it("refuses the drop of a frame tab into a group of a popout window", () => {
    const { event, preventDefault } = dropEvent({ data: { panelId: "research" }, group: popout });

    blockFrameDrop(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("allows the drop of a tab without a frame into a popout window", () => {
    const { event, preventDefault } = dropEvent({ data: { panelId: "ticket" }, group: popout });

    blockFrameDrop(event);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("allows the drop of a frame tab into a group of the grid", () => {
    const { event, preventDefault } = dropEvent({ data: { panelId: "research" }, group: grid });

    blockFrameDrop(event);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("refuses the drop of a frame tab on a popout window edge, where no group is hit", () => {
    // The pointer is over the document of the popout window, which is not the page.
    const popoutDocument = document.implementation.createHTMLDocument("popout");
    const { event, preventDefault } = dropEvent({
      data: { panelId: "partner" },
      group: undefined,
      target: popoutDocument.body,
    });

    blockFrameDrop(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("refuses the drop of a whole group that holds a frame panel", () => {
    const { event, preventDefault } = dropEvent({ data: { groupId: "frames" }, group: popout });

    blockFrameDrop(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("allows a drop that carries no data, for example a file from the desktop", () => {
    const { event, preventDefault } = dropEvent({ data: undefined, group: popout });

    blockFrameDrop(event);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("allows a drop of a panel that dockview no longer knows", () => {
    const { event, preventDefault } = dropEvent({ data: { panelId: "unknown" }, group: popout });

    blockFrameDrop(event);

    expect(preventDefault).not.toHaveBeenCalled();
  });
});

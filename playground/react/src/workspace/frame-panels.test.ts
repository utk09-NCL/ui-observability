import { describe, expect, it } from "vitest";
import { FRAME_PANELS, holdsFramePanel, isFramePanel, movesFrameIntoPopout } from "./frame-panels";

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

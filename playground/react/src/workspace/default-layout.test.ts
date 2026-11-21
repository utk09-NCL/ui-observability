import { describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import { openPanel } from "./default-layout";

/** A fake of the part of the dockview API that openPanel() uses. */
function fakeApi(location: string | undefined): {
  api: DockviewApi;
  addPanel: ReturnType<typeof vi.fn>;
} {
  const addPanel = vi.fn();
  const api = {
    getPanel: () => undefined,
    addPanel,
    activeGroup: location === undefined ? undefined : { api: { location: { type: location } } },
  } as unknown as DockviewApi;

  return { api, addPanel };
}

describe("openPanel", () => {
  it("adds a frame panel at the edge of the grid when the active group is a popout window", () => {
    // A popout group is the active group while its window has focus. A frame panel in that group
    // would load again in the popout window, and its runtime would find no owner.
    const { api, addPanel } = fakeApi("popout");

    openPanel(api, "research");

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "research", position: { direction: "right" } }),
    );
  });

  it("joins the active group when the active group is in the grid", () => {
    const { api, addPanel } = fakeApi("grid");

    openPanel(api, "research");

    expect(addPanel.mock.calls[0][0]).not.toHaveProperty("position");
  });

  it("joins a floating group, which is a part of the same document", () => {
    const { api, addPanel } = fakeApi("floating");

    openPanel(api, "partner");

    expect(addPanel.mock.calls[0][0]).not.toHaveProperty("position");
  });

  it("adds a panel without a frame to the popout window that is active", () => {
    const { api, addPanel } = fakeApi("popout");

    openPanel(api, "prices");

    expect(addPanel.mock.calls[0][0]).not.toHaveProperty("position");
  });

  it("keeps the position that the caller gives, also for a frame panel", () => {
    const { api, addPanel } = fakeApi("popout");

    openPanel(api, "untrusted", { referencePanel: "prices", direction: "below" });

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ position: { referencePanel: "prices", direction: "below" } }),
    );
  });

  it("works when no group is active, for example in an empty layout", () => {
    const { api, addPanel } = fakeApi(undefined);

    openPanel(api, "research");

    expect(addPanel.mock.calls[0][0]).not.toHaveProperty("position");
  });

  it("shows a panel that is open and adds nothing", () => {
    const setActive = vi.fn();
    const addPanel = vi.fn();
    const api = {
      getPanel: () => ({ api: { setActive } }),
      addPanel,
    } as unknown as DockviewApi;

    openPanel(api, "research");

    expect(setActive).toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("gives a frame panel the renderer always", () => {
    const { api, addPanel } = fakeApi("grid");

    openPanel(api, "research");

    expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ renderer: "always" }));
  });
});

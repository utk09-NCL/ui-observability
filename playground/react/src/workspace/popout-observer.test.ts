import { describe, expect, it, vi } from "vitest";
import { observeWindow } from "@utk09/ui-observability";
import type * as Library from "@utk09/ui-observability";
import { observePopouts, type PopoutSource } from "./popout-observer";

// The real function would add click listeners to a fake window. The spec checks which windows the
// hookup passes and when it calls their stop functions.
vi.mock("@utk09/ui-observability", async (importOriginal) => ({
  ...(await importOriginal<typeof Library>()),
  observeWindow: vi.fn(),
}));

interface Entry {
  window: Window | null;
}

/** A dockview stand-in that lets a spec open and close popouts. */
function fakeDock(open: Entry[] = []): {
  dock: PopoutSource;
  add: (entry: Entry) => void;
  willClose: (entry: Entry) => void;
  listeners: () => number;
} {
  const adds = new Set<(entry: Entry) => void>();
  const closes = new Set<(entry: Entry) => void>();
  const subscribe = (set: Set<(entry: Entry) => void>) => (listener: (entry: Entry) => void) => {
    set.add(listener);

    return {
      dispose: () => {
        set.delete(listener);
      },
    };
  };

  return {
    dock: {
      getPopouts: () => open,
      onDidAddPopoutGroup: subscribe(adds),
      onWillClosePopoutWindow: subscribe(closes),
    },
    add: (entry) => {
      open.push(entry);
      adds.forEach((listener) => {
        listener(entry);
      });
    },
    willClose: (entry) => {
      closes.forEach((listener) => {
        listener(entry);
      });
      open.splice(open.indexOf(entry), 1);
    },
    listeners: () => adds.size + closes.size,
  };
}

function popoutWindow(): Entry {
  return { window: {} as Window };
}

/** Makes observeWindow() return a stop function that the spec can inspect. */
function stopsOf(): ReturnType<typeof vi.fn>[] {
  const stops: ReturnType<typeof vi.fn>[] = [];
  vi.mocked(observeWindow).mockImplementation(() => {
    const stop = vi.fn();
    stops.push(stop);

    return stop;
  });

  return stops;
}

describe("observePopouts", () => {
  it("observes a popout that opens after the hookup", () => {
    const stops = stopsOf();
    const { dock, add } = fakeDock();
    observePopouts(dock);
    const popout = popoutWindow();

    add(popout);

    expect(observeWindow).toHaveBeenCalledExactlyOnceWith(popout.window);
    expect(stops).toHaveLength(1);
  });

  it("observes a popout that a saved layout opened before the hookup", () => {
    stopsOf();
    const popout = popoutWindow();
    const { dock } = fakeDock([popout]);

    observePopouts(dock);

    expect(observeWindow).toHaveBeenCalledExactlyOnceWith(popout.window);
  });

  it("observes a window one time when dockview reports it again", () => {
    stopsOf();
    const popout = popoutWindow();
    const { dock, add } = fakeDock([popout]);
    observePopouts(dock);

    add(popout);

    expect(observeWindow).toHaveBeenCalledTimes(1);
  });

  it("stops the observation when dockview lets go of the window", () => {
    const stops = stopsOf();
    const { dock, add, willClose } = fakeDock();
    observePopouts(dock);
    const popout = popoutWindow();
    add(popout);

    willClose(popout);

    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  it("observes a window again after it left and came back", () => {
    const stops = stopsOf();
    const { dock, add, willClose } = fakeDock();
    observePopouts(dock);
    const popout = popoutWindow();
    add(popout);
    willClose(popout);

    add(popout);

    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
  });

  it("keeps the other popouts while one closes", () => {
    const stops = stopsOf();
    const { dock, add, willClose } = fakeDock();
    observePopouts(dock);
    const first = popoutWindow();
    const second = popoutWindow();
    add(first);
    add(second);

    willClose(first);

    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
  });

  it("skips a popout whose window handle is null", () => {
    stopsOf();
    const { dock, add, willClose } = fakeDock();
    observePopouts(dock);
    const closing: Entry = { window: null };

    add(closing);
    willClose(closing);

    expect(observeWindow).not.toHaveBeenCalled();
  });

  it("ignores the close of a window that it never observed", () => {
    const stops = stopsOf();
    const { dock, willClose } = fakeDock();
    observePopouts(dock);
    const open = popoutWindow();

    willClose({ window: open.window });

    expect(stops).toHaveLength(0);
  });

  it("stops every window and removes the listeners at the cleanup", () => {
    const stops = stopsOf();
    const { dock, add, listeners } = fakeDock();
    const cleanup = observePopouts(dock);
    add(popoutWindow());
    add(popoutWindow());

    cleanup();

    expect(stops.map((stop) => stop.mock.calls.length)).toEqual([1, 1]);
    expect(listeners()).toBe(0);
  });

  it("observes the open windows again after a StrictMode cleanup and run", () => {
    const stops = stopsOf();
    const popout = popoutWindow();
    const { dock } = fakeDock([popout]);

    observePopouts(dock)();
    observePopouts(dock);

    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
  });
});

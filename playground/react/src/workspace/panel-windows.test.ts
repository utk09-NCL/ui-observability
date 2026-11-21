import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentJourney, endJourney, getJourneyToken, startJourney } from "@utk09/ui-observability";
import { READY_TYPE, SESSION_TYPE } from "../panel-window/protocol";
import { closePanelWindows, openPanelWindow } from "./panel-windows";

const SESSION = { user: "trader1", tenant: "tenant-a" };

interface FakeWindow {
  closed: boolean;
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let child: FakeWindow;
const open = vi.fn();

/** Dispatches the message that a window sends. The event has the origin and the source. */
function sendFrom(source: unknown, data: unknown, origin = location.origin): void {
  const event = new MessageEvent("message", { data, origin });
  Object.defineProperty(event, "source", { value: source });
  dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  child = { closed: false, postMessage: vi.fn(), close: vi.fn() };
  open.mockReset().mockImplementation(() => child);
  vi.stubGlobal("open", open);
});

afterEach(() => {
  closePanelWindows();
  endJourney();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("open a panel in a new window", () => {
  it("puts the panel and the journey token in the address", () => {
    expect(openPanelWindow("blotter", SESSION)).toBe(true);

    const [address, target] = open.mock.calls[0] as [string, string];
    const url = new URL(address);

    expect(target).toBe("_blank");
    expect(url.origin).toBe(location.origin);
    expect(url.pathname).toBe("/panel.html");
    expect(url.searchParams.get("panel")).toBe("blotter");
    expect(new URLSearchParams(url.hash.slice(1)).get("journey")).toBe(getJourneyToken());
    expect(url.searchParams.has("journey")).toBe(false);
  });

  it("starts a journey when none runs, so the records of the opener carry it", () => {
    expect(currentJourney()).toBeNull();

    openPanelWindow("blotter", SESSION);

    expect(currentJourney()?.name).toBe("panel-window");
  });

  it("uses the journey that runs, and does not end it when the window closes", () => {
    const running = startJourney("place-order");

    openPanelWindow("blotter", SESSION);
    child.closed = true;
    vi.advanceTimersByTime(1000);

    expect(currentJourney()?.id).toBe(running.id);
  });

  it("ends the journey that it started when the window closes", () => {
    openPanelWindow("blotter", SESSION);
    child.closed = true;
    vi.advanceTimersByTime(1000);

    expect(currentJourney()).toBeNull();
  });

  it("keeps a journey that the user started meanwhile", () => {
    openPanelWindow("blotter", SESSION);
    const other = startJourney("another-task");
    child.closed = true;
    vi.advanceTimersByTime(1000);

    expect(currentJourney()?.id).toBe(other.id);
  });

  it("returns false and ends the journey when the browser blocks the window", () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );

    expect(openPanelWindow("blotter", SESSION)).toBe(false);
    expect(currentJourney()).toBeNull();
  });

  it("closes the windows and ends the journey on closePanelWindows()", () => {
    openPanelWindow("blotter", SESSION);

    closePanelWindows();

    expect(child.close).toHaveBeenCalledTimes(1);
    expect(currentJourney()).toBeNull();
  });
});

describe("the answer to a window", () => {
  it("sends the user and the tenant to the window that asked, to this origin", () => {
    openPanelWindow("blotter", SESSION);

    sendFrom(child, { type: READY_TYPE });

    expect(child.postMessage).toHaveBeenCalledWith(
      { type: SESSION_TYPE, ...SESSION },
      location.origin,
    );
  });

  it("holds no token in the answer", () => {
    openPanelWindow("blotter", SESSION);

    sendFrom(child, { type: READY_TYPE });

    expect(JSON.stringify(child.postMessage.mock.calls[0][0])).not.toMatch(/token/i);
  });

  it.each([
    [
      "a window that this page did not open",
      () => {
        sendFrom({}, { type: READY_TYPE });
      },
    ],
    [
      "another origin",
      () => {
        sendFrom(child, { type: READY_TYPE }, "http://evil.example");
      },
    ],
    [
      "a message that is not the question",
      () => {
        sendFrom(child, { type: "other" });
      },
    ],
    [
      "a message with no source",
      () => {
        sendFrom(null, { type: READY_TYPE });
      },
    ],
  ])("does not answer %s", (_name, send) => {
    openPanelWindow("blotter", SESSION);

    send();

    expect(child.postMessage).not.toHaveBeenCalled();
  });

  it("stops answering after the window closed", () => {
    openPanelWindow("blotter", SESSION);
    child.closed = true;
    vi.advanceTimersByTime(1000);

    sendFrom(child, { type: READY_TYPE });

    expect(child.postMessage).not.toHaveBeenCalled();
  });
});

// tests/window-fakes.ts
//
// Extra windows for the observeWindow() specs. A same-origin iframe stands in for a dockview
// popout. happy-dom gives every window the same Element and Node classes, so a spec that needs
// the cross-realm failure calls foreignRealm().
import { vi } from "vitest";

/** The elements that the specs click, change and scroll. */
export interface Regions {
  /** A button whose click records the action "buy". */
  buy: Element;
  /** A live region, which the default dead click selector marks. */
  grid: Element;
  /** The span inside the live region. Its only child is a text node. */
  price: Element;
  /** A region that isn't live. */
  feed: Element;
  /** The span inside the feed. Its only child is a text node. */
  headline: Element;
}

/** The markup of every document in the specs. */
export const REGIONS = `
  <button data-observability-action="buy">Buy</button>
  <div id="grid" data-observability-live><span id="price">100</span></div>
  <div id="feed"><span id="headline">Open</span></div>`;

/**
 * Spies on the listener methods of a window. They call through, so the window still works.
 * @param win The window to spy on.
 * @returns The spies on addEventListener and removeEventListener.
 */
function spies(win: Window) {
  return {
    add: vi.spyOn(win, "addEventListener"),
    remove: vi.spyOn(win, "removeEventListener"),
  };
}

/** An extra window of the page, with its regions and the spies on its listener methods. */
export interface Popout extends Regions, ReturnType<typeof spies> {
  /** The iframe that holds the window. */
  frame: HTMLIFrameElement;
  /** The popout's window. */
  win: Window;
  /** The popout's document. */
  doc: Document;
  /** Removes the iframe, so its window is gone. */
  close: () => void;
}

/**
 * Finds the regions in a document.
 * @param doc The document that holds REGIONS.
 * @returns The region elements.
 */
export function regions(doc: Document): Regions {
  const find = (selector: string): Element => {
    const found = doc.querySelector(selector);
    if (!found) {
      throw new Error(`The document has no ${selector}.`);
    }
    return found;
  };
  return {
    buy: find("button"),
    grid: find("#grid"),
    price: find("#price"),
    feed: find("#feed"),
    headline: find("#headline"),
  };
}

/**
 * Opens a same-origin window, as a popout does. The caller closes it in afterEach.
 * @returns The window, its regions and the spies on its listener methods.
 */
export function openPopout(): Popout {
  const frame = document.createElement("iframe");
  frame.srcdoc = "<!doctype html><body></body>";
  document.body.append(frame);
  const win = frame.contentWindow;
  if (!win) {
    throw new Error("happy-dom made no window for the iframe.");
  }
  win.document.body.innerHTML = REGIONS;

  return {
    ...regions(win.document),
    ...spies(win),
    frame,
    win,
    doc: win.document,
    close: () => {
      frame.remove();
    },
  };
}

/** Normalizes the third argument of addEventListener to the capture flag. */
const capturing = (options: unknown): boolean =>
  typeof options === "boolean"
    ? options
    : (options as AddEventListenerOptions | undefined)?.capture === true;

/**
 * Counts the listeners of one type that the library added to a window and didn't remove. It
 * follows the DOM rule that a second add of the same listener and capture flag does nothing.
 * @param popout The popout, with its listener spies.
 * @param type The event type, for example "click".
 * @returns The number of listeners that are still on the window.
 */
export function leftOn(popout: Popout, type: string): number {
  const calls = [
    ...popout.add.mock.calls.map((call, index) => ({
      call,
      add: true,
      order: popout.add.mock.invocationCallOrder[index],
    })),
    ...popout.remove.mock.calls.map((call, index) => ({
      call,
      add: false,
      order: popout.remove.mock.invocationCallOrder[index],
    })),
  ].sort((a, b) => a.order - b.order);

  const left: { listener: unknown; capture: boolean }[] = [];
  for (const {
    call: [called, listener, options],
    add,
  } of calls) {
    const capture = capturing(options);
    const index = left.findIndex(
      (entry) => entry.listener === listener && entry.capture === capture,
    );
    if (called !== type) {
      continue;
    }
    if (add && index === -1) {
      left.push({ listener, capture });
    }
    if (!add && index !== -1) {
      left.splice(index, 1);
    }
  }
  return left.length;
}

/**
 * A window from another origin. Any read of it throws, as it does in a browser.
 * @returns The window.
 */
export function foreignWindow(): Window {
  return new Proxy({} as Window, {
    get() {
      throw new DOMException("Blocked a frame from another origin.", "SecurityError");
    },
  });
}

/**
 * A window that takes a listener but throws a SecurityError when code reads its document.
 * @returns The window.
 */
export function blockedDocumentWindow(): Window {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    get document(): Document {
      throw new DOMException("Blocked a frame from another origin.", "SecurityError");
    },
  } as unknown as Window;
}

/**
 * Makes every node of the page's document look like it came from another realm. A node of a
 * popout is not an instance of the page's Element or Node in a browser, and happy-dom shares
 * those classes between windows, so this replaces them for the rest of the test.
 */
export function foreignRealm(): void {
  // No node is an instance of a class that has this rule, which is what another realm looks like.
  const foreign = { [Symbol.hasInstance]: () => false };
  vi.stubGlobal("Element", foreign);
  vi.stubGlobal("Node", foreign);
}

/**
 * Passes a value that isn't a window where a Window goes, as a careless caller does.
 * @param value Any value.
 * @returns The same value, typed as a Window.
 */
export const asWindow = (value: unknown): Window => value as Window;

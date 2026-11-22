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
  /** The popout's window. */
  win: Window;
  /** The popout's document. */
  doc: Document;
  /**
   * Makes every read of the window throw a SecurityError, as a window does after it navigates
   * to another origin. The elements that the spec already holds keep working. It first waits
   * until happy-dom has finished loading the window, because that step reads the document.
   */
  block: () => Promise<void>;
  /** Closes the window. It also undoes block(), so the window can destroy itself. */
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

/** How long block() waits for happy-dom to finish loading a window, in real milliseconds. */
const LOAD_WAIT_MS = 2000;

/** The properties that a window from another origin refuses to read. */
const CROSS_ORIGIN_NAMES = [
  "document",
  "location",
  "history",
  "addEventListener",
  "removeEventListener",
] as const;

/**
 * Builds a popout around a window.
 * @param win The window.
 * @param dispose Removes the window from the page.
 * @returns The popout.
 */
function wrap(win: Window, dispose: () => void): Popout {
  win.document.body.innerHTML = REGIONS;
  const popout = { ...regions(win.document), ...spies(win) };
  // The own descriptor, so close() puts back a spy or a data property and not only a getter.
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const unblock = (): void => {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(win, name, descriptor);
      } else {
        Reflect.deleteProperty(win, name);
      }
    }
    saved.clear();
  };

  return {
    ...popout,
    win,
    doc: win.document,
    block: async () => {
      // happy-dom finishes a window with a real timer, and that step reads the document. Wait by
      // the clock, because a count of turns runs out sooner when the loop runs faster.
      const started = vi.getRealSystemTime();
      while (win.document.readyState !== "complete") {
        if (vi.getRealSystemTime() - started > LOAD_WAIT_MS) {
          throw new Error("happy-dom didn't finish loading the window.");
        }
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (saved.size > 0) {
        return;
      }
      for (const name of CROSS_ORIGIN_NAMES) {
        saved.set(name, Object.getOwnPropertyDescriptor(win, name));
        Object.defineProperty(win, name, {
          configurable: true,
          get: () => {
            throw new DOMException("Blocked a frame from another origin.", "SecurityError");
          },
        });
      }
    },
    close: () => {
      unblock();
      dispose();
    },
  };
}

/**
 * Opens a same-origin window in an iframe. Its document URL is about:srcdoc. The caller closes
 * it in afterEach.
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

  return wrap(win, () => {
    frame.remove();
  });
}

/**
 * Opens a window with window.open(), as a dockview popout does. Its document URL is the initial
 * about:blank. The caller closes it in afterEach.
 * @returns The window, its regions and the spies on its listener methods.
 */
export function openBlankPopout(): Popout {
  const win = window.open("about:blank");
  if (!win) {
    throw new Error("happy-dom made no window for window.open().");
  }

  return wrap(win, () => {
    win.close();
  });
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

/**
 * Makes a window read as closed or open. happy-dom assigns `closed` when it destroys a window,
 * so the property keeps a setter.
 * @param win The window.
 * @param closed What the window reads first.
 * @returns Function that sets what the window reads from then on.
 */
export function stubClosed(win: Window, closed: boolean): (value: boolean) => void {
  let current = closed;
  Object.defineProperty(win, "closed", {
    configurable: true,
    get: () => current,
    set: (value: boolean) => {
      current = value;
    },
  });

  return (value) => {
    current = value;
  };
}

/**
 * Replaces MutationObserver with one that sees nothing on its own and hands the callback the
 * records that a spec builds. A browser puts a replaced child in one record, and happy-dom
 * splits it in two, so a spec that needs the browser's shape builds the record itself.
 * @returns Function that calls the callback of the observer that the code built last.
 */
export function stubMutationObserver(): { deliver: (records: Partial<MutationRecord>[]) => void } {
  let callback: MutationCallback | undefined;
  class FakeObserver {
    constructor(given: MutationCallback) {
      callback = given;
    }
    observe = vi.fn();
    disconnect = vi.fn();
    takeRecords = (): MutationRecord[] => [];
  }
  vi.stubGlobal("MutationObserver", FakeObserver);

  return {
    deliver: (records) => {
      callback?.(records as MutationRecord[], new FakeObserver(() => undefined));
    },
  };
}
